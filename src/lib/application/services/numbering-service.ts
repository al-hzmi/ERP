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
  | 'FIXED_ASSET';

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
