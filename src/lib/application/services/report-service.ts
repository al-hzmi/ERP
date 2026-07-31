import { Money } from '@/lib/domain/shared/money';
import { prisma } from '@/lib/infrastructure/db/prisma';

/**
 * The reporting layer.
 *
 * Every figure here is aggregated in PostgreSQL and returned as a decimal
 * string. Nothing is summed in JavaScript, for two reasons: the database can do
 * it against an index without shipping a million rows over the wire, and a
 * JavaScript sum of a million doubles is not the same number twice.
 *
 * Reports read exclusively from POSTED entries. A draft journal is a proposal,
 * and a trial balance that includes proposals is not a trial balance.
 */

export interface ReportPeriod {
  readonly tenantId: string;
  readonly fromDate: Date;
  readonly toDate: Date;
  readonly branchId?: string;
  readonly currency: string;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Trial balance
// ─────────────────────────────────────────────────────────────────────────────

export interface TrialBalanceRow {
  readonly accountId: string;
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly type: string;
  readonly openingBalance: string;
  readonly periodDebit: string;
  readonly periodCredit: string;
  readonly closingBalance: string;
}

export interface TrialBalance {
  readonly rows: readonly TrialBalanceRow[];
  readonly totalDebit: string;
  readonly totalCredit: string;
  /** The whole point of the report: this must be true, always. */
  readonly isBalanced: boolean;
}

/**
 * Movements per account for the period, plus the opening position carried in.
 *
 * The opening balance is computed as the signed sum of everything posted before
 * the period start, in the account's natural direction — so an asset with net
 * debits shows a positive opening balance and a liability with net credits does
 * too. That is what an accountant expects to read.
 */
export async function getTrialBalance(period: ReportPeriod): Promise<TrialBalance> {
  const rows = await prisma.$queryRaw<
    {
      accountId: string;
      code: string;
      nameAr: string;
      nameEn: string;
      type: string;
      openingBalance: string;
      periodDebit: string;
      periodCredit: string;
      closingBalance: string;
    }[]
  >`
    WITH movements AS (
      SELECT l."accountId",
             SUM(CASE WHEN j."date" <  ${period.fromDate}::date THEN l."debit"  ELSE 0 END) AS opening_debit,
             SUM(CASE WHEN j."date" <  ${period.fromDate}::date THEN l."credit" ELSE 0 END) AS opening_credit,
             SUM(CASE WHEN j."date" >= ${period.fromDate}::date THEN l."debit"  ELSE 0 END) AS period_debit,
             SUM(CASE WHEN j."date" >= ${period.fromDate}::date THEN l."credit" ELSE 0 END) AS period_credit
        FROM "journal_lines" l
        JOIN "journals" j
          ON j."id" = l."journalId" AND j."date" = l."journalDate"
       WHERE l."tenantId" = ${period.tenantId}::uuid
         AND j."status" = 'POSTED'
         AND j."date" <= ${period.toDate}::date
         AND (${period.branchId ?? null}::uuid IS NULL OR j."branchId" = ${period.branchId ?? null}::uuid)
       GROUP BY l."accountId"
    )
    SELECT a."id"     AS "accountId",
           a."code",
           a."nameAr",
           a."nameEn",
           a."type"::text AS type,
           (CASE WHEN a."nature" = 'DEBIT'
                 THEN COALESCE(m.opening_debit, 0) - COALESCE(m.opening_credit, 0)
                 ELSE COALESCE(m.opening_credit, 0) - COALESCE(m.opening_debit, 0)
            END)::text AS "openingBalance",
           COALESCE(m.period_debit, 0)::text  AS "periodDebit",
           COALESCE(m.period_credit, 0)::text AS "periodCredit",
           (CASE WHEN a."nature" = 'DEBIT'
                 THEN COALESCE(m.opening_debit, 0) + COALESCE(m.period_debit, 0)
                    - COALESCE(m.opening_credit, 0) - COALESCE(m.period_credit, 0)
                 ELSE COALESCE(m.opening_credit, 0) + COALESCE(m.period_credit, 0)
                    - COALESCE(m.opening_debit, 0) - COALESCE(m.period_debit, 0)
            END)::text AS "closingBalance"
      FROM "accounts" a
      LEFT JOIN movements m ON m."accountId" = a."id"
     WHERE a."tenantId" = ${period.tenantId}::uuid
       AND a."isPostable"
       AND (m."accountId" IS NOT NULL OR a."isActive")
     ORDER BY a."code"
  `;

  const totalDebit = sumStrings(rows.map((row) => row.periodDebit), period.currency);
  const totalCredit = sumStrings(rows.map((row) => row.periodCredit), period.currency);

  return {
    rows,
    totalDebit: totalDebit.toFixed(2),
    totalCredit: totalCredit.toFixed(2),
    isBalanced: totalDebit.equals(totalCredit),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Income statement
// ─────────────────────────────────────────────────────────────────────────────

export interface IncomeStatementLine {
  readonly accountId: string;
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly amount: string;
}

export interface IncomeStatement {
  readonly revenue: readonly IncomeStatementLine[];
  readonly expenses: readonly IncomeStatementLine[];
  readonly totalRevenue: string;
  readonly totalExpenses: string;
  readonly netProfit: string;
  /** Net profit as a percentage of revenue, or null when revenue is zero. */
  readonly netMargin: string | null;
}

export async function getIncomeStatement(period: ReportPeriod): Promise<IncomeStatement> {
  const rows = await prisma.$queryRaw<
    { accountId: string; code: string; nameAr: string; nameEn: string; type: string; amount: string }[]
  >`
    SELECT a."id" AS "accountId", a."code", a."nameAr", a."nameEn", a."type"::text AS type,
           (CASE WHEN a."type" = 'REVENUE'
                 THEN SUM(l."credit") - SUM(l."debit")
                 ELSE SUM(l."debit")  - SUM(l."credit")
            END)::text AS amount
      FROM "journal_lines" l
      JOIN "journals" j ON j."id" = l."journalId" AND j."date" = l."journalDate"
      JOIN "accounts" a ON a."id" = l."accountId"
     WHERE l."tenantId" = ${period.tenantId}::uuid
       AND j."status" = 'POSTED'
       AND j."date" BETWEEN ${period.fromDate}::date AND ${period.toDate}::date
       AND a."type" IN ('REVENUE', 'EXPENSE')
       AND (${period.branchId ?? null}::uuid IS NULL OR j."branchId" = ${period.branchId ?? null}::uuid)
     GROUP BY a."id", a."code", a."nameAr", a."nameEn", a."type"
     HAVING SUM(l."debit") <> 0 OR SUM(l."credit") <> 0
     ORDER BY a."code"
  `;

  const revenue = rows.filter((row) => row.type === 'REVENUE');
  const expenses = rows.filter((row) => row.type === 'EXPENSE');

  const totalRevenue = sumStrings(revenue.map((row) => row.amount), period.currency);
  const totalExpenses = sumStrings(expenses.map((row) => row.amount), period.currency);
  const netProfit = totalRevenue.subtract(totalExpenses);

  return {
    revenue: revenue.map(stripType),
    expenses: expenses.map(stripType),
    totalRevenue: totalRevenue.toFixed(2),
    totalExpenses: totalExpenses.toFixed(2),
    netProfit: netProfit.toFixed(2),
    netMargin: totalRevenue.isZero
      ? null
      : netProfit.divide(totalRevenue.toString()).multiply('100').toFixed(2),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Balance sheet
// ─────────────────────────────────────────────────────────────────────────────

export interface BalanceSheet {
  readonly assets: readonly IncomeStatementLine[];
  readonly liabilities: readonly IncomeStatementLine[];
  readonly equity: readonly IncomeStatementLine[];
  readonly totalAssets: string;
  readonly totalLiabilities: string;
  readonly totalEquity: string;
  /** Retained earnings for the period, folded into equity so the sheet balances. */
  readonly currentPeriodProfit: string;
  readonly isBalanced: boolean;
}

/**
 * Assets = liabilities + equity, as at `toDate`.
 *
 * The current period's profit is added to equity explicitly rather than assumed
 * to have been closed out — otherwise the sheet fails to balance for every day
 * of the year except 31 December.
 */
/**
 * Assets, liabilities and equity as at a date.
 *
 * ## Why the sign comes from `type` and not from `nature`
 *
 * This used `nature`, and it was wrong for exactly one class of account: a contra. Accumulated
 * depreciation is `type: ASSET` with `nature: CREDIT`, so signing by nature produced a positive
 * figure and *added* it to total assets — when reducing them is the entire purpose of a
 * contra-asset. The sheet then failed to balance by twice the accumulated depreciation.
 *
 * Nothing caught it for nine migrations because nothing had ever posted to a contra account:
 * migration 3 made them expressible, the seed created four, and they stayed at zero until the
 * depreciation run shipped and credited one. The first balance sheet rendered after that was
 * the first one that could have been wrong.
 *
 * Signing by type gives a contra its correct negative sign for free — a credit-natured ASSET
 * yields `debit - credit < 0` — and needs no `isContra` flag, so a contra account added later
 * cannot be forgotten. That is why it beats special-casing the flag.
 */
export async function getBalanceSheet(period: ReportPeriod): Promise<BalanceSheet> {
  const rows = await prisma.$queryRaw<
    { accountId: string; code: string; nameAr: string; nameEn: string; type: string; amount: string }[]
  >`
    SELECT a."id" AS "accountId", a."code", a."nameAr", a."nameEn", a."type"::text AS type,
           -- Signed by the account's TYPE, not its nature. See the note above this function.
           (CASE WHEN a."type" = 'ASSET'
                 THEN SUM(l."debit")  - SUM(l."credit")
                 ELSE SUM(l."credit") - SUM(l."debit")
            END)::text AS amount
      FROM "journal_lines" l
      JOIN "journals" j ON j."id" = l."journalId" AND j."date" = l."journalDate"
      JOIN "accounts" a ON a."id" = l."accountId"
     WHERE l."tenantId" = ${period.tenantId}::uuid
       AND j."status" = 'POSTED'
       AND j."date" <= ${period.toDate}::date
       AND a."type" IN ('ASSET', 'LIABILITY', 'EQUITY')
       AND (${period.branchId ?? null}::uuid IS NULL OR j."branchId" = ${period.branchId ?? null}::uuid)
     GROUP BY a."id", a."code", a."nameAr", a."nameEn", a."type"
     HAVING SUM(l."debit") <> 0 OR SUM(l."credit") <> 0
     ORDER BY a."code"
  `;

  const profitRows = await prisma.$queryRaw<{ amount: string }[]>`
    SELECT COALESCE(
             SUM(CASE WHEN a."type" = 'REVENUE' THEN l."credit" - l."debit"
                      ELSE -(l."debit" - l."credit") END),
             0
           )::text AS amount
      FROM "journal_lines" l
      JOIN "journals" j ON j."id" = l."journalId" AND j."date" = l."journalDate"
      JOIN "accounts" a ON a."id" = l."accountId"
     WHERE l."tenantId" = ${period.tenantId}::uuid
       AND j."status" = 'POSTED'
       AND j."date" <= ${period.toDate}::date
       AND a."type" IN ('REVENUE', 'EXPENSE')
       AND (${period.branchId ?? null}::uuid IS NULL OR j."branchId" = ${period.branchId ?? null}::uuid)
  `;

  const assets = rows.filter((row) => row.type === 'ASSET');
  const liabilities = rows.filter((row) => row.type === 'LIABILITY');
  const equity = rows.filter((row) => row.type === 'EQUITY');

  const totalAssets = sumStrings(assets.map((row) => row.amount), period.currency);
  const totalLiabilities = sumStrings(liabilities.map((row) => row.amount), period.currency);
  const bookedEquity = sumStrings(equity.map((row) => row.amount), period.currency);
  const currentProfit = Money.of(profitRows[0]?.amount ?? '0', period.currency);
  const totalEquity = bookedEquity.add(currentProfit);

  return {
    assets: assets.map(stripType),
    liabilities: liabilities.map(stripType),
    equity: equity.map(stripType),
    totalAssets: totalAssets.toFixed(2),
    totalLiabilities: totalLiabilities.toFixed(2),
    totalEquity: totalEquity.toFixed(2),
    currentPeriodProfit: currentProfit.toFixed(2),
    isBalanced: totalAssets.equals(totalLiabilities.add(totalEquity)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Receivables / payables ageing
// ─────────────────────────────────────────────────────────────────────────────

export interface AgingBucket {
  readonly counterpartyId: string;
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly current: string;
  readonly days1to30: string;
  readonly days31to60: string;
  readonly days61to90: string;
  readonly over90: string;
  readonly total: string;
  readonly creditLimit: string;
}

/**
 * Ages open documents into the standard 30/60/90 buckets as at `asOf`.
 *
 * Bucketing happens in SQL so that a customer with 400 open invoices costs one
 * row of output rather than 400 rows of transfer.
 */
export async function getAgingReport(
  tenantId: string,
  type: 'RECEIVABLE' | 'PAYABLE',
  asOf: Date,
  currency: string,
): Promise<{ rows: AgingBucket[]; totals: Omit<AgingBucket, 'counterpartyId' | 'code' | 'nameAr' | 'nameEn' | 'creditLimit'> }> {
  const documentTypes =
    type === 'RECEIVABLE'
      ? ['SALES_INVOICE', 'SALES_CREDIT_NOTE']
      : ['PURCHASE_INVOICE', 'PURCHASE_DEBIT_NOTE'];

  const rows = await prisma.$queryRaw<AgingBucket[]>`
    SELECT c."id" AS "counterpartyId", c."code", c."nameAr", c."nameEn",
           c."creditLimit"::text AS "creditLimit",
           SUM(CASE WHEN ${asOf}::date <= d."dueDate"                                    THEN d."total" - d."paidAmount" ELSE 0 END)::text AS current,
           SUM(CASE WHEN ${asOf}::date - d."dueDate" BETWEEN 1  AND 30                   THEN d."total" - d."paidAmount" ELSE 0 END)::text AS "days1to30",
           SUM(CASE WHEN ${asOf}::date - d."dueDate" BETWEEN 31 AND 60                   THEN d."total" - d."paidAmount" ELSE 0 END)::text AS "days31to60",
           SUM(CASE WHEN ${asOf}::date - d."dueDate" BETWEEN 61 AND 90                   THEN d."total" - d."paidAmount" ELSE 0 END)::text AS "days61to90",
           SUM(CASE WHEN ${asOf}::date - d."dueDate" > 90                                THEN d."total" - d."paidAmount" ELSE 0 END)::text AS "over90",
           SUM(d."total" - d."paidAmount")::text AS total
      FROM "documents" d
      JOIN "counterparties" c ON c."id" = d."counterpartyId"
     WHERE d."tenantId" = ${tenantId}::uuid
       AND d."isPosted"
       AND d."status" IN ('POSTED', 'PARTIAL_PAID')
       AND d."type"::text = ANY(${documentTypes}::text[])
       AND d."issueDate" <= ${asOf}::date
       AND d."total" > d."paidAmount"
     GROUP BY c."id", c."code", c."nameAr", c."nameEn", c."creditLimit"
     HAVING SUM(d."total" - d."paidAmount") <> 0
     ORDER BY SUM(d."total" - d."paidAmount") DESC
  `;

  return {
    rows,
    totals: {
      current: sumStrings(rows.map((r) => r.current), currency).toFixed(2),
      days1to30: sumStrings(rows.map((r) => r.days1to30), currency).toFixed(2),
      days31to60: sumStrings(rows.map((r) => r.days31to60), currency).toFixed(2),
      days61to90: sumStrings(rows.map((r) => r.days61to90), currency).toFixed(2),
      over90: sumStrings(rows.map((r) => r.over90), currency).toFixed(2),
      total: sumStrings(rows.map((r) => r.total), currency).toFixed(2),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Inventory valuation
// ─────────────────────────────────────────────────────────────────────────────

export interface InventoryValuationRow {
  readonly productId: string;
  readonly sku: string;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly warehouseNameAr: string;
  readonly quantityOnHand: string;
  readonly averageCost: string;
  readonly totalValue: string;
  readonly reorderPoint: string;
  readonly isBelowReorder: boolean;
}

export async function getInventoryValuation(
  tenantId: string,
  currency: string,
  warehouseId?: string,
): Promise<{ rows: InventoryValuationRow[]; totalValue: string; belowReorderCount: number }> {
  const rows = await prisma.$queryRaw<InventoryValuationRow[]>`
    SELECT p."id" AS "productId", p."sku", p."nameAr", p."nameEn",
           w."nameAr" AS "warehouseNameAr",
           s."quantityOnHand"::text AS "quantityOnHand",
           s."averageCost"::text    AS "averageCost",
           s."totalValue"::text     AS "totalValue",
           p."reorderPoint"::text   AS "reorderPoint",
           (s."quantityOnHand" <= p."reorderPoint") AS "isBelowReorder"
      FROM "stock_levels" s
      JOIN "products"   p ON p."id" = s."productId"
      JOIN "warehouses" w ON w."id" = s."warehouseId"
     WHERE s."tenantId" = ${tenantId}::uuid
       AND (${warehouseId ?? null}::uuid IS NULL OR s."warehouseId" = ${warehouseId ?? null}::uuid)
       AND (s."quantityOnHand" <> 0 OR s."totalValue" <> 0)
     ORDER BY s."totalValue" DESC
  `;

  return {
    rows,
    totalValue: sumStrings(rows.map((row) => row.totalValue), currency).toFixed(2),
    belowReorderCount: rows.filter((row) => row.isBelowReorder).length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Dashboard
// ─────────────────────────────────────────────────────────────────────────────

export interface DashboardMetrics {
  readonly revenueThisMonth: string;
  readonly revenueLastMonth: string;
  readonly revenueGrowthPercent: string | null;
  readonly grossMargin: string;
  readonly grossMarginPercent: string | null;
  readonly receivablesOutstanding: string;
  readonly payablesOutstanding: string;
  readonly overdueReceivables: string;
  readonly cashPosition: string;
  readonly inventoryValue: string;
  readonly documentsAwaitingApproval: number;
  readonly productsBelowReorder: number;
  readonly expiringBatchesCount: number;
  readonly revenueByMonth: readonly { month: string; revenue: string; cogs: string }[];
  readonly topProducts: readonly { sku: string; nameAr: string; revenue: string; quantity: string }[];
}

/**
 * The figures the dashboard shows above the fold.
 *
 * Gathered in one round of parallel queries rather than one query per tile —
 * eleven sequential round trips is how a dashboard becomes the slowest page in
 * an otherwise fast application.
 */
export async function getDashboardMetrics(
  tenantId: string,
  currency: string,
  asOf: Date = new Date(),
): Promise<DashboardMetrics> {
  const monthStart = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), 1));
  const lastMonthStart = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() - 1, 1));
  const twelveMonthsAgo = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() - 11, 1));

  const [
    revenueRows,
    receivables,
    payables,
    cash,
    inventory,
    approvals,
    reorder,
    expiring,
    monthly,
    top,
  ] = await Promise.all([
    prisma.$queryRaw<{ period: string; revenue: string; cogs: string }[]>`
      SELECT CASE WHEN j."date" >= ${monthStart}::date THEN 'current' ELSE 'previous' END AS period,
             SUM(CASE WHEN a."type" = 'REVENUE' THEN l."credit" - l."debit" ELSE 0 END)::text AS revenue,
             SUM(CASE WHEN a."code" LIKE '5%' AND a."type" = 'EXPENSE' THEN l."debit" - l."credit" ELSE 0 END)::text AS cogs
        FROM "journal_lines" l
        JOIN "journals" j ON j."id" = l."journalId" AND j."date" = l."journalDate"
        JOIN "accounts" a ON a."id" = l."accountId"
       WHERE l."tenantId" = ${tenantId}::uuid
         AND j."status" = 'POSTED'
         AND j."date" >= ${lastMonthStart}::date
         AND j."date" <= ${asOf}::date
       GROUP BY 1
    `,
    prisma.$queryRaw<{ total: string; overdue: string }[]>`
      SELECT COALESCE(SUM(d."total" - d."paidAmount"), 0)::text AS total,
             COALESCE(SUM(CASE WHEN d."dueDate" < ${asOf}::date THEN d."total" - d."paidAmount" ELSE 0 END), 0)::text AS overdue
        FROM "documents" d
       WHERE d."tenantId" = ${tenantId}::uuid
         AND d."isPosted"
         AND d."status" IN ('POSTED', 'PARTIAL_PAID')
         AND d."type" = 'SALES_INVOICE'
    `,
    prisma.$queryRaw<{ total: string }[]>`
      SELECT COALESCE(SUM(d."total" - d."paidAmount"), 0)::text AS total
        FROM "documents" d
       WHERE d."tenantId" = ${tenantId}::uuid
         AND d."isPosted"
         AND d."status" IN ('POSTED', 'PARTIAL_PAID')
         AND d."type" = 'PURCHASE_INVOICE'
    `,
    prisma.$queryRaw<{ total: string }[]>`
      SELECT COALESCE(SUM(a."balance"), 0)::text AS total
        FROM "accounts" a
        JOIN "account_mappings" m ON m."accountId" = a."id"
       WHERE a."tenantId" = ${tenantId}::uuid
         AND m."key" IN ('CASH', 'BANK')
    `,
    prisma.$queryRaw<{ total: string }[]>`
      SELECT COALESCE(SUM(s."totalValue"), 0)::text AS total
        FROM "stock_levels" s
       WHERE s."tenantId" = ${tenantId}::uuid
    `,
    prisma.document.count({
      where: { tenantId, status: 'PENDING_APPROVAL' },
    }),
    prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count
        FROM "stock_levels" s
        JOIN "products" p ON p."id" = s."productId"
       WHERE s."tenantId" = ${tenantId}::uuid
         AND s."quantityOnHand" <= p."reorderPoint"
         AND p."isActive"
    `,
    prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count
        FROM "cost_layers" c
       WHERE c."tenantId" = ${tenantId}::uuid
         AND c."remainingQuantity" > 0
         AND c."expiryDate" IS NOT NULL
         AND c."expiryDate" <= ${asOf}::date + INTERVAL '90 days'
    `,
    prisma.$queryRaw<{ month: string; revenue: string; cogs: string }[]>`
      SELECT to_char(date_trunc('month', j."date"), 'YYYY-MM') AS month,
             SUM(CASE WHEN a."type" = 'REVENUE' THEN l."credit" - l."debit" ELSE 0 END)::text AS revenue,
             SUM(CASE WHEN a."type" = 'EXPENSE' AND a."code" LIKE '5%' THEN l."debit" - l."credit" ELSE 0 END)::text AS cogs
        FROM "journal_lines" l
        JOIN "journals" j ON j."id" = l."journalId" AND j."date" = l."journalDate"
        JOIN "accounts" a ON a."id" = l."accountId"
       WHERE l."tenantId" = ${tenantId}::uuid
         AND j."status" = 'POSTED'
         AND j."date" >= ${twelveMonthsAgo}::date
       GROUP BY 1
       ORDER BY 1
    `,
    prisma.$queryRaw<{ sku: string; nameAr: string; revenue: string; quantity: string }[]>`
      SELECT p."sku", p."nameAr",
             SUM(dl."lineTotal" - dl."taxAmount")::text AS revenue,
             SUM(dl."quantity")::text AS quantity
        FROM "document_lines" dl
        JOIN "documents" d ON d."id" = dl."documentId"
        JOIN "products"  p ON p."id" = dl."productId"
       WHERE d."tenantId" = ${tenantId}::uuid
         AND d."isPosted"
         AND d."type" = 'SALES_INVOICE'
         AND d."issueDate" >= ${twelveMonthsAgo}::date
       GROUP BY p."sku", p."nameAr"
       ORDER BY SUM(dl."lineTotal" - dl."taxAmount") DESC
       LIMIT 10
    `,
  ]);

  const current = revenueRows.find((row) => row.period === 'current');
  const previous = revenueRows.find((row) => row.period === 'previous');

  const revenueThisMonth = Money.of(current?.revenue ?? '0', currency);
  const revenueLastMonth = Money.of(previous?.revenue ?? '0', currency);
  const cogsThisMonth = Money.of(current?.cogs ?? '0', currency);
  const grossMargin = revenueThisMonth.subtract(cogsThisMonth);

  return {
    revenueThisMonth: revenueThisMonth.toFixed(2),
    revenueLastMonth: revenueLastMonth.toFixed(2),
    revenueGrowthPercent: revenueLastMonth.isZero
      ? null
      : revenueThisMonth
          .subtract(revenueLastMonth)
          .divide(revenueLastMonth.toString())
          .multiply('100')
          .toFixed(1),
    grossMargin: grossMargin.toFixed(2),
    grossMarginPercent: revenueThisMonth.isZero
      ? null
      : grossMargin.divide(revenueThisMonth.toString()).multiply('100').toFixed(1),
    receivablesOutstanding: Money.of(receivables[0]?.total ?? '0', currency).toFixed(2),
    overdueReceivables: Money.of(receivables[0]?.overdue ?? '0', currency).toFixed(2),
    payablesOutstanding: Money.of(payables[0]?.total ?? '0', currency).toFixed(2),
    cashPosition: Money.of(cash[0]?.total ?? '0', currency).toFixed(2),
    inventoryValue: Money.of(inventory[0]?.total ?? '0', currency).toFixed(2),
    documentsAwaitingApproval: approvals,
    productsBelowReorder: Number(reorder[0]?.count ?? 0n),
    expiringBatchesCount: Number(expiring[0]?.count ?? 0n),
    revenueByMonth: monthly,
    topProducts: top,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────
//  General ledger
// ─────────────────────────────────────────────────────────────────────────────

export interface GeneralLedgerLine {
  readonly journalId: string;
  readonly entryNumber: string;
  readonly journalType: string;
  readonly date: string;
  readonly descriptionAr: string;
  readonly lineDescription: string | null;
  readonly counterpartyName: string | null;
  readonly debit: string;
  readonly credit: string;
  /** The account's balance in its natural direction after this line. */
  readonly runningBalance: string;
}

export interface GeneralLedger {
  readonly account: {
    id: string;
    code: string;
    nameAr: string;
    nameEn: string;
    type: string;
    nature: string;
  };
  readonly openingBalance: string;
  readonly lines: readonly GeneralLedgerLine[];
  readonly periodDebit: string;
  readonly periodCredit: string;
  readonly closingBalance: string;
  /** True when `lines` was cut short, so the screen can say so rather than mislead. */
  readonly truncated: boolean;
}

const GENERAL_LEDGER_LIMIT = 1000;

/**
 * Every posting to one account over a period, with a running balance.
 *
 * This is the report an accountant reaches for when the trial balance shows a figure they did
 * not expect: it is the only view that answers "which entries made this number".
 *
 * ## The running balance is computed in SQL
 *
 * `SUM(...) OVER (ORDER BY ...)` rather than a loop in TypeScript. Two reasons, and the second
 * is the one that matters: a window function keeps the arithmetic in `numeric` for the whole
 * column, where accumulating in JavaScript would either go through `number` — reintroducing
 * floating point on the one column a reader scans for a discrepancy — or pay a `Decimal`
 * allocation per row for a thousand rows to reach the same answer more slowly.
 *
 * The window's ordering must match the query's, or the running balance belongs to a different
 * sequence of rows than the one displayed. Both are `(date, entryNumber, lineNumber)`.
 *
 * ## The opening balance is a separate query, not the first row
 *
 * Everything posted *before* the period, in the account's natural direction. Deriving it by
 * fetching from the beginning of time and slicing would transfer a year of rows to display a
 * month of them.
 *
 * ## Only POSTED journals
 *
 * A draft is not in the ledger. Including it would produce a running balance that no other
 * report agrees with, and the disagreement would be blamed on this screen.
 */
export async function getGeneralLedger(
  period: ReportPeriod & { accountId: string },
): Promise<GeneralLedger | null> {
  const account = await prisma.account.findFirst({
    where: { id: period.accountId, tenantId: period.tenantId },
    select: { id: true, code: true, nameAr: true, nameEn: true, type: true, nature: true },
  });

  if (account === null) return null;

  const natural = account.nature === 'DEBIT';

  const openingRows = await prisma.$queryRaw<{ amount: string }[]>`
    SELECT COALESCE(
             CASE WHEN ${natural}
                  THEN SUM(l."debit")  - SUM(l."credit")
                  ELSE SUM(l."credit") - SUM(l."debit")
             END, 0)::text AS amount
      FROM "journal_lines" l
      JOIN "journals" j ON j."id" = l."journalId" AND j."date" = l."journalDate"
     WHERE l."tenantId" = ${period.tenantId}::uuid
       AND l."accountId" = ${period.accountId}::uuid
       AND j."status" = 'POSTED'
       AND j."date" < ${period.fromDate}::date
       AND (${period.branchId ?? null}::uuid IS NULL OR j."branchId" = ${period.branchId ?? null}::uuid)
  `;

  const opening = openingRows[0]?.amount ?? '0';

  const rows = await prisma.$queryRaw<
    {
      journalId: string;
      entryNumber: string;
      journalType: string;
      date: Date;
      descriptionAr: string;
      lineDescription: string | null;
      counterpartyName: string | null;
      debit: string;
      credit: string;
      runningBalance: string;
    }[]
  >`
    SELECT j."id"            AS "journalId",
           j."entryNumber",
           j."type"::text    AS "journalType",
           j."date",
           j."descriptionAr",
           l."description"   AS "lineDescription",
           c."nameAr"        AS "counterpartyName",
           l."debit"::text   AS "debit",
           l."credit"::text  AS "credit",
           (${opening}::numeric +
            SUM(CASE WHEN ${natural} THEN l."debit" - l."credit"
                     ELSE l."credit" - l."debit" END)
              OVER (ORDER BY j."date", j."entryNumber", l."lineNumber"
                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
           )::text AS "runningBalance"
      FROM "journal_lines" l
      JOIN "journals" j ON j."id" = l."journalId" AND j."date" = l."journalDate"
      LEFT JOIN "counterparties" c ON c."id" = l."counterpartyId"
     WHERE l."tenantId" = ${period.tenantId}::uuid
       AND l."accountId" = ${period.accountId}::uuid
       AND j."status" = 'POSTED'
       AND j."date" BETWEEN ${period.fromDate}::date AND ${period.toDate}::date
       AND (${period.branchId ?? null}::uuid IS NULL OR j."branchId" = ${period.branchId ?? null}::uuid)
     ORDER BY j."date", j."entryNumber", l."lineNumber"
     LIMIT ${GENERAL_LEDGER_LIMIT + 1}
  `;

  const truncated = rows.length > GENERAL_LEDGER_LIMIT;
  const visible = truncated ? rows.slice(0, GENERAL_LEDGER_LIMIT) : rows;

  const periodDebit = sumStrings(visible.map((row) => row.debit), period.currency);
  const periodCredit = sumStrings(visible.map((row) => row.credit), period.currency);
  const openingMoney = Money.of(opening, period.currency);

  const movement = natural
    ? periodDebit.subtract(periodCredit)
    : periodCredit.subtract(periodDebit);

  return {
    account,
    openingBalance: openingMoney.toFixed(4),
    lines: visible.map((row) => ({
      journalId: row.journalId,
      entryNumber: row.entryNumber,
      journalType: row.journalType,
      date: row.date.toISOString().slice(0, 10),
      descriptionAr: row.descriptionAr,
      lineDescription: row.lineDescription,
      counterpartyName: row.counterpartyName,
      debit: row.debit,
      credit: row.credit,
      runningBalance: row.runningBalance,
    })),
    periodDebit: periodDebit.toFixed(4),
    periodCredit: periodCredit.toFixed(4),
    // Computed from the totals rather than read off the last row, so a truncated page still
    // reports the closing balance of what it actually showed.
    closingBalance: openingMoney.add(movement).toFixed(4),
    truncated,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

function sumStrings(values: readonly string[], currency: string): Money {
  return values.reduce<Money>(
    (total, value) => total.add(Money.of(value, currency)),
    Money.zero(currency),
  );
}

function stripType(row: {
  accountId: string;
  code: string;
  nameAr: string;
  nameEn: string;
  amount: string;
}): IncomeStatementLine {
  return {
    accountId: row.accountId,
    code: row.code,
    nameAr: row.nameAr,
    nameEn: row.nameEn,
    amount: row.amount,
  };
}


// ─────────────────────────────────────────────────────────────────────────────
//  Inventory movement analysis
// ─────────────────────────────────────────────────────────────────────────────

export interface MovementAnalysisRow {
  readonly productId: string;
  readonly sku: string;
  readonly nameAr: string;
  readonly categoryNameAr: string | null;
  readonly quantityIn: string;
  readonly quantityOut: string;
  readonly netQuantity: string;
  readonly valueIn: string;
  readonly valueOut: string;
  readonly movementCount: number;
}

/**
 * What moved in and out over a period, by product.
 *
 * ## Direction comes from `balanceAfter`, not from `type`
 *
 * The obvious implementation classifies `MovementType` into inbound and outbound. It is wrong
 * here, and quietly: `ADJUSTMENT` is written for *both* directions — `applyAdjustment` posts a
 * shortage and a surplus under the same type — and `TRANSFER` is one type covering both legs of
 * a move. A `CASE` on `type` therefore has to guess on exactly the movements a stock report
 * exists to explain, and its totals would not reconcile with the stock card.
 *
 * `quantity` is documented as always positive, with direction carried by `type`. But
 * `balanceAfter` is the running on-hand balance, so the *signed* delta of any movement is
 * `balanceAfter - balanceAfter of the previous movement for the same product and warehouse`.
 * That is exact for every type, including the two ambiguous ones.
 *
 * ## The window orders by `movementNumber`, and that detail is load-bearing
 *
 * "Previous movement" is only meaningful under the order the balances were actually written
 * in. Ordering by `(movementDate, createdAt, id)` looks right and is not: `createdAt` defaults
 * to `now()`, which in PostgreSQL is *transaction start* time, so every movement written by one
 * transaction carries an identical timestamp and the random-uuid tiebreak shuffles them. Against
 * the seed that put 131 of 392 positions out — the totals silently disagreed with the stock card
 * on a third of the catalogue.
 *
 * `movementNumber` comes from `erp_next_document_number`, so it is monotonic in write order and
 * zero-padded within a year, which makes its lexicographic order the true one. Summing the
 * deltas per position under this ordering reproduces `stock_levels.quantityOnHand` exactly.
 *
 * ## Why the window runs over unfiltered movements
 *
 * The `LAG` is computed before the date filter is applied, in the inner query. Computing it
 * after would make the first movement inside the window look like the product's first ever —
 * its predecessor would be NULL — and attribute the entire opening balance to the period as an
 * inbound movement. The filter belongs outside the window, and that is the whole reason this is
 * two queries deep rather than one.
 */
export async function getMovementAnalysis(
  period: ReportPeriod & { warehouseId?: string; limit?: number },
): Promise<MovementAnalysisRow[]> {
  const rows = await prisma.$queryRaw<
    {
      productId: string;
      sku: string;
      nameAr: string;
      categoryNameAr: string | null;
      quantityIn: string;
      quantityOut: string;
      netQuantity: string;
      valueIn: string;
      valueOut: string;
      movementCount: bigint;
    }[]
  >`
    WITH deltas AS (
      SELECT m."productId",
             m."movementDate",
             m."unitCost",
             -- The signed change this movement made to the on-hand balance. COALESCE handles
             -- the product's first ever movement, whose predecessor balance is zero.
             m."balanceAfter" - COALESCE(
               LAG(m."balanceAfter") OVER (
                 PARTITION BY m."productId", m."warehouseId"
                 ORDER BY m."movementNumber"
               ), 0
             ) AS "delta"
        FROM "inventory_movements" m
       WHERE m."tenantId" = ${period.tenantId}::uuid
         AND (${period.warehouseId ?? null}::uuid IS NULL
              OR m."warehouseId" = ${period.warehouseId ?? null}::uuid)
    )
    SELECT p."id"       AS "productId",
           p."sku",
           p."nameAr",
           cat."nameAr" AS "categoryNameAr",
           COALESCE(SUM(CASE WHEN d."delta" > 0 THEN d."delta" ELSE 0 END), 0)::text  AS "quantityIn",
           COALESCE(SUM(CASE WHEN d."delta" < 0 THEN -d."delta" ELSE 0 END), 0)::text AS "quantityOut",
           COALESCE(SUM(d."delta"), 0)::text                                          AS "netQuantity",
           COALESCE(SUM(CASE WHEN d."delta" > 0 THEN d."delta" * d."unitCost"
                             ELSE 0 END), 0)::text                                    AS "valueIn",
           COALESCE(SUM(CASE WHEN d."delta" < 0 THEN -d."delta" * d."unitCost"
                             ELSE 0 END), 0)::text                                    AS "valueOut",
           COUNT(*) AS "movementCount"
      FROM deltas d
      JOIN "products" p ON p."id" = d."productId"
      LEFT JOIN "categories" cat ON cat."id" = p."categoryId"
     -- Applied outside the window, so the LAG above saw the movement that really preceded
     -- this one rather than the first one that happens to fall inside the period.
     WHERE d."movementDate" >= ${period.fromDate}::date
       AND d."movementDate" <= ${period.toDate}::date
     GROUP BY p."id", p."sku", p."nameAr", cat."nameAr"
     ORDER BY COUNT(*) DESC, p."sku"
     LIMIT ${period.limit ?? 200}
  `;

  return rows.map((row) => ({
    productId: row.productId,
    sku: row.sku,
    nameAr: row.nameAr,
    categoryNameAr: row.categoryNameAr,
    quantityIn: row.quantityIn,
    quantityOut: row.quantityOut,
    netQuantity: row.netQuantity,
    valueIn: Money.of(row.valueIn, period.currency).toString(),
    valueOut: Money.of(row.valueOut, period.currency).toString(),
    movementCount: Number(row.movementCount),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
//  Slow-moving stock
// ─────────────────────────────────────────────────────────────────────────────

export interface SlowMovingRow {
  readonly productId: string;
  readonly sku: string;
  readonly nameAr: string;
  readonly categoryNameAr: string | null;
  readonly quantityOnHand: string;
  readonly stockValue: string;
  /** `null` means never issued — which is the strongest finding, not a missing value. */
  readonly lastIssueDate: string | null;
  readonly daysSinceIssue: number | null;
}

/**
 * Stock on hand that has not been issued for at least `thresholdDays`.
 *
 * ## Never issued and long-ago issued are both slow, and NULL is why this needs care
 *
 * A product holding stock with no issue history at all has never sold once — the strongest case
 * on the report. A plain `WHERE last_issue < cutoff` drops exactly those rows, because NULL
 * fails every comparison. The predicate tests for the NULL explicitly, and `daysSinceIssue`
 * stays `null` rather than becoming a large number, so the screen can say "لم يُصرف مطلقاً"
 * instead of implying a date it does not have.
 *
 * ## Only issues count as movement
 *
 * Receiving stock is not evidence that it sells. A product restocked last week and never issued
 * is more of a problem, not less — so only outbound movements (`OUT`) reset the clock.
 */
export async function getSlowMovingStock(input: {
  tenantId: string;
  asOf: Date;
  thresholdDays: number;
  warehouseId?: string;
  currency: string;
  limit?: number;
}): Promise<SlowMovingRow[]> {
  const rows = await prisma.$queryRaw<
    {
      productId: string;
      sku: string;
      nameAr: string;
      categoryNameAr: string | null;
      quantityOnHand: string;
      stockValue: string;
      lastIssueDate: Date | null;
      daysSinceIssue: number | null;
    }[]
  >`
    WITH balances AS (
      SELECT s."productId",
             SUM(s."quantityOnHand") AS "quantityOnHand",
             SUM(s."totalValue")     AS "stockValue"
        FROM "stock_levels" s
       WHERE s."tenantId" = ${input.tenantId}::uuid
         AND (${input.warehouseId ?? null}::uuid IS NULL
              OR s."warehouseId" = ${input.warehouseId ?? null}::uuid)
       GROUP BY s."productId"
      HAVING SUM(s."quantityOnHand") > 0
    ),
    last_issue AS (
      SELECT m."productId", MAX(m."movementDate") AS "lastIssueDate"
        FROM "inventory_movements" m
       WHERE m."tenantId" = ${input.tenantId}::uuid
         AND m."type" = 'OUT'
         AND m."movementDate" <= ${input.asOf}::date
         AND (${input.warehouseId ?? null}::uuid IS NULL
              OR m."warehouseId" = ${input.warehouseId ?? null}::uuid)
       GROUP BY m."productId"
    )
    SELECT p."id"       AS "productId",
           p."sku",
           p."nameAr",
           cat."nameAr" AS "categoryNameAr",
           b."quantityOnHand"::text,
           b."stockValue"::text,
           li."lastIssueDate",
           CASE WHEN li."lastIssueDate" IS NULL THEN NULL
                ELSE (${input.asOf}::date - li."lastIssueDate")::int
           END AS "daysSinceIssue"
      FROM balances b
      JOIN "products" p ON p."id" = b."productId"
      LEFT JOIN "categories" cat ON cat."id" = p."categoryId"
      LEFT JOIN last_issue li ON li."productId" = b."productId"
     -- The NULL branch is explicit and load-bearing: those are the never-sold products, and
     -- a comparison alone would silently drop every one of them.
     WHERE li."lastIssueDate" IS NULL
        OR li."lastIssueDate" < (${input.asOf}::date - ${input.thresholdDays}::int)
     ORDER BY b."stockValue" DESC
     LIMIT ${input.limit ?? 200}
  `;

  return rows.map((row) => ({
    productId: row.productId,
    sku: row.sku,
    nameAr: row.nameAr,
    categoryNameAr: row.categoryNameAr,
    quantityOnHand: row.quantityOnHand,
    stockValue: Money.of(row.stockValue, input.currency).toString(),
    lastIssueDate: row.lastIssueDate?.toISOString().slice(0, 10) ?? null,
    daysSinceIssue: row.daysSinceIssue,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
//  Sales and purchase analysis
// ─────────────────────────────────────────────────────────────────────────────

export interface CounterpartySalesRow {
  readonly counterpartyId: string;
  readonly code: string;
  readonly nameAr: string;
  readonly invoiceCount: number;
  readonly netSales: string;
  readonly taxTotal: string;
  readonly grossSales: string;
}

/**
 * Sales by customer, or purchases by supplier — one query read from either side.
 *
 * ## Credit notes net off rather than appearing separately
 *
 * A credit note against a posted invoice reduces it. A customer with a million in invoices and
 * nine hundred thousand in returns has bought a hundred thousand, and a report showing the
 * first figure is worse than no report at all. So the note's amounts are subtracted.
 *
 * ## Drafts are excluded, and so are voids
 *
 * A draft invoice is a proposal and a void one was cancelled. Neither is a sale. This matches
 * every other report in this file, which is the point — a figure here has to agree with the
 * income statement or one of them is lying.
 */
export async function getSalesByCounterparty(
  period: ReportPeriod & { direction: 'SALES' | 'PURCHASES'; limit?: number },
): Promise<CounterpartySalesRow[]> {
  const invoiceType = period.direction === 'SALES' ? 'SALES_INVOICE' : 'PURCHASE_INVOICE';
  const creditType = period.direction === 'SALES' ? 'SALES_CREDIT_NOTE' : 'PURCHASE_DEBIT_NOTE';

  const rows = await prisma.$queryRaw<
    {
      counterpartyId: string;
      code: string;
      nameAr: string;
      invoiceCount: bigint;
      netSales: string;
      taxTotal: string;
      grossSales: string;
    }[]
  >`
    SELECT c."id"     AS "counterpartyId",
           c."code",
           c."nameAr",
           COUNT(*) FILTER (WHERE d."type"::text = ${invoiceType}) AS "invoiceCount",
           COALESCE(SUM(CASE WHEN d."type"::text = ${invoiceType}
                             THEN d."subtotal" - d."discountTotal"
                             ELSE -(d."subtotal" - d."discountTotal") END), 0)::text AS "netSales",
           COALESCE(SUM(CASE WHEN d."type"::text = ${invoiceType}
                             THEN d."taxTotal" ELSE -d."taxTotal" END), 0)::text     AS "taxTotal",
           COALESCE(SUM(CASE WHEN d."type"::text = ${invoiceType}
                             THEN d."total" ELSE -d."total" END), 0)::text           AS "grossSales"
      FROM "documents" d
      JOIN "counterparties" c ON c."id" = d."counterpartyId"
     WHERE d."tenantId" = ${period.tenantId}::uuid
       AND d."type"::text IN (${invoiceType}, ${creditType})
       AND d."status"::text NOT IN ('DRAFT', 'PENDING_APPROVAL', 'VOID')
       AND d."issueDate" >= ${period.fromDate}::date
       AND d."issueDate" <= ${period.toDate}::date
       AND (${period.branchId ?? null}::uuid IS NULL
            OR d."branchId" = ${period.branchId ?? null}::uuid)
     GROUP BY c."id", c."code", c."nameAr"
     ORDER BY 7 DESC
     LIMIT ${period.limit ?? 100}
  `;

  return rows.map((row) => ({
    counterpartyId: row.counterpartyId,
    code: row.code,
    nameAr: row.nameAr,
    invoiceCount: Number(row.invoiceCount),
    netSales: Money.of(row.netSales, period.currency).toString(),
    taxTotal: Money.of(row.taxTotal, period.currency).toString(),
    grossSales: Money.of(row.grossSales, period.currency).toString(),
  }));
}

export interface ProductSalesRow {
  readonly productId: string;
  readonly sku: string;
  readonly nameAr: string;
  readonly categoryNameAr: string | null;
  readonly quantitySold: string;
  readonly netSales: string;
  /** What the sold goods actually cost, from the movements — not the product's standard cost. */
  readonly cost: string;
  readonly margin: string;
  /** `null`, never `'0'`, when nothing sold. See the note on the function. */
  readonly marginPercent: string | null;
}

/**
 * Sales by product, with the margin on each. Also serves the profit-margin screen.
 *
 * ## The cost is what was consumed, not `products.costPrice`
 *
 * `costPrice` is a standard cost — a planning figure that is whatever somebody last typed into
 * the product form. The cost of what actually sold is on the inventory movements the invoice
 * generated, valued at the cost layers consumed at the time. Using the standard cost would give
 * a margin that changes retroactively every time that field is edited, including for periods
 * already reported on.
 *
 * ## A margin percentage on zero sales is undefined, not zero
 *
 * `null` says so. Returning `0` would sort a product that sold nothing next to one that sold at
 * exactly cost, and those are opposite findings. `getIncomeStatement` applies the same rule.
 *
 * ## Cost is protected data
 *
 * This returns cost and margin; the caller checks the `costPrice` field grant and drops the
 * columns without it. Same arrangement as `getInventoryValuation`.
 */
export async function getSalesByProduct(
  period: ReportPeriod & { limit?: number },
): Promise<ProductSalesRow[]> {
  const rows = await prisma.$queryRaw<
    {
      productId: string;
      sku: string;
      nameAr: string;
      categoryNameAr: string | null;
      quantitySold: string;
      netSales: string;
      cost: string;
    }[]
  >`
    WITH sold AS (
      SELECT dl."productId",
             SUM(CASE WHEN d."type"::text = 'SALES_INVOICE' THEN dl."quantity"
                      ELSE -dl."quantity" END)  AS "quantitySold",
             SUM(CASE WHEN d."type"::text = 'SALES_INVOICE' THEN dl."lineTotal"
                      ELSE -dl."lineTotal" END) AS "netSales"
        FROM "document_lines" dl
        JOIN "documents" d ON d."id" = dl."documentId"
       WHERE d."tenantId" = ${period.tenantId}::uuid
         AND d."type"::text IN ('SALES_INVOICE', 'SALES_CREDIT_NOTE')
         AND d."status"::text NOT IN ('DRAFT', 'PENDING_APPROVAL', 'VOID')
         AND d."issueDate" >= ${period.fromDate}::date
         AND d."issueDate" <= ${period.toDate}::date
         AND (${period.branchId ?? null}::uuid IS NULL
              OR d."branchId" = ${period.branchId ?? null}::uuid)
       GROUP BY dl."productId"
    ),
    -- What the goods cost, from the movements: an OUT is an issue, a RETURN came back.
    costs AS (
      SELECT m."productId",
             SUM(CASE WHEN m."type" = 'OUT' THEN m."totalCost"
                      ELSE -m."totalCost" END) AS "cost"
        FROM "inventory_movements" m
       WHERE m."tenantId" = ${period.tenantId}::uuid
         AND m."type" IN ('OUT', 'RETURN')
         AND m."movementDate" >= ${period.fromDate}::date
         AND m."movementDate" <= ${period.toDate}::date
       GROUP BY m."productId"
    )
    SELECT p."id"       AS "productId",
           p."sku",
           p."nameAr",
           cat."nameAr" AS "categoryNameAr",
           s."quantitySold"::text,
           s."netSales"::text,
           COALESCE(co."cost", 0)::text AS "cost"
      FROM sold s
      JOIN "products" p ON p."id" = s."productId"
      LEFT JOIN "categories" cat ON cat."id" = p."categoryId"
      LEFT JOIN costs co ON co."productId" = s."productId"
     ORDER BY s."netSales" DESC
     LIMIT ${period.limit ?? 200}
  `;

  return rows.map((row) => {
    const net = Money.of(row.netSales, period.currency);
    const cost = Money.of(row.cost, period.currency);
    const margin = net.subtract(cost);

    return {
      productId: row.productId,
      sku: row.sku,
      nameAr: row.nameAr,
      categoryNameAr: row.categoryNameAr,
      quantitySold: row.quantitySold,
      netSales: net.toString(),
      cost: cost.toString(),
      margin: margin.toString(),
      marginPercent: net.isZero
        ? null
        : ((Number(margin.toString()) / Number(net.toString())) * 100).toFixed(2),
    };
  });
}
