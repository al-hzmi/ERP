import { z } from 'zod';
import { apiHandler } from '@/lib/api/handler';
import { DomainErrors } from '@/lib/domain/shared/errors';
import { err, ok } from '@/lib/domain/shared/result';
import { withTenantRead } from '@/lib/infrastructure/db/prisma';

/**
 * What a counterparty still owes, or is still owed.
 *
 * The allocation grid on the voucher form needs this and nothing else. Two decisions worth
 * naming:
 *
 * **`outstanding` is computed here, not sent as two numbers to subtract in the browser.**
 * `total − paidAmount` in JavaScript is a subtraction of two floats parsed from strings, and
 * the whole money design exists to keep that from happening. PostgreSQL does it in
 * `numeric` and the result crosses the wire as a string.
 *
 * **The direction is derived from the voucher type, not asked for.** A receipt settles what a
 * customer owes us (sales invoices); a payment settles what we owe a supplier (purchase
 * invoices). Offering the wrong set is how a receipt gets allocated against a purchase
 * invoice, which balances arithmetically and is nonsense.
 */

/**
 * What each voucher direction settles.
 *
 * Invoices only. The two note types — `SALES_CREDIT_NOTE` and `PURCHASE_DEBIT_NOTE` — reduce a
 * balance rather than create one, so they are not settled *by* a payment; applying a receipt
 * to a credit note would be settling a debt that runs the other way. Netting a note against an
 * invoice is a separate operation with its own accounting, and offering it here disguised as
 * an allocation would produce entries nobody could explain.
 *
 * An earlier version of this listed `DEBIT_NOTE` and `CREDIT_NOTE`, which are not values of
 * `DocumentType` at all. The comparison is on `::text`, so those never matched anything and
 * never errored — the wrong kind of bug: silent, and invisible until someone wondered why a
 * note never appeared.
 */
const RECEIVABLE_TYPES = ['SALES_INVOICE'] as const;
const PAYABLE_TYPES = ['PURCHASE_INVOICE'] as const;

export const GET = apiHandler(
  async (context, request) => {
    const url = new URL(request.url);

    const counterpartyId = z.string().uuid().safeParse(url.searchParams.get('counterpartyId'));
    if (!counterpartyId.success) {
      return err(
        DomainErrors.validation(
          'يجب تحديد العميل أو المورد أولاً.',
          'A valid counterpartyId is required.',
          'counterpartyId',
        ),
      );
    }

    const type = z.enum(['RECEIPT', 'PAYMENT']).safeParse(url.searchParams.get('type'));
    if (!type.success) {
      return err(
        DomainErrors.validation(
          'نوع السند يجب أن يكون قبضاً أو صرفاً.',
          'type must be RECEIPT or PAYMENT.',
          'type',
        ),
      );
    }

    const documentTypes = type.data === 'RECEIPT' ? RECEIVABLE_TYPES : PAYABLE_TYPES;

    const documents = await withTenantRead((tx) =>
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
        }[]
      >`
        SELECT d."id",
               d."documentNumber",
               d."type"::text            AS "type",
               d."issueDate",
               d."dueDate",
               d."currency",
               d."total"::text           AS "total",
               d."paidAmount"::text      AS "paidAmount",
               (d."total" - d."paidAmount")::text AS "outstanding"
          FROM "documents" d
         WHERE d."tenantId" = ${context.tenantId}::uuid
           AND d."counterpartyId" = ${counterpartyId.data}::uuid
           AND d."type"::text = ANY (${[...documentTypes]}::text[])
           -- Posted or part-settled only. A draft is not a liability yet, and a void one never
           -- was; offering either would let a voucher settle something that does not exist.
           AND d."status"::text IN ('POSTED', 'PARTIAL_PAID')
           AND d."total" > d."paidAmount"
         ORDER BY d."dueDate" ASC, d."documentNumber" ASC
         LIMIT 200
      `,
    );

    return ok({
      items: documents.map((document) => ({
        id: document.id,
        documentNumber: document.documentNumber,
        type: document.type,
        issueDate: document.issueDate.toISOString().slice(0, 10),
        dueDate: document.dueDate.toISOString().slice(0, 10),
        currency: document.currency,
        total: document.total,
        paidAmount: document.paidAmount,
        outstanding: document.outstanding,
      })),
    });
  },
  { permission: { resource: 'treasury.payment', action: 'read' } },
);
