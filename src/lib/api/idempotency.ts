import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { DomainErrors, type DomainError } from '@/lib/domain/shared/errors';
import { err, ok, type Result } from '@/lib/domain/shared/result';
import { prisma } from '@/lib/infrastructure/db/prisma';
import { logger } from '@/lib/infrastructure/logging/logger';
import { IDEMPOTENCY_HEADER, MAX_IDEMPOTENCY_KEY_LENGTH } from './idempotency-header';

/**
 * Making a mutation safe to send twice.
 *
 * The offline queue replays a submission whose response it never saw, and from the
 * client there is no way to tell "never arrived" from "arrived, and the reply was lost".
 * Guessing wrong in the second case creates a second invoice with a second document
 * number. So the client sends a key it generated once, and the first outcome recorded
 * against that key is what every repeat receives.
 *
 * Three things this refuses rather than tolerates, because each would return a *wrong*
 * answer rather than merely a duplicate:
 *
 *   - **The same key against a different endpoint.** Answering a journal POST with a
 *     stored invoice response is worse than failing.
 *   - **The same key with a different body.** That is a client that reused a key it
 *     should have regenerated, and the honest response is to say so — not to return the
 *     first document's number for the second document's data.
 *   - **A key that is not a plausible key.** Bounded length, because it is a column.
 *
 * The race is resolved by the unique index, not by a check-then-insert here: two
 * replays arriving together would both find nothing and both proceed.
 */

export { IDEMPOTENCY_HEADER } from './idempotency-header';

export interface StoredOutcome {
  readonly httpStatus: number;
  readonly responseBody: unknown;
}

function hashBody(body: unknown): string {
  // `JSON.stringify` is not canonical — key order follows insertion — so two bodies
  // that differ only in property order hash differently. That is the conservative
  // direction: a false mismatch is refused and retried by the client under a new key,
  // where a false *match* would return the wrong document.
  return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
}

export function readIdempotencyKey(request: Request): Result<string | null, DomainError> {
  const raw = request.headers.get(IDEMPOTENCY_HEADER);
  if (raw === null) return ok(null);

  const key = raw.trim();
  if (key === '') return ok(null);

  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    return err(
      DomainErrors.validation(
        `مفتاح إعادة الإرسال أطول من ${MAX_IDEMPOTENCY_KEY_LENGTH} حرفاً.`,
        `${IDEMPOTENCY_HEADER} must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
      ),
    );
  }

  return ok(key);
}

/**
 * The outcome already recorded for this key, if any.
 *
 * Returns a failure when the key was used for something else — see the class comment
 * for why that is refused rather than served.
 */
export async function lookupOutcome(input: {
  tenantId: string;
  key: string;
  endpoint: string;
  body: unknown;
}): Promise<Result<StoredOutcome | null, DomainError>> {
  const existing = await prisma.requestIdempotency.findFirst({
    where: { tenantId: input.tenantId, key: input.key },
    select: { endpoint: true, requestHash: true, httpStatus: true, responseBody: true },
  });

  if (existing === null) return ok(null);

  if (existing.endpoint !== input.endpoint) {
    logger.warn('Idempotency key reused across endpoints', {
      key: input.key,
      firstUsedOn: existing.endpoint,
      nowUsedOn: input.endpoint,
    });
    return err(
      DomainErrors.validation(
        'مفتاح إعادة الإرسال مُستخدم لطلب مختلف.',
        `${IDEMPOTENCY_HEADER} was first used on a different endpoint.`,
      ),
    );
  }

  if (existing.requestHash !== hashBody(input.body)) {
    logger.warn('Idempotency key reused with a different body', { key: input.key });
    return err(
      DomainErrors.validation(
        'مفتاح إعادة الإرسال مُستخدم لبيانات مختلفة.',
        `${IDEMPOTENCY_HEADER} was first used with a different request body.`,
      ),
    );
  }

  return ok({ httpStatus: existing.httpStatus, responseBody: existing.responseBody });
}

/**
 * Records the outcome of a keyed request.
 *
 * A unique-violation here means a concurrent replay recorded it first, which is a
 * success rather than an error: both attempts produced the same logical outcome, and the
 * one already stored is the one every future replay will see. Reporting it would turn a
 * handled race into a user-visible failure.
 */
export async function recordOutcome(input: {
  tenantId: string;
  userId: string;
  key: string;
  endpoint: string;
  body: unknown;
  httpStatus: number;
  responseBody: unknown;
}): Promise<void> {
  try {
    await prisma.requestIdempotency.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId,
        key: input.key,
        endpoint: input.endpoint,
        requestHash: hashBody(input.body),
        httpStatus: input.httpStatus,
        responseBody: input.responseBody as Prisma.InputJsonValue,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      logger.debug('Idempotency outcome already recorded by a concurrent replay', {
        key: input.key,
      });
      return;
    }
    throw error;
  }
}

/** Discards records older than the retry window. Called by the scheduled worker. */
export async function sweepIdempotencyRecords(olderThanSeconds: number): Promise<number> {
  const rows = await prisma.$queryRaw<{ erp_idempotency_sweep: number }[]>`
    SELECT erp_idempotency_sweep(${olderThanSeconds}::int)
  `;
  return rows[0]?.erp_idempotency_sweep ?? 0;
}
