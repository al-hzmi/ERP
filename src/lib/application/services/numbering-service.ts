import type { TransactionClient } from '@/lib/infrastructure/db/prisma';

/**
 * Sequential document numbering.
 *
 * Delegates to the `erp_next_document_number` SQL function, which locks the
 * counter row for the duration of the transaction. Two concurrent invoices
 * therefore serialise on that row and cannot receive the same number, which a
 * `SELECT MAX(...) + 1` in application code would cheerfully allow.
 *
 * Numbers are consumed, never returned. Deleting a draft leaves a permanent gap,
 * because a sequence that renumbers itself is a sequence an auditor cannot use.
 */

export type SequenceKey =
  | 'SALES_INVOICE'
  | 'PURCHASE_INVOICE'
  | 'SALES_CREDIT_NOTE'
  | 'PURCHASE_DEBIT_NOTE'
  | 'JOURNAL'
  | 'RECEIPT_VOUCHER'
  | 'PAYMENT_VOUCHER'
  | 'INVENTORY_MOVEMENT'
  | 'STOCK_TRANSFER'
  | 'PAYROLL_RUN'
  | 'FIXED_ASSET'
  | 'QUOTATION'
  | 'SALES_ORDER'
  | 'PURCHASE_ORDER'
  | 'SALES_RETURN'
  | 'ASSEMBLY_ORDER';

interface SeriesDefinition {
  readonly prefix: string;
  readonly padding: number;
}

/** Prefixes an accountant will recognise on sight, without a legend. */
const SERIES: Record<SequenceKey, SeriesDefinition> = {
  SALES_INVOICE: { prefix: 'INV', padding: 5 },
  PURCHASE_INVOICE: { prefix: 'PINV', padding: 5 },
  SALES_CREDIT_NOTE: { prefix: 'CN', padding: 5 },
  PURCHASE_DEBIT_NOTE: { prefix: 'DN', padding: 5 },
  JOURNAL: { prefix: 'JE', padding: 5 },
  RECEIPT_VOUCHER: { prefix: 'RV', padding: 5 },
  PAYMENT_VOUCHER: { prefix: 'PV', padding: 5 },
  INVENTORY_MOVEMENT: { prefix: 'MOV', padding: 6 },
  STOCK_TRANSFER: { prefix: 'TRF', padding: 5 },
  PAYROLL_RUN: { prefix: 'PR', padding: 4 },
  FIXED_ASSET: { prefix: 'FA', padding: 4 },
  QUOTATION: { prefix: 'QT', padding: 5 },
  SALES_ORDER: { prefix: 'SO', padding: 5 },
  PURCHASE_ORDER: { prefix: 'PO', padding: 5 },
  SALES_RETURN: { prefix: 'SR', padding: 5 },
  ASSEMBLY_ORDER: { prefix: 'ASM', padding: 5 },
};

/**
 * Allocates the next number in a series.
 *
 * Must be called inside a transaction: the counter increment and the document
 * insert have to commit or roll back together, or a rolled-back document burns
 * a number for no reason.
 */
export async function allocateDocumentNumber(
  tx: TransactionClient,
  tenantId: string,
  key: SequenceKey,
  year: number,
): Promise<string> {
  const series = SERIES[key];

  const rows = await tx.$queryRaw<{ number: string }[]>`
    SELECT erp_next_document_number(
      ${tenantId}::uuid,
      ${key}::text,
      ${year}::int,
      ${series.prefix}::text,
      ${series.padding}::int
    ) AS number
  `;

  const allocated = rows[0]?.number;
  if (allocated === undefined) {
    throw new Error(`Failed to allocate a number for series ${key}.`);
  }

  return allocated;
}

/**
 * Allocates several numbers from one series in a single round trip.
 * Used by the data generator, which would otherwise make 2,000 of them.
 */
export async function allocateDocumentNumbers(
  tx: TransactionClient,
  tenantId: string,
  key: SequenceKey,
  year: number,
  count: number,
): Promise<string[]> {
  if (count <= 0) return [];

  const series = SERIES[key];

  const rows = await tx.$queryRaw<{ number: string }[]>`
    SELECT erp_next_document_number(
      ${tenantId}::uuid,
      ${key}::text,
      ${year}::int,
      ${series.prefix}::text,
      ${series.padding}::int
    ) AS number
    FROM generate_series(1, ${count}::int)
  `;

  return rows.map((row) => row.number);
}

/** Peeks at the next number without consuming it — for a form's preview field. */
export async function peekNextDocumentNumber(
  tx: TransactionClient,
  tenantId: string,
  key: SequenceKey,
  year: number,
): Promise<string> {
  const series = SERIES[key];

  const sequence = await tx.numberSequence.findUnique({
    where: { tenantId_key_year: { tenantId, key, year } },
    select: { nextValue: true, prefix: true, padding: true },
  });

  const next = sequence?.nextValue ?? 1n;
  const prefix = sequence?.prefix ?? series.prefix;
  const padding = sequence?.padding ?? series.padding;

  return `${prefix}-${year}-${next.toString().padStart(padding, '0')}`;
}

/**
 * Allocates the next ZATCA Invoice Counter Value for a tenant.
 *
 * ICV is a bare integer, not a formatted document number, and it must not reset — ZATCA reads a
 * discontinuity in it as an invoice that was issued and then hidden. So it is stored under the
 * sentinel year `0`, which no real fiscal year uses, and therefore never rolls over on the 1st
 * of January the way `INV-2026-00001` does.
 *
 * It goes through `erp_next_document_number` rather than `SELECT count(*) + 1` for the reason
 * that function exists: the count is read outside any lock, so two invoices posted in the same
 * instant would both compute the same next value, and the unique index would then reject one of
 * them *after* the accounting entries had been written.
 */
export async function allocateInvoiceCounterValue(
  tx: TransactionClient,
  tenantId: string,
): Promise<bigint> {
  const rows = await tx.$queryRaw<{ number: string }[]>`
    SELECT erp_next_document_number(
      ${tenantId}::uuid,
      'ZATCA_ICV'::text,
      0::int,
      'ICV'::text,
      12::int
    ) AS number
  `;

  const allocated = rows[0]?.number;
  if (allocated === undefined) {
    throw new Error('Failed to allocate a ZATCA invoice counter value.');
  }

  // `ICV-0-000000000042` — the counter is the last dash-separated field.
  const counter = allocated.slice(allocated.lastIndexOf('-') + 1);
  const value = BigInt(counter);

  if (value <= 0n) {
    throw new Error(`Allocated an invalid ZATCA counter value from "${allocated}".`);
  }

  return value;
}

export interface NumberSeriesRow {
  readonly key: string;
  readonly labelAr: string;
  readonly year: number;
  readonly prefix: string;
  readonly padding: number;
  /** The number the next document will take. Read, never written from a screen — see below. */
  readonly nextValue: string;
  readonly sample: string;
  readonly issued: bigint;
}

const SERIES_LABELS_AR: Record<string, string> = {
  SALES_INVOICE: 'فواتير المبيعات',
  PURCHASE_INVOICE: 'فواتير المشتريات',
  SALES_CREDIT_NOTE: 'إشعارات دائنة',
  PURCHASE_DEBIT_NOTE: 'إشعارات مدينة',
  JOURNAL: 'قيود اليومية',
  RECEIPT_VOUCHER: 'سندات القبض',
  PAYMENT_VOUCHER: 'سندات الصرف',
  INVENTORY_MOVEMENT: 'حركات المخزون',
  STOCK_TRANSFER: 'التحويلات المخزنية',
  PAYROLL_RUN: 'مسيّرات الرواتب',
  FIXED_ASSET: 'الأصول الثابتة',
  QUOTATION: 'عروض الأسعار',
  SALES_ORDER: 'أوامر البيع',
  PURCHASE_ORDER: 'أوامر الشراء',
  SALES_RETURN: 'مرتجعات المبيعات',
  ASSEMBLY_ORDER: 'أوامر التجميع',
  ZATCA_ICV: 'عدّاد الفوترة الإلكترونية (ICV)',
};

/**
 * Every series this tenant has drawn a number from, with where each one stands.
 *
 * Read-only, and that is a design decision rather than an unfinished screen. A counter that a
 * user can set is a counter that can be set *backwards*, and the next allocation would then
 * collide with a document that already exists — the unique index would refuse the write, but
 * only after the accounting entries had been prepared. Worse, setting it forwards silently
 * creates the gap an auditor reads as a deleted invoice.
 *
 * The prefix and padding are cosmetic and could safely be editable; they are not exposed yet
 * because changing them mid-year produces two visually different numbering schemes in one
 * series, which is the kind of thing a tenant should decide deliberately rather than discover.
 */
export async function listNumberSequences(
  tx: TransactionClient,
  tenantId: string,
): Promise<NumberSeriesRow[]> {
  const rows = await tx.numberSequence.findMany({
    where: { tenantId },
    select: { key: true, year: true, prefix: true, padding: true, nextValue: true },
    orderBy: [{ key: 'asc' }, { year: 'desc' }],
  });

  return rows.map((row) => ({
    key: row.key,
    labelAr: SERIES_LABELS_AR[row.key] ?? row.key,
    year: row.year,
    prefix: row.prefix,
    padding: row.padding,
    nextValue: row.nextValue.toString(),
    sample: `${row.prefix}-${row.year}-${row.nextValue.toString().padStart(row.padding, '0')}`,
    // `nextValue` starts at 1, so the count issued is one less. A tenant that has never used a
    // series has no row at all and does not appear here.
    issued: row.nextValue - 1n,
  }));
}
