import { Prisma } from '@prisma/client';
import { DomainErrors, type DomainError } from '@/lib/domain/shared/errors';
import { err, ok, type Result } from '@/lib/domain/shared/result';
import { withTenantRead } from '@/lib/infrastructure/db/prisma';

/**
 * Customers and suppliers.
 *
 * One service, because they are one table. `Counterparty` carries a `type` of CUSTOMER,
 * SUPPLIER or BOTH, and the alternative — two services over two filtered views of one model —
 * is how a codebase ends up with two implementations of "outstanding balance" that disagree.
 *
 * `BOTH` is why the filter is `IN (X, BOTH)` rather than `= X`. An entity that both buys and
 * sells is common in trading, and a customer register that hid them would understate
 * receivables in exactly the accounts most likely to be netted off.
 *
 * ## Ageing is computed in SQL
 *
 * The bucket boundaries are arithmetic over `dueDate`, and doing it in PostgreSQL means one
 * indexed pass rather than loading every open document into memory to sort into five buckets.
 * It also keeps the money in `numeric` the whole way: the outstanding figure never becomes a
 * JavaScript number, which is the rule the whole money design rests on.
 */

export type CounterpartyKind = 'CUSTOMER' | 'SUPPLIER';

export interface CounterpartyRow {
  readonly id: string;
  readonly code: string;
  readonly type: string;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly taxNumber: string | null;
  readonly classification: string;
  readonly paymentTerms: number;
  readonly currency: string;
  readonly creditLimit: string;
  readonly balance: string;
  readonly isActive: boolean;
  readonly openDocuments: number;
}

export interface AgeingBuckets {
  readonly current: string;
  readonly days30: string;
  readonly days60: string;
  readonly days90: string;
  readonly over90: string;
  readonly total: string;
}

/** The `type` values that belong in a register of `kind`. */
function typesFor(kind: CounterpartyKind): Prisma.CounterpartyWhereInput['type'] {
  return { in: kind === 'CUSTOMER' ? ['CUSTOMER', 'BOTH'] : ['SUPPLIER', 'BOTH'] };
}

/** The document types that make up this side's exposure. */
function documentTypesFor(kind: CounterpartyKind): Prisma.DocumentWhereInput['type'] {
  return kind === 'CUSTOMER'
    ? { in: ['SALES_INVOICE', 'SALES_CREDIT_NOTE'] }
    : { in: ['PURCHASE_INVOICE', 'PURCHASE_DEBIT_NOTE'] };
}

export async function listCounterparties(input: {
  tenantId: string;
  kind: CounterpartyKind;
  query?: string;
  status?: 'ACTIVE' | 'INACTIVE' | 'ALL';
  page: number;
  pageSize: number;
}): Promise<{ rows: CounterpartyRow[]; total: number }> {
  const status = input.status ?? 'ACTIVE';
  const query = input.query?.trim();

  const where: Prisma.CounterpartyWhereInput = {
    tenantId: input.tenantId,
    type: typesFor(input.kind),
    ...(status === 'ACTIVE' ? { isActive: true } : status === 'INACTIVE' ? { isActive: false } : {}),
    ...(query !== undefined && query !== ''
      ? {
          OR: [
            { code: { contains: query, mode: 'insensitive' } },
            { nameAr: { contains: query, mode: 'insensitive' } },
            { nameEn: { contains: query, mode: 'insensitive' } },
            { taxNumber: { contains: query } },
            { phone: { contains: query } },
          ],
        }
      : {}),
  };

  return withTenantRead(async (tx) => {
    const [rows, total] = await Promise.all([
      tx.counterparty.findMany({
        where,
        select: {
          id: true,
          code: true,
          type: true,
          nameAr: true,
          nameEn: true,
          phone: true,
          email: true,
          taxNumber: true,
          classification: true,
          paymentTerms: true,
          currency: true,
          creditLimit: true,
          balance: true,
          isActive: true,
          _count: {
            select: {
              documents: {
                where: {
                  type: documentTypesFor(input.kind),
                  status: { in: ['POSTED', 'PARTIAL_PAID'] },
                },
              },
            },
          },
        },
        orderBy: { code: 'asc' },
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
      }),
      tx.counterparty.count({ where }),
    ]);

    return {
      rows: rows.map((row) => ({
        id: row.id,
        code: row.code,
        type: row.type,
        nameAr: row.nameAr,
        nameEn: row.nameEn,
        phone: row.phone,
        email: row.email,
        taxNumber: row.taxNumber,
        classification: row.classification,
        paymentTerms: row.paymentTerms,
        currency: row.currency,
        creditLimit: row.creditLimit.toString(),
        balance: row.balance.toString(),
        isActive: row.isActive,
        openDocuments: row._count.documents,
      })),
      total,
    };
  });
}

export interface CounterpartyCard {
  readonly counterparty: CounterpartyRow & { readonly addressJson: unknown; readonly crn: string | null };
  readonly ageing: AgeingBuckets;
  readonly openDocuments: readonly {
    id: string;
    documentNumber: string;
    type: string;
    issueDate: string;
    dueDate: string;
    currency: string;
    total: string;
    paidAmount: string;
    outstanding: string;
    overdueDays: number;
  }[];
  readonly recentPayments: readonly {
    id: string;
    voucherNumber: string;
    type: string;
    paymentDate: string;
    amount: string;
    currency: string;
    method: string;
  }[];
}

export async function getCounterpartyCard(input: {
  tenantId: string;
  counterpartyId: string;
  kind: CounterpartyKind;
}): Promise<Result<CounterpartyCard, DomainError>> {
  return withTenantRead(async (tx) => {
    const row = await tx.counterparty.findFirst({
      where: {
        id: input.counterpartyId,
        tenantId: input.tenantId,
        type: typesFor(input.kind),
      },
      select: {
        id: true,
        code: true,
        type: true,
        nameAr: true,
        nameEn: true,
        phone: true,
        email: true,
        taxNumber: true,
        crn: true,
        addressJson: true,
        classification: true,
        paymentTerms: true,
        currency: true,
        creditLimit: true,
        balance: true,
        isActive: true,
      },
    });

    if (row === null) {
      return err(
        DomainErrors.notFound(
          input.kind === 'CUSTOMER' ? 'العميل' : 'المورد',
          input.kind === 'CUSTOMER' ? 'Customer' : 'Supplier',
          input.counterpartyId,
        ),
      );
    }

    const documentTypes =
      input.kind === 'CUSTOMER'
        ? ['SALES_INVOICE', 'SALES_CREDIT_NOTE']
        : ['PURCHASE_INVOICE', 'PURCHASE_DEBIT_NOTE'];

    const [openDocuments, ageingRows, payments] = await Promise.all([
      tx.$queryRaw<
        {
          id: string;
          documentNumber: string;
          type: string;
          issueDate: Date;
          dueDate: Date;
          currency: string;
          total: string;
          paidAmount: string;
          outstanding: string;
          overdueDays: number;
        }[]
      >`
        SELECT d."id",
               d."documentNumber",
               d."type"::text                      AS "type",
               d."issueDate",
               d."dueDate",
               d."currency",
               d."total"::text                     AS "total",
               d."paidAmount"::text                AS "paidAmount",
               (d."total" - d."paidAmount")::text  AS "outstanding",
               GREATEST(0, (CURRENT_DATE - d."dueDate"))::int AS "overdueDays"
          FROM "documents" d
         WHERE d."tenantId" = ${input.tenantId}::uuid
           AND d."counterpartyId" = ${input.counterpartyId}::uuid
           AND d."type"::text = ANY (${documentTypes}::text[])
           AND d."status"::text IN ('POSTED', 'PARTIAL_PAID')
           AND d."total" > d."paidAmount"
         ORDER BY d."dueDate" ASC
         LIMIT 100
      `,
      // Five buckets in one pass. Computed from `dueDate` against today, which is the
      // convention an ageing report is read under — days past due, not days since issue.
      tx.$queryRaw<
        { bucket: string; amount: string }[]
      >`
        SELECT CASE
                 WHEN CURRENT_DATE <= d."dueDate"                       THEN 'current'
                 WHEN CURRENT_DATE - d."dueDate" <= 30                  THEN 'days30'
                 WHEN CURRENT_DATE - d."dueDate" <= 60                  THEN 'days60'
                 WHEN CURRENT_DATE - d."dueDate" <= 90                  THEN 'days90'
                 ELSE 'over90'
               END AS bucket,
               SUM(d."total" - d."paidAmount")::text AS amount
          FROM "documents" d
         WHERE d."tenantId" = ${input.tenantId}::uuid
           AND d."counterpartyId" = ${input.counterpartyId}::uuid
           AND d."type"::text = ANY (${documentTypes}::text[])
           AND d."status"::text IN ('POSTED', 'PARTIAL_PAID')
           AND d."total" > d."paidAmount"
         GROUP BY 1
      `,
      tx.payment.findMany({
        where: { tenantId: input.tenantId, counterpartyId: input.counterpartyId },
        select: {
          id: true,
          voucherNumber: true,
          type: true,
          paymentDate: true,
          amount: true,
          currency: true,
          method: true,
        },
        orderBy: [{ paymentDate: 'desc' }, { voucherNumber: 'desc' }],
        take: 10,
      }),
    ]);

    const buckets = new Map(ageingRows.map((bucket) => [bucket.bucket, bucket.amount]));
    const pick = (key: string): string => buckets.get(key) ?? '0';

    // Summed with `Prisma.Decimal` rather than `Number`, so a hundred open invoices do not
    // accumulate a floating-point error into the one figure a credit controller acts on.
    const total = ageingRows.reduce(
      (sum, bucket) => sum.plus(new Prisma.Decimal(bucket.amount)),
      new Prisma.Decimal(0),
    );

    const openCount = await tx.document.count({
      where: {
        tenantId: input.tenantId,
        counterpartyId: input.counterpartyId,
        type: documentTypesFor(input.kind),
        status: { in: ['POSTED', 'PARTIAL_PAID'] },
      },
    });

    return ok({
      counterparty: {
        id: row.id,
        code: row.code,
        type: row.type,
        nameAr: row.nameAr,
        nameEn: row.nameEn,
        phone: row.phone,
        email: row.email,
        taxNumber: row.taxNumber,
        crn: row.crn,
        addressJson: row.addressJson,
        classification: row.classification,
        paymentTerms: row.paymentTerms,
        currency: row.currency,
        creditLimit: row.creditLimit.toString(),
        balance: row.balance.toString(),
        isActive: row.isActive,
        openDocuments: openCount,
      },
      ageing: {
        current: pick('current'),
        days30: pick('days30'),
        days60: pick('days60'),
        days90: pick('days90'),
        over90: pick('over90'),
        total: total.toString(),
      },
      openDocuments: openDocuments.map((document) => ({
        id: document.id,
        documentNumber: document.documentNumber,
        type: document.type,
        issueDate: document.issueDate.toISOString().slice(0, 10),
        dueDate: document.dueDate.toISOString().slice(0, 10),
        currency: document.currency,
        total: document.total,
        paidAmount: document.paidAmount,
        outstanding: document.outstanding,
        overdueDays: document.overdueDays,
      })),
      recentPayments: payments.map((payment) => ({
        id: payment.id,
        voucherNumber: payment.voucherNumber,
        type: payment.type,
        paymentDate: payment.paymentDate.toISOString().slice(0, 10),
        amount: payment.amount.toString(),
        currency: payment.currency,
        method: payment.method,
      })),
    });
  });
}
