import { z } from 'zod';
import { apiHandler, paginated, parsePagination } from '@/lib/api/handler';
import { JournalEntryDraft } from '@/lib/domain/accounting/journal-entry';
import { MANUAL_JOURNAL_TYPES } from '@/lib/domain/accounting/manual-journal';
import { DomainErrors } from '@/lib/domain/shared/errors';
import { Money } from '@/lib/domain/shared/money';
import { err, ok } from '@/lib/domain/shared/result';
import { DateOnly } from '@/lib/domain/shared/value-objects';
import { persistJournalEntry } from '@/lib/application/services/journal-service';
import { prisma, withTransaction, withTenantRead } from '@/lib/infrastructure/db/prisma';
import { eventBus } from '@/lib/infrastructure/events/event-bus';

/**
 * Manual journal entries.
 *
 * Almost everything in this ledger is posted automatically by a use case, which is
 * the design: `posting-rules.ts` derives entries from documents so that nobody
 * hand-writes a debit. This endpoint is the deliberate exception — accruals,
 * reclassifications, opening balances and corrections that no document produces.
 *
 * Because it is the one path where a human chooses both sides, it is also the one
 * that needs the most refusing. `JournalEntryDraft.validate()` is not a formality
 * here: it is what stops an unbalanced entry, a line that is both debit and credit,
 * a zero line, and a single-sided entry, and the type system makes it impossible to
 * reach `persistJournalEntry` without having passed through it.
 */

const lineSchema = z
  .object({
    accountId: z.string().uuid(),
    debit: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
    credit: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
    descriptionAr: z.string().max(512).optional(),
    costCenterId: z.string().uuid().optional(),
    projectId: z.string().uuid().optional(),
    counterpartyId: z.string().uuid().optional(),
  })
  .refine(
    (line) => {
      const debit = Number(line.debit ?? '0');
      const credit = Number(line.credit ?? '0');
      // Exactly one side, and it must be non-zero. The domain would reject both of
      // these too; catching them here names the offending line for the form.
      return (debit > 0) !== (credit > 0);
    },
    { message: 'A line must carry either a debit or a credit, and it must be non-zero' },
  );

const createJournalSchema = z.object({
  type: z.enum(MANUAL_JOURNAL_TYPES).default('GENERAL'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  descriptionAr: z.string().trim().min(1).max(512),
  descriptionEn: z.string().trim().max(512).optional(),
  branchId: z.string().uuid().optional(),
  /** Left DRAFT unless asked, so an entry can be reviewed before it becomes history. */
  postImmediately: z.boolean().default(false),
  lines: z.array(lineSchema).min(2).max(200),
});

export const GET = apiHandler(
  async (context, request) => {
    const { page, pageSize, skip } = parsePagination(request);
    const url = new URL(request.url);
    const status = url.searchParams.get('status');

    const where = {
      tenantId: context.tenantId,
      ...(status !== null && status !== 'ALL' ? { status: status as never } : {}),
    };

    const { entries, total } = await withTenantRead(async (tx) => ({
      entries: await tx.journal.findMany({
        where,
        select: {
          id: true,
          entryNumber: true,
          type: true,
          status: true,
          date: true,
          descriptionAr: true,
          totalDebit: true,
          totalCredit: true,
        },
        orderBy: [{ date: 'desc' }, { entryNumber: 'desc' }],
        skip,
        take: pageSize,
      }),
      total: await tx.journal.count({ where }),
    }));

    return ok(paginated(entries, total, { page, pageSize }));
  },
  { permission: { resource: 'finance.journal', action: 'read' } },
);

export const POST = apiHandler(
  async (context, request) => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return err(DomainErrors.validation('صيغة الطلب غير صحيحة.', 'Malformed request body.'));
    }

    const parsed = createJournalSchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return err(
        DomainErrors.validation(
          `بيانات غير صالحة في الحقل "${issue?.path.join('.') ?? ''}".`,
          `Invalid value for "${issue?.path.join('.') ?? ''}": ${issue?.message ?? ''}`,
          issue?.path.join('.'),
        ),
      );
    }

    const input = parsed.data;

    const date = DateOnly.create(input.date);
    if (!date.ok) return date;

    // Every referenced account is loaded in one query. Checking them one line at a
    // time would make a fifty-line entry fifty round trips, and checking none of
    // them would let a line post to another tenant's account id.
    const accountIds = [...new Set(input.lines.map((line) => line.accountId))];
    const accounts = await prisma.account.findMany({
      where: { tenantId: context.tenantId, id: { in: accountIds } },
      select: { id: true, code: true, nameAr: true, isActive: true, isPostable: true },
    });

    const accountById = new Map(accounts.map((account) => [account.id, account]));

    for (const [index, line] of input.lines.entries()) {
      const account = accountById.get(line.accountId);

      if (account === undefined) {
        return err(DomainErrors.notFound('الحساب', 'Account', line.accountId));
      }
      if (!account.isActive) {
        return err(
          DomainErrors.validation(
            `البند ${index + 1}: الحساب "${account.code} — ${account.nameAr}" غير نشط.`,
            `Line ${index + 1}: account "${account.code} — ${account.nameAr}" is inactive.`,
            `lines.${index}.accountId`,
          ),
        );
      }
      // A posting to a parent account is what makes a chart of accounts stop
      // reconciling to its own subtotals.
      if (!account.isPostable) {
        return err(
          DomainErrors.validation(
            `البند ${index + 1}: الحساب "${account.code}" حساب تجميعي ولا يقبل الترحيل.`,
            `Line ${index + 1}: account "${account.code}" is a summary account and cannot be posted to.`,
            `lines.${index}.accountId`,
          ),
        );
      }
    }

    return withTransaction(async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: context.tenantId },
        select: { functionalCurrency: true },
      });

      const currency = tenant.functionalCurrency;

      // A manual entry is stated in the functional currency: a foreign-currency
      // accrual is a conversion decision, and making it implicitly here would hide
      // which rate was used from the only people who need to know.
      const draft = new JournalEntryDraft({
        tenantId: context.tenantId,
        type: input.type,
        date: date.value,
        descriptionAr: input.descriptionAr,
        ...(input.descriptionEn !== undefined ? { descriptionEn: input.descriptionEn } : {}),
        ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
        currency,
        exchangeRate: '1.000000',
        functionalCurrency: currency,
      });

      for (const line of input.lines) {
        const options = {
          ...(line.descriptionAr !== undefined ? { description: line.descriptionAr } : {}),
          ...(line.costCenterId !== undefined ? { costCenterId: line.costCenterId } : {}),
          ...(line.projectId !== undefined ? { projectId: line.projectId } : {}),
          ...(line.counterpartyId !== undefined ? { counterpartyId: line.counterpartyId } : {}),
        };

        if (line.debit !== undefined && Number(line.debit) > 0) {
          draft.debit(line.accountId, Money.of(line.debit, currency), options);
        } else {
          draft.credit(line.accountId, Money.of(line.credit ?? '0', currency), options);
        }
      }

      const validated = draft.validate();
      if (!validated.ok) return validated;

      const posted = await persistJournalEntry(tx, validated.value, {
        audit: {
          tenantId: context.tenantId,
          userId: context.userId,
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          sessionId: context.sessionId,
          correlationId: context.correlationId,
        },
        createdById: context.userId,
        postImmediately: input.postImmediately,
      });

      if (!posted.ok) return posted;

      // Enqueued inside the transaction, so an entry that rolls back takes its
      // events with it.
      await eventBus.enqueue(tx, posted.value.events);

      return ok({
        journalId: posted.value.journalId,
        entryNumber: posted.value.entryNumber,
        date: date.value.toString(),
        status: input.postImmediately ? 'POSTED' : 'DRAFT',
        totalDebit: posted.value.totalDebit.toString(),
        totalCredit: posted.value.totalCredit.toString(),
        currency,
      });
    });
  },
  {
    rateLimit: 'mutation',
    permission: { resource: 'finance.journal', action: 'create' },
    // Replayable by the offline queue, so it must not create two journals.
    idempotent: true,
  },
);
