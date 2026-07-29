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
export async function getBalanceSheet(period: ReportPeriod): Promise<BalanceSheet> {
  const rows = await prisma.$queryRaw<
    { accountId: string; code: string; nameAr: string; nameEn: string; type: string; amount: string }[]
  >`
    SELECT a."id" AS "accountId", a."code", a."nameAr", a."nameEn", a."type"::text AS type,
           (CASE WHEN a."nature" = 'DEBIT'
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
     GROUP BY a."id", a."code", a."nameAr", a."nameEn", a."type", a."nature"
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
