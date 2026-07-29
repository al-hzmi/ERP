import { describe, expect, it } from 'vitest';
import { InMemoryAccountResolver, type AccountMappingKey } from '@/lib/domain/accounting/account-mapping';
import type { PostingContext, InvoiceLineFacts } from '@/lib/domain/accounting/posting-rules';
import {
  buildInventoryAdjustmentJournal,
  buildPayrollJournal,
  buildPaymentJournal,
  buildPurchaseInvoiceJournal,
  buildSalesCreditNoteJournal,
  buildSalesInvoiceJournal,
} from '@/lib/domain/accounting/posting-rules';
import { Money } from '@/lib/domain/shared/money';
import { unwrap } from '@/lib/domain/shared/result';
import { DateOnly } from '@/lib/domain/shared/value-objects';

/**
 * The posting engine's contract in one sentence: whatever goes in, the entry
 * that comes out balances.
 *
 * These tests hammer that with awkward numbers — prices that do not divide,
 * six-decimal exchange rates, mixed tax rates, zero-rated lines — because an
 * entry that balances only for round numbers balances only in demos.
 */

const KEYS: AccountMappingKey[] = [
  'AR_CONTROL',
  'AP_CONTROL',
  'VAT_OUTPUT',
  'VAT_INPUT',
  'SALES_REVENUE',
  'SALES_DISCOUNT',
  'SALES_RETURNS',
  'COGS',
  'INVENTORY',
  'INVENTORY_ADJUSTMENT',
  'PURCHASE_EXPENSE',
  'CASH',
  'BANK',
  'FX_GAIN',
  'FX_LOSS',
  'ROUNDING_DIFFERENCE',
  'SALARIES_EXPENSE',
  'SALARIES_PAYABLE',
  'EMPLOYEE_DEDUCTIONS_PAYABLE',
  'DEPRECIATION_EXPENSE',
  'ACCUMULATED_DEPRECIATION',
  'RETAINED_EARNINGS',
  'OPENING_BALANCE_EQUITY',
];

function makeContext(functionalCurrency = 'SAR'): PostingContext {
  return {
    tenantId: 'tenant-1',
    branchId: 'branch-1',
    functionalCurrency,
    resolver: new InMemoryAccountResolver(
      KEYS.map((key) => ({
        key,
        accountId: `acct-${key}`,
        branchId: null,
        categoryId: null,
      })),
    ),
  };
}

function line(overrides: Partial<InvoiceLineFacts> & { currency?: string } = {}): InvoiceLineFacts {
  const currency = overrides.currency ?? 'SAR';
  return {
    productId: 'product-1',
    grossAmount: Money.of('1000', currency),
    discount: Money.zero(currency),
    taxAmount: Money.of('150', currency),
    cogsAmount: Money.of('700', 'SAR'),
    isStockItem: true,
    ...overrides,
  };
}

const today = unwrap(DateOnly.create('2026-03-15'));

function facts(lines: InvoiceLineFacts[], currency = 'SAR', exchangeRate = '1'): Parameters<typeof buildSalesInvoiceJournal>[0] {
  return {
    documentId: 'doc-1',
    documentNumber: 'INV-2026-00001',
    counterpartyId: 'cp-1',
    date: today,
    currency,
    exchangeRate,
    lines,
  };
}

describe('buildSalesInvoiceJournal', () => {
  it('produces a balanced entry for a simple invoice', () => {
    const draft = unwrap(buildSalesInvoiceJournal(facts([line()]), makeContext()));
    const entry = unwrap(draft.validate());

    expect(entry.totalDebit.equals(entry.totalCredit)).toBe(true);
    expect(entry.totalDebit.toFixed(2)).toBe('1850.00'); // AR 1150 + COGS 700
  });

  it('recognises revenue net of VAT and cost of sales separately', () => {
    const draft = unwrap(buildSalesInvoiceJournal(facts([line()]), makeContext()));
    const lines = draft.peekLines();

    const receivable = lines.find((entry) => entry.accountId === 'acct-AR_CONTROL');
    const revenue = lines.find((entry) => entry.accountId === 'acct-SALES_REVENUE');
    const vat = lines.find((entry) => entry.accountId === 'acct-VAT_OUTPUT');
    const cogs = lines.find((entry) => entry.accountId === 'acct-COGS');

    expect(receivable?.debit.toFixed(2)).toBe('1150.00');
    expect(revenue?.credit.toFixed(2)).toBe('1000.00');
    expect(vat?.credit.toFixed(2)).toBe('150.00');
    expect(cogs?.debit.toFixed(2)).toBe('700.00');
  });

  it('tags the receivable with the counterparty so the sub-ledger reconciles', () => {
    const draft = unwrap(buildSalesInvoiceJournal(facts([line()]), makeContext()));
    const receivable = draft.peekLines().find((entry) => entry.accountId === 'acct-AR_CONTROL');
    expect(receivable?.counterpartyId).toBe('cp-1');
  });

  it('balances with a discount posted to its own account', () => {
    const draft = unwrap(
      buildSalesInvoiceJournal(
        facts([line({ discount: Money.of('137.77', 'SAR'), taxAmount: Money.of('129.33', 'SAR') })]),
        makeContext(),
      ),
    );
    const entry = unwrap(draft.validate());
    expect(entry.totalDebit.equals(entry.totalCredit)).toBe(true);

    const discount = draft.peekLines().find((line) => line.accountId === 'acct-SALES_DISCOUNT');
    expect(discount?.debit.toFixed(2)).toBe('137.77');
  });

  it('balances across mixed standard-rated and zero-rated lines', () => {
    const draft = unwrap(
      buildSalesInvoiceJournal(
        facts([
          line({ grossAmount: Money.of('333.33', 'SAR'), taxAmount: Money.of('50.00', 'SAR') }),
          line({ grossAmount: Money.of('666.67', 'SAR'), taxAmount: Money.zero('SAR') }),
          line({ grossAmount: Money.of('0.01', 'SAR'), taxAmount: Money.of('0.0015', 'SAR') }),
        ]),
        makeContext(),
      ),
    );
    const entry = unwrap(draft.validate());
    expect(entry.totalDebit.equals(entry.totalCredit)).toBe(true);
  });

  it('balances when converting a foreign-currency invoice at a six-decimal rate', () => {
    // The classic source of a one-halala imbalance: converting revenue, VAT and
    // the receivable independently. Deriving them from a single converted total
    // makes that arithmetically impossible.
    const draft = unwrap(
      buildSalesInvoiceJournal(
        facts(
          [
            line({
              currency: 'USD',
              grossAmount: Money.of('333.33', 'USD'),
              discount: Money.of('11.11', 'USD'),
              taxAmount: Money.of('48.33', 'USD'),
            }),
          ],
          'USD',
          '3.751234',
        ),
        makeContext('SAR'),
      ),
    );

    const entry = unwrap(draft.validate());
    expect(entry.totalDebit.equals(entry.totalCredit)).toBe(true);
    expect(entry.totalDebit.currency).toBe('SAR');
  });

  it('omits the cost-of-sales block for a service-only invoice', () => {
    const draft = unwrap(
      buildSalesInvoiceJournal(
        facts([line({ isStockItem: false, cogsAmount: Money.zero('SAR') })]),
        makeContext(),
      ),
    );
    const entry = unwrap(draft.validate());

    expect(entry.lines.some((line) => line.accountId === 'acct-COGS')).toBe(false);
    expect(entry.totalDebit.equals(entry.totalCredit)).toBe(true);
  });

  it('refuses an invoice with no lines', () => {
    const result = buildSalesInvoiceJournal(facts([]), makeContext());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('EMPTY_DOCUMENT');
  });

  it('reports a missing account mapping rather than posting to nowhere', () => {
    const context: PostingContext = {
      ...makeContext(),
      resolver: new InMemoryAccountResolver([]),
    };
    const result = buildSalesInvoiceJournal(facts([line()]), context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ACCOUNT_MAPPING_MISSING');
  });

  it('stays balanced across a hundred randomised invoices', () => {
    // A property test in spirit: the rule must hold for arbitrary inputs, not
    // just the ones a developer thought to write down.
    for (let seed = 1; seed <= 100; seed += 1) {
      const lineCount = (seed % 5) + 1;
      const lines = Array.from({ length: lineCount }, (_, index) => {
        const gross = ((seed * 7919 + index * 104729) % 1_000_000) / 100;
        const discount = ((seed * 31 + index) % 97) / 100;
        const net = gross - discount;
        const tax = Math.round(net * 15) / 100;
        return line({
          grossAmount: Money.of(gross.toFixed(2), 'SAR'),
          discount: Money.of(discount.toFixed(2), 'SAR'),
          taxAmount: Money.of(tax.toFixed(2), 'SAR'),
          cogsAmount: Money.of((gross * 0.6).toFixed(2), 'SAR'),
        });
      });

      const entry = unwrap(unwrap(buildSalesInvoiceJournal(facts(lines), makeContext())).validate());
      expect(entry.totalDebit.equals(entry.totalCredit)).toBe(true);
    }
  });
});

describe('buildPurchaseInvoiceJournal', () => {
  it('capitalises net of discount and recovers input VAT', () => {
    const draft = unwrap(
      buildPurchaseInvoiceJournal(
        facts([line({ discount: Money.of('100', 'SAR'), taxAmount: Money.of('135', 'SAR') })]),
        makeContext(),
      ),
    );
    const entry = unwrap(draft.validate());
    expect(entry.totalDebit.equals(entry.totalCredit)).toBe(true);

    const inventory = entry.lines.filter((line) => line.accountId === 'acct-INVENTORY');
    const netInventory = inventory.reduce(
      (total, line) => total.add(line.debit).subtract(line.credit),
      Money.zero('SAR'),
    );
    // 1000 gross - 100 discount = 900 capitalised, VAT excluded.
    expect(netInventory.toFixed(2)).toBe('900.00');

    const payable = entry.lines.find((line) => line.accountId === 'acct-AP_CONTROL');
    expect(payable?.credit.toFixed(2)).toBe('1035.00');
  });

  it('routes service lines to expense rather than inventory', () => {
    const draft = unwrap(
      buildPurchaseInvoiceJournal(
        facts([line({ isStockItem: false })]),
        makeContext(),
      ),
    );
    const entry = unwrap(draft.validate());
    expect(entry.lines.some((line) => line.accountId === 'acct-PURCHASE_EXPENSE')).toBe(true);
    expect(entry.lines.some((line) => line.accountId === 'acct-INVENTORY')).toBe(false);
  });
});

describe('buildSalesCreditNoteJournal', () => {
  it('reverses revenue through a returns account and puts stock back', () => {
    const draft = unwrap(buildSalesCreditNoteJournal(facts([line()]), makeContext()));
    const entry = unwrap(draft.validate());

    expect(entry.totalDebit.equals(entry.totalCredit)).toBe(true);
    expect(entry.lines.find((line) => line.accountId === 'acct-SALES_RETURNS')?.debit.toFixed(2)).toBe('1000.00');
    expect(entry.lines.find((line) => line.accountId === 'acct-AR_CONTROL')?.credit.toFixed(2)).toBe('1150.00');
    expect(entry.lines.find((line) => line.accountId === 'acct-INVENTORY')?.debit.toFixed(2)).toBe('700.00');
  });
});

describe('buildPaymentJournal', () => {
  const base = {
    paymentId: 'pay-1',
    voucherNumber: 'RV-2026-00001',
    counterpartyId: 'cp-1',
    date: today,
    currency: 'SAR',
    exchangeRate: '1',
    cashAccountId: 'acct-BANK',
  };

  it('debits cash and relieves the receivable on a receipt', () => {
    const draft = unwrap(
      buildPaymentJournal(
        { ...base, type: 'RECEIPT', amount: Money.of('5000', 'SAR') },
        makeContext(),
      ),
    );
    const entry = unwrap(draft.validate());

    expect(entry.lines.find((line) => line.accountId === 'acct-BANK')?.debit.toFixed(2)).toBe('5000.00');
    expect(entry.lines.find((line) => line.accountId === 'acct-AR_CONTROL')?.credit.toFixed(2)).toBe('5000.00');
  });

  it('debits the payable and credits cash on a payment', () => {
    const draft = unwrap(
      buildPaymentJournal(
        { ...base, type: 'PAYMENT', amount: Money.of('5000', 'SAR') },
        makeContext(),
      ),
    );
    const entry = unwrap(draft.validate());

    expect(entry.lines.find((line) => line.accountId === 'acct-AP_CONTROL')?.debit.toFixed(2)).toBe('5000.00');
    expect(entry.lines.find((line) => line.accountId === 'acct-BANK')?.credit.toFixed(2)).toBe('5000.00');
  });

  it('balances a receipt carrying a realised FX gain', () => {
    const draft = unwrap(
      buildPaymentJournal(
        {
          ...base,
          type: 'RECEIPT',
          amount: Money.of('5000', 'SAR'),
          fxDifference: Money.of('123.45', 'SAR'),
        },
        makeContext(),
      ),
    );
    const entry = unwrap(draft.validate());
    expect(entry.totalDebit.equals(entry.totalCredit)).toBe(true);
    expect(entry.lines.find((line) => line.accountId === 'acct-FX_GAIN')?.credit.toFixed(2)).toBe('123.45');
  });

  it('balances a supplier payment carrying an FX gain', () => {
    // The receipt and payment sides move the control account in opposite
    // directions relative to the difference; getting one right and the other
    // wrong is the easy mistake here.
    const draft = unwrap(
      buildPaymentJournal(
        {
          ...base,
          type: 'PAYMENT',
          amount: Money.of('5000', 'SAR'),
          fxDifference: Money.of('123.45', 'SAR'),
        },
        makeContext(),
      ),
    );
    const entry = unwrap(draft.validate());
    expect(entry.totalDebit.equals(entry.totalCredit)).toBe(true);
    expect(entry.lines.find((line) => line.accountId === 'acct-AP_CONTROL')?.debit.toFixed(2)).toBe('5123.45');
  });

  it('balances a payment carrying an FX loss', () => {
    const draft = unwrap(
      buildPaymentJournal(
        {
          ...base,
          type: 'PAYMENT',
          amount: Money.of('5000', 'SAR'),
          fxDifference: Money.of('-77.77', 'SAR'),
        },
        makeContext(),
      ),
    );
    const entry = unwrap(draft.validate());
    expect(entry.totalDebit.equals(entry.totalCredit)).toBe(true);
    expect(entry.lines.find((line) => line.accountId === 'acct-FX_LOSS')?.debit.toFixed(2)).toBe('77.77');
  });

  it('refuses a zero or negative voucher', () => {
    const result = buildPaymentJournal(
      { ...base, type: 'RECEIPT', amount: Money.zero('SAR') },
      makeContext(),
    );
    expect(result.ok).toBe(false);
  });
});

describe('buildPayrollJournal', () => {
  it('balances gross against net plus deductions', () => {
    const draft = unwrap(
      buildPayrollJournal(
        {
          payrollRunId: 'run-1',
          runNumber: 'PR-2026-0001',
          date: today,
          totalGross: Money.of('500000', 'SAR'),
          totalDeductions: Money.of('48750', 'SAR'),
          totalNet: Money.of('451250', 'SAR'),
        },
        makeContext(),
      ),
    );
    const entry = unwrap(draft.validate());
    expect(entry.totalDebit.equals(entry.totalCredit)).toBe(true);
  });

  it('refuses a run whose components do not reconcile', () => {
    const result = buildPayrollJournal(
      {
        payrollRunId: 'run-1',
        runNumber: 'PR-2026-0001',
        date: today,
        totalGross: Money.of('500000', 'SAR'),
        totalDeductions: Money.of('48750', 'SAR'),
        totalNet: Money.of('400000', 'SAR'),
      },
      makeContext(),
    );
    expect(result.ok).toBe(false);
  });
});

describe('buildInventoryAdjustmentJournal', () => {
  it('writes inventory up', () => {
    const draft = unwrap(
      buildInventoryAdjustmentJournal(
        {
          movementId: 'mov-1',
          movementNumber: 'MOV-2026-000001',
          date: today,
          valueChange: Money.of('2500', 'SAR'),
          reasonAr: 'جرد',
          reasonEn: 'Stock count',
        },
        makeContext(),
      ),
    );
    const entry = unwrap(draft.validate());
    expect(entry.lines.find((line) => line.accountId === 'acct-INVENTORY')?.debit.toFixed(2)).toBe('2500.00');
  });

  it('writes inventory down when the change is negative', () => {
    const draft = unwrap(
      buildInventoryAdjustmentJournal(
        {
          movementId: 'mov-1',
          movementNumber: 'MOV-2026-000001',
          date: today,
          valueChange: Money.of('-2500', 'SAR'),
          reasonAr: 'تلف',
          reasonEn: 'Damage',
        },
        makeContext(),
      ),
    );
    const entry = unwrap(draft.validate());
    expect(entry.lines.find((line) => line.accountId === 'acct-INVENTORY')?.credit.toFixed(2)).toBe('2500.00');
    expect(entry.totalDebit.equals(entry.totalCredit)).toBe(true);
  });

  it('refuses an adjustment worth nothing', () => {
    const result = buildInventoryAdjustmentJournal(
      {
        movementId: 'mov-1',
        movementNumber: 'MOV-2026-000001',
        date: today,
        valueChange: Money.zero('SAR'),
        reasonAr: 'جرد',
        reasonEn: 'Stock count',
      },
      makeContext(),
    );
    expect(result.ok).toBe(false);
  });
});
