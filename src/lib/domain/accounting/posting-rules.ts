import { DomainErrors, type DomainError } from '../shared/errors';
import { Money } from '../shared/money';
import { err, ok, type Result } from '../shared/result';
import type { DateOnly } from '../shared/value-objects';
import type { AccountMappingKey, AccountResolver } from './account-mapping';
import { JournalEntryDraft } from './journal-entry';

/**
 * The automatic posting engine.
 *
 * Every rule here is a pure function: business facts in, a balanced journal
 * entry out. No database, no clock, no ambient state — which is why the entire
 * accounting behaviour of the system can be tested without a database, and why
 * two identical documents always post identically.
 *
 * The invariant every rule upholds:
 *
 *   The functional-currency total is converted ONCE, and its components are
 *   derived by subtraction and allocation from that single converted figure.
 *
 * Converting each component separately and hoping the parts add up is the classic
 * way to produce an entry that is one halala out of balance on roughly one
 * invoice in three hundred. Deriving components from the whole makes that
 * arithmetically impossible.
 */

export interface PostingContext {
  readonly tenantId: string;
  readonly branchId: string;
  readonly functionalCurrency: string;
  readonly resolver: AccountResolver;
}

export interface InvoiceLineFacts {
  readonly productId: string;
  readonly categoryId?: string;
  /** quantity x unitPrice, before discount and tax, in transaction currency. */
  readonly grossAmount: Money;
  /** Line-level discount, in transaction currency. */
  readonly discount: Money;
  /** Tax computed on (gross - discount), in transaction currency. */
  readonly taxAmount: Money;
  /** Cost of goods sold, always in functional currency (cost has no FX). */
  readonly cogsAmount: Money;
  /** Services post to an expense account instead of inventory on purchases. */
  readonly isStockItem: boolean;
  readonly description?: string;
}

export interface InvoicePostingFacts {
  readonly documentId: string;
  readonly documentNumber: string;
  readonly counterpartyId: string;
  readonly date: DateOnly;
  readonly currency: string;
  /** Units of functional currency per unit of transaction currency. */
  readonly exchangeRate: string;
  readonly lines: readonly InvoiceLineFacts[];
  readonly costCenterId?: string;
  readonly projectId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Sales invoice
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recognises revenue on a sales invoice, per IFRS 15: control of the goods has
 * transferred, so revenue is recognised now — at posting, not at order entry.
 *
 *   DR  Accounts receivable          gross incl. VAT
 *   DR  Sales discount               discount given
 *       CR  Sales revenue                gross excl. VAT
 *       CR  VAT output payable          tax collected
 *
 *   DR  Cost of goods sold           cost of what left the warehouse
 *       CR  Inventory                    same
 *
 * The COGS pair is a second, independently balanced block, so a costing failure
 * can never unbalance the revenue block.
 */
export function buildSalesInvoiceJournal(
  facts: InvoicePostingFacts,
  context: PostingContext,
): Result<JournalEntryDraft, DomainError> {
  if (facts.lines.length === 0) {
    return err(DomainErrors.emptyDocument('الفاتورة', 'An invoice'));
  }

  const fx = totalsInFunctionalCurrency(facts, context.functionalCurrency);

  const resolved = resolveAll(context, [
    'AR_CONTROL',
    'VAT_OUTPUT',
    'SALES_DISCOUNT',
    'COGS',
    'INVENTORY',
  ] as const);
  if (!resolved.ok) return resolved;
  const accounts = resolved.value;

  const draft = new JournalEntryDraft({
    tenantId: context.tenantId,
    type: 'SALES',
    date: facts.date,
    descriptionAr: `فاتورة مبيعات رقم ${facts.documentNumber}`,
    descriptionEn: `Sales invoice ${facts.documentNumber}`,
    branchId: context.branchId,
    referenceType: 'DOCUMENT',
    referenceId: facts.documentId,
    currency: facts.currency,
    exchangeRate: facts.exchangeRate,
    functionalCurrency: context.functionalCurrency,
  });

  const analytics = {
    ...(facts.costCenterId !== undefined ? { costCenterId: facts.costCenterId } : {}),
    ...(facts.projectId !== undefined ? { projectId: facts.projectId } : {}),
  };

  // Receivable carries the counterparty so the AR sub-ledger reconciles to the
  // control account line by line.
  draft.debit(accounts.AR_CONTROL, fx.total, {
    ...analytics,
    counterpartyId: facts.counterpartyId,
    description: `فاتورة ${facts.documentNumber}`,
    foreignDebit: facts.lines.reduce(
      (sum, line) => sum.add(line.grossAmount).subtract(line.discount).add(line.taxAmount),
      Money.zero(facts.currency),
    ),
  });

  draft.debit(accounts.SALES_DISCOUNT, fx.discount, {
    ...analytics,
    description: `خصم على الفاتورة ${facts.documentNumber}`,
  });

  // Revenue is recognised per line so that a category-scoped revenue account
  // (electronics vs services) is honoured without a second pass.
  for (const [index, line] of facts.lines.entries()) {
    const revenueShare = fx.revenueByLine[index];
    if (revenueShare === undefined || revenueShare.isZero) continue;

    const revenueAccount = context.resolver.resolve('SALES_REVENUE', {
      branchId: context.branchId,
      ...(line.categoryId !== undefined ? { categoryId: line.categoryId } : {}),
    });
    if (!revenueAccount.ok) return revenueAccount;

    draft.credit(revenueAccount.value, revenueShare, {
      ...analytics,
      ...(line.description !== undefined ? { description: line.description } : {}),
    });
  }

  draft.credit(accounts.VAT_OUTPUT, fx.tax, {
    ...analytics,
    description: `ضريبة القيمة المضافة - ${facts.documentNumber}`,
  });

  // ── Cost of sales ─────────────────────────────────────────────────────────
  const totalCogs = Money.sum(
    facts.lines.filter((line) => line.isStockItem).map((line) => line.cogsAmount),
    context.functionalCurrency,
  );

  if (totalCogs.isPositive) {
    draft.debit(accounts.COGS, totalCogs, {
      ...analytics,
      description: `تكلفة البضاعة المباعة - ${facts.documentNumber}`,
    });
    draft.credit(accounts.INVENTORY, totalCogs, {
      ...analytics,
      description: `تكلفة البضاعة المباعة - ${facts.documentNumber}`,
    });
  }

  return ok(draft.compact());
}

// ─────────────────────────────────────────────────────────────────────────────
//  Purchase invoice
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Capitalises purchased goods at cost, per IAS 2 — trade discount reduces the
 * cost of inventory rather than being recognised as income.
 *
 *   DR  Inventory / expense        net of discount, excl. VAT
 *   DR  VAT input recoverable      tax paid
 *       CR  Accounts payable           gross incl. VAT
 */
export function buildPurchaseInvoiceJournal(
  facts: InvoicePostingFacts,
  context: PostingContext,
): Result<JournalEntryDraft, DomainError> {
  if (facts.lines.length === 0) {
    return err(DomainErrors.emptyDocument('الفاتورة', 'An invoice'));
  }

  const fx = totalsInFunctionalCurrency(facts, context.functionalCurrency);

  const resolved = resolveAll(context, [
    'AP_CONTROL',
    'VAT_INPUT',
    'INVENTORY',
    'PURCHASE_EXPENSE',
  ] as const);
  if (!resolved.ok) return resolved;
  const accounts = resolved.value;

  const draft = new JournalEntryDraft({
    tenantId: context.tenantId,
    type: 'PURCHASE',
    date: facts.date,
    descriptionAr: `فاتورة مشتريات رقم ${facts.documentNumber}`,
    descriptionEn: `Purchase invoice ${facts.documentNumber}`,
    branchId: context.branchId,
    referenceType: 'DOCUMENT',
    referenceId: facts.documentId,
    currency: facts.currency,
    exchangeRate: facts.exchangeRate,
    functionalCurrency: context.functionalCurrency,
  });

  const analytics = {
    ...(facts.costCenterId !== undefined ? { costCenterId: facts.costCenterId } : {}),
    ...(facts.projectId !== undefined ? { projectId: facts.projectId } : {}),
  };

  // The net (post-discount, pre-tax) amount lands on inventory for stock items
  // and on expense for services — the same allocation, routed per line.
  for (const [index, line] of facts.lines.entries()) {
    const netShare = fx.revenueByLine[index];
    if (netShare === undefined || netShare.isZero) continue;

    const target = line.isStockItem ? accounts.INVENTORY : accounts.PURCHASE_EXPENSE;
    draft.debit(target, netShare, {
      ...analytics,
      ...(line.description !== undefined ? { description: line.description } : {}),
    });
  }

  // A purchase discount reduces what we capitalise, so it is netted against the
  // same accounts rather than being posted to a discount-received account.
  if (fx.discount.isPositive) {
    const weights = facts.lines.map((line) => line.grossAmount.toScaled());
    const discountShares = fx.discount.allocate(weights);
    for (const [index, line] of facts.lines.entries()) {
      const share = discountShares[index];
      if (share === undefined || share.isZero) continue;
      draft.credit(
        line.isStockItem ? accounts.INVENTORY : accounts.PURCHASE_EXPENSE,
        share,
        analytics,
      );
    }
  }

  draft.debit(accounts.VAT_INPUT, fx.tax, {
    ...analytics,
    description: `ضريبة مدخلات - ${facts.documentNumber}`,
  });

  draft.credit(accounts.AP_CONTROL, fx.total, {
    ...analytics,
    counterpartyId: facts.counterpartyId,
    description: `فاتورة ${facts.documentNumber}`,
  });

  return ok(draft.compact());
}

// ─────────────────────────────────────────────────────────────────────────────
//  Credit note (sales return)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reverses a sale. Posted to a dedicated returns account rather than as negative
 * revenue, because gross sales and returns are separately disclosable.
 *
 *   DR  Sales returns          net returned
 *   DR  VAT output payable     tax reversed
 *       CR  Accounts receivable    gross returned
 *
 *   DR  Inventory              cost of goods coming back
 *       CR  Cost of goods sold     same
 */
export function buildSalesCreditNoteJournal(
  facts: InvoicePostingFacts,
  context: PostingContext,
): Result<JournalEntryDraft, DomainError> {
  if (facts.lines.length === 0) {
    return err(DomainErrors.emptyDocument('الإشعار الدائن', 'A credit note'));
  }

  const fx = totalsInFunctionalCurrency(facts, context.functionalCurrency);

  const resolved = resolveAll(context, [
    'AR_CONTROL',
    'VAT_OUTPUT',
    'SALES_RETURNS',
    'COGS',
    'INVENTORY',
  ] as const);
  if (!resolved.ok) return resolved;
  const accounts = resolved.value;

  const draft = new JournalEntryDraft({
    tenantId: context.tenantId,
    type: 'SALES',
    date: facts.date,
    descriptionAr: `إشعار دائن رقم ${facts.documentNumber}`,
    descriptionEn: `Credit note ${facts.documentNumber}`,
    branchId: context.branchId,
    referenceType: 'DOCUMENT',
    referenceId: facts.documentId,
    currency: facts.currency,
    exchangeRate: facts.exchangeRate,
    functionalCurrency: context.functionalCurrency,
  });

  // Net of the discount originally granted, so the reversal mirrors the sale.
  draft.debit(accounts.SALES_RETURNS, fx.netRevenue, {
    description: `مرتجع مبيعات - ${facts.documentNumber}`,
  });
  draft.debit(accounts.VAT_OUTPUT, fx.tax, {
    description: `عكس ضريبة القيمة المضافة - ${facts.documentNumber}`,
  });
  draft.credit(accounts.AR_CONTROL, fx.total, {
    counterpartyId: facts.counterpartyId,
    description: `إشعار دائن ${facts.documentNumber}`,
  });

  const totalCogs = Money.sum(
    facts.lines.filter((line) => line.isStockItem).map((line) => line.cogsAmount),
    context.functionalCurrency,
  );

  if (totalCogs.isPositive) {
    draft.debit(accounts.INVENTORY, totalCogs, {
      description: `إعادة البضاعة للمخزون - ${facts.documentNumber}`,
    });
    draft.credit(accounts.COGS, totalCogs, {
      description: `عكس تكلفة البضاعة المباعة - ${facts.documentNumber}`,
    });
  }

  return ok(draft.compact());
}

// ─────────────────────────────────────────────────────────────────────────────
//  Payments
// ─────────────────────────────────────────────────────────────────────────────

export interface PaymentPostingFacts {
  readonly paymentId: string;
  readonly voucherNumber: string;
  readonly type: 'RECEIPT' | 'PAYMENT';
  readonly counterpartyId: string;
  readonly date: DateOnly;
  readonly amount: Money;
  readonly currency: string;
  readonly exchangeRate: string;
  /** The cash or bank GL account this voucher moves money through. */
  readonly cashAccountId: string;
  /**
   * Realised FX difference on settlement: positive when settling in functional
   * currency yielded more than the invoice was booked at (a gain on a receipt).
   */
  readonly fxDifference?: Money;
}

/**
 * A receipt collects a receivable; a payment settles a payable.
 *
 *   Receipt:  DR Cash/bank            CR Accounts receivable
 *   Payment:  DR Accounts payable     CR Cash/bank
 *
 * When the settlement rate differs from the invoice rate, the difference is
 * recognised immediately in profit or loss, per IAS 21.
 */
export function buildPaymentJournal(
  facts: PaymentPostingFacts,
  context: PostingContext,
): Result<JournalEntryDraft, DomainError> {
  if (!facts.amount.isPositive) {
    return err(
      DomainErrors.validation(
        'مبلغ السند يجب أن يكون أكبر من صفر.',
        'The voucher amount must be greater than zero.',
        'amount',
      ),
    );
  }

  const controlKey = facts.type === 'RECEIPT' ? 'AR_CONTROL' : 'AP_CONTROL';
  const control = context.resolver.resolve(controlKey, { branchId: context.branchId });
  if (!control.ok) return control;

  const amountFunctional = convert(facts.amount, facts.exchangeRate, context.functionalCurrency);
  const fxDifference = facts.fxDifference ?? Money.zero(context.functionalCurrency);

  const draft = new JournalEntryDraft({
    tenantId: context.tenantId,
    type: 'CASH',
    date: facts.date,
    descriptionAr:
      facts.type === 'RECEIPT'
        ? `سند قبض رقم ${facts.voucherNumber}`
        : `سند صرف رقم ${facts.voucherNumber}`,
    descriptionEn:
      facts.type === 'RECEIPT'
        ? `Receipt voucher ${facts.voucherNumber}`
        : `Payment voucher ${facts.voucherNumber}`,
    branchId: context.branchId,
    referenceType: 'PAYMENT',
    referenceId: facts.paymentId,
    currency: facts.currency,
    exchangeRate: facts.exchangeRate,
    functionalCurrency: context.functionalCurrency,
  });

  if (facts.type === 'RECEIPT') {
    draft.debit(facts.cashAccountId, amountFunctional, {
      description: `تحصيل من العميل - ${facts.voucherNumber}`,
      foreignDebit: facts.amount,
    });
    // The receivable is relieved at the amount it was booked at; the difference
    // between that and what we actually received is the FX result.
    draft.credit(control.value, amountFunctional.subtract(fxDifference), {
      counterpartyId: facts.counterpartyId,
      description: `تسوية ذمم مدينة - ${facts.voucherNumber}`,
    });
  } else {
    // Mirror image of the receipt: a gain on a payable means the liability was
    // booked HIGHER than what we ended up paying, so the debit that clears it is
    // the cash paid plus the gain.
    draft.debit(control.value, amountFunctional.add(fxDifference), {
      counterpartyId: facts.counterpartyId,
      description: `تسوية ذمم دائنة - ${facts.voucherNumber}`,
    });
    draft.credit(facts.cashAccountId, amountFunctional, {
      description: `صرف للمورد - ${facts.voucherNumber}`,
      foreignCredit: facts.amount,
    });
  }

  if (!fxDifference.isZero) {
    const fxKey = fxDifference.isPositive ? 'FX_GAIN' : 'FX_LOSS';
    const fxAccount = context.resolver.resolve(fxKey, { branchId: context.branchId });
    if (!fxAccount.ok) return fxAccount;

    // A gain is a credit, a loss is a debit; `credit()` normalises the negative
    // case into a debit automatically.
    draft.credit(fxAccount.value, fxDifference, {
      description: `فروق عملة - ${facts.voucherNumber}`,
    });
  }

  return ok(draft.compact());
}

// ─────────────────────────────────────────────────────────────────────────────
//  Inventory adjustments and transfers
// ─────────────────────────────────────────────────────────────────────────────

export interface InventoryAdjustmentFacts {
  readonly movementId: string;
  readonly movementNumber: string;
  readonly date: DateOnly;
  /** Positive to write inventory up, negative to write it down. */
  readonly valueChange: Money;
  readonly reasonAr: string;
  readonly reasonEn: string;
  readonly costCenterId?: string;
}

/**
 * A stock count difference, a write-off, or a transfer valuation variance.
 *
 *   Write up:   DR Inventory              CR Inventory adjustment
 *   Write down: DR Inventory adjustment   CR Inventory
 */
export function buildInventoryAdjustmentJournal(
  facts: InventoryAdjustmentFacts,
  context: PostingContext,
): Result<JournalEntryDraft, DomainError> {
  if (facts.valueChange.isZero) {
    return err(
      DomainErrors.validation(
        'لا يوجد فرق في القيمة يستدعي قيداً محاسبياً.',
        'There is no value difference to post.',
      ),
    );
  }

  const resolved = resolveAll(context, ['INVENTORY', 'INVENTORY_ADJUSTMENT'] as const);
  if (!resolved.ok) return resolved;
  const accounts = resolved.value;

  const draft = new JournalEntryDraft({
    tenantId: context.tenantId,
    type: 'INVENTORY',
    date: facts.date,
    descriptionAr: `${facts.reasonAr} - حركة ${facts.movementNumber}`,
    descriptionEn: `${facts.reasonEn} - movement ${facts.movementNumber}`,
    branchId: context.branchId,
    referenceType: 'INVENTORY_MOVEMENT',
    referenceId: facts.movementId,
    currency: context.functionalCurrency,
    exchangeRate: '1',
    functionalCurrency: context.functionalCurrency,
  });

  const analytics =
    facts.costCenterId !== undefined ? { costCenterId: facts.costCenterId } : {};

  draft.debit(accounts.INVENTORY, facts.valueChange, analytics);
  draft.credit(accounts.INVENTORY_ADJUSTMENT, facts.valueChange, analytics);

  return ok(draft.compact());
}

// ─────────────────────────────────────────────────────────────────────────────
//  Payroll
// ─────────────────────────────────────────────────────────────────────────────

export interface PayrollPostingFacts {
  readonly payrollRunId: string;
  readonly runNumber: string;
  readonly date: DateOnly;
  readonly totalGross: Money;
  readonly totalDeductions: Money;
  readonly totalNet: Money;
}

/**
 *   DR  Salaries expense            gross
 *       CR  Employee deductions payable   GOSI, loans, penalties
 *       CR  Salaries payable              net owed to staff
 */
export function buildPayrollJournal(
  facts: PayrollPostingFacts,
  context: PostingContext,
): Result<JournalEntryDraft, DomainError> {
  if (!facts.totalGross.equals(facts.totalNet.add(facts.totalDeductions))) {
    return err(
      DomainErrors.validation(
        'إجمالي الرواتب لا يساوي صافي الرواتب زائد الاستقطاعات.',
        'Gross payroll does not equal net pay plus deductions.',
      ),
    );
  }

  const resolved = resolveAll(context, [
    'SALARIES_EXPENSE',
    'SALARIES_PAYABLE',
    'EMPLOYEE_DEDUCTIONS_PAYABLE',
  ] as const);
  if (!resolved.ok) return resolved;
  const accounts = resolved.value;

  const draft = new JournalEntryDraft({
    tenantId: context.tenantId,
    type: 'PAYROLL',
    date: facts.date,
    descriptionAr: `مسير رواتب رقم ${facts.runNumber}`,
    descriptionEn: `Payroll run ${facts.runNumber}`,
    branchId: context.branchId,
    referenceType: 'PAYROLL_RUN',
    referenceId: facts.payrollRunId,
    currency: context.functionalCurrency,
    exchangeRate: '1',
    functionalCurrency: context.functionalCurrency,
  });

  draft.debit(accounts.SALARIES_EXPENSE, facts.totalGross, { description: `رواتب ${facts.runNumber}` });
  draft.credit(accounts.EMPLOYEE_DEDUCTIONS_PAYABLE, facts.totalDeductions, {
    description: `استقطاعات ${facts.runNumber}`,
  });
  draft.credit(accounts.SALARIES_PAYABLE, facts.totalNet, { description: `صافي رواتب ${facts.runNumber}` });

  return ok(draft.compact());
}

// ─────────────────────────────────────────────────────────────────────────────
//  Depreciation
// ─────────────────────────────────────────────────────────────────────────────

export interface DepreciationPostingFacts {
  readonly assetId: string;
  readonly assetNumber: string;
  readonly date: DateOnly;
  readonly amount: Money;
  readonly expenseAccountId: string;
  readonly accumulatedAccountId: string;
  readonly costCenterId?: string;
}

/**
 *   DR  Depreciation expense
 *       CR  Accumulated depreciation
 *
 * Accounts come from the asset record rather than the mapping table, because an
 * organisation typically depreciates buildings and vehicles to different lines.
 */
export function buildDepreciationJournal(
  facts: DepreciationPostingFacts,
  context: PostingContext,
): Result<JournalEntryDraft, DomainError> {
  if (!facts.amount.isPositive) {
    return err(
      DomainErrors.validation(
        'قيمة الإهلاك يجب أن تكون أكبر من صفر.',
        'The depreciation amount must be greater than zero.',
      ),
    );
  }

  const draft = new JournalEntryDraft({
    tenantId: context.tenantId,
    type: 'DEPRECIATION',
    date: facts.date,
    descriptionAr: `إهلاك الأصل ${facts.assetNumber}`,
    descriptionEn: `Depreciation of asset ${facts.assetNumber}`,
    branchId: context.branchId,
    referenceType: 'FIXED_ASSET',
    referenceId: facts.assetId,
    currency: context.functionalCurrency,
    exchangeRate: '1',
    functionalCurrency: context.functionalCurrency,
  });

  const analytics =
    facts.costCenterId !== undefined ? { costCenterId: facts.costCenterId } : {};

  draft.debit(facts.expenseAccountId, facts.amount, analytics);
  draft.credit(facts.accumulatedAccountId, facts.amount, analytics);

  return ok(draft.compact());
}

// ─────────────────────────────────────────────────────────────────────────────
//  Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

interface FunctionalTotals {
  /** Gross including tax, converted once. Every other figure derives from it. */
  readonly total: Money;
  readonly tax: Money;
  readonly discount: Money;
  /** total - tax: revenue net of discount. */
  readonly netRevenue: Money;
  /** netRevenue + discount, allocated across lines by gross weight. */
  readonly revenueByLine: readonly Money[];
}

/**
 * Converts a document's totals into the functional currency such that the parts
 * provably sum to the whole.
 *
 * `total` is converted; `tax` is converted; `netRevenue` is the *difference*
 * rather than an independent conversion. Any rounding residue therefore lands in
 * exactly one place instead of being smeared across three, and the entry balances
 * by construction.
 */
function totalsInFunctionalCurrency(
  facts: InvoicePostingFacts,
  functionalCurrency: string,
): FunctionalTotals {
  const rate = facts.exchangeRate;

  const grossSum = Money.sum(
    facts.lines.map((line) => line.grossAmount),
    facts.currency,
  );
  const discountSum = Money.sum(
    facts.lines.map((line) => line.discount),
    facts.currency,
  );
  const taxSum = Money.sum(
    facts.lines.map((line) => line.taxAmount),
    facts.currency,
  );
  const totalSum = grossSum.subtract(discountSum).add(taxSum);

  const total = convert(totalSum, rate, functionalCurrency);
  const tax = convert(taxSum, rate, functionalCurrency);
  const discount = convert(discountSum, rate, functionalCurrency);
  const netRevenue = total.subtract(tax);

  // Gross revenue is what we credit to the revenue account; the discount is
  // debited separately, so revenue must be grossed back up.
  const grossRevenue = netRevenue.add(discount);
  const weights = facts.lines.map((line) => line.grossAmount.toScaled());
  const revenueByLine = grossRevenue.allocate(weights);

  return { total, tax, discount, netRevenue, revenueByLine };
}

/** Applies an exchange rate, rounding once to the functional currency's scale. */
function convert(amount: Money, rate: string, functionalCurrency: string): Money {
  if (amount.currency === functionalCurrency) return amount;
  return amount.convertTo(functionalCurrency, rate).round(2);
}

/**
 * Resolves several mapping keys at once, short-circuiting on the first missing one.
 *
 * Returns a keyed record rather than a tuple so that call sites read as
 * `accounts.AR_CONTROL` — self-documenting, and immune to a reordering mistake
 * that positional destructuring would happily accept.
 */
function resolveAll<const K extends readonly AccountMappingKey[]>(
  context: PostingContext,
  keys: K,
): Result<Record<K[number], string>, DomainError> {
  const resolved = {} as Record<K[number], string>;
  for (const key of keys) {
    const result = context.resolver.resolve(key, { branchId: context.branchId });
    if (!result.ok) return result;
    resolved[key as K[number]] = result.value;
  }
  return ok(resolved);
}
