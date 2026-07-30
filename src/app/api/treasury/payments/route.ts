import type { PaymentType } from '@prisma/client';
import { z } from 'zod';
import { apiHandler, paginated, parsePagination } from '@/lib/api/handler';
import { DomainErrors } from '@/lib/domain/shared/errors';
import { err, ok } from '@/lib/domain/shared/result';
import { recordPayment } from '@/lib/application/use-cases/record-payment';
import { withTenantRead } from '@/lib/infrastructure/db/prisma';

/**
 * Receipt and payment vouchers.
 *
 * `recordPayment` has existed since the first commit, fully tested, with nothing calling it
 * from the outside. This is the missing seam, and it is deliberately thin: every rule about
 * what a voucher may do — that an allocation cannot exceed what a document still owes, that
 * the exchange rate is resolved once, that the journal balances — lives in the use case and
 * in the database, not here. A route that re-checked any of it would be a second opinion
 * that can disagree with the first.
 *
 * Idempotent-keyed, because a voucher is the one document a user is most likely to submit
 * twice: it is short, it is quick, and the reflex on a slow network is to click again. A
 * duplicated receipt shows a customer as having paid twice and has to be reversed.
 */

const allocationSchema = z.object({
  documentId: z.string().uuid(),
  amount: z.string().regex(/^\d+(\.\d{1,4})?$/),
});

const createVoucherSchema = z.object({
  type: z.enum(['RECEIPT', 'PAYMENT']),
  counterpartyId: z.string().uuid(),
  branchId: z.string().uuid(),
  paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount: z.string().regex(/^\d+(\.\d{1,4})?$/),
  currency: z.string().length(3),
  exchangeRate: z.string().optional(),
  // Mirrors the `PaymentMethod` enum exactly. There is no TRANSFER: a wire is a BANK
  // movement with a `bankReference`, and adding a fifth value the database does not have
  // would fail at the insert rather than at the boundary.
  method: z.enum(['CASH', 'BANK', 'CHECK', 'CARD']),
  accountId: z.string().uuid(),
  checkNumber: z.string().trim().max(64).optional(),
  checkDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  bankReference: z.string().trim().max(128).optional(),
  notes: z.string().trim().max(512).optional(),
  // An empty array is legitimate: an advance from a customer settles nothing yet, and
  // `recordPayment` carries it as unallocated rather than refusing it.
  allocations: z.array(allocationSchema).max(100).default([]),
});

export const GET = apiHandler(
  async (context, request) => {
    const { page, pageSize, skip } = parsePagination(request);
    const url = new URL(request.url);
    const type = url.searchParams.get('type');
    const status = url.searchParams.get('status');

    const where = {
      tenantId: context.tenantId,
      ...(type === 'RECEIPT' || type === 'PAYMENT' ? { type: type as PaymentType } : {}),
      ...(status !== null && status !== 'ALL' ? { status: status as never } : {}),
    };

    const { vouchers, total } = await withTenantRead(async (tx) => ({
      vouchers: await tx.payment.findMany({
        where,
        select: {
          id: true,
          voucherNumber: true,
          type: true,
          status: true,
          paymentDate: true,
          amount: true,
          currency: true,
          method: true,
          unallocatedAmount: true,
          counterparty: { select: { code: true, nameAr: true } },
          account: { select: { code: true, nameAr: true } },
          branch: { select: { nameAr: true } },
        },
        orderBy: [{ paymentDate: 'desc' }, { voucherNumber: 'desc' }],
        skip,
        take: pageSize,
      }),
      total: await tx.payment.count({ where }),
    }));

    return ok(paginated(vouchers, total, { page, pageSize }));
  },
  { permission: { resource: 'treasury.payment', action: 'read' } },
);

export const POST = apiHandler(
  async (context, request) => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return err(DomainErrors.validation('صيغة الطلب غير صحيحة.', 'Malformed request body.'));
    }

    const parsed = createVoucherSchema.safeParse(body);

    if (!parsed.success) {
      // `issues[0].path` rather than indexing the flattened record: the flattened shape is
      // keyed by the schema's literal field names, so a string index into it is not typed.
      const first = parsed.error.issues[0];
      const field = first?.path[0];
      const detail = first?.message;

      // The offending field is named, so the form can mark the input rather than showing a
      // banner that leaves the user hunting for which of fourteen fields it meant.
      return err(
        DomainErrors.validation(
          'بيانات السند غير مكتملة أو غير صحيحة.',
          detail ?? 'The voucher payload is invalid.',
          typeof field === 'string' ? field : undefined,
        ),
      );
    }

    // `recordPayment` checks the permission itself, from the context, which is why it is not
    // duplicated in the handler options here — one authority for one question.
    return recordPayment(context, parsed.data);
  },
  { rateLimit: 'mutation', idempotent: true },
);
