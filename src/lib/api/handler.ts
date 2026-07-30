import { NextResponse } from 'next/server';
import { DomainError, DomainErrors } from '@/lib/domain/shared/errors';
import type { Result } from '@/lib/domain/shared/result';
import { getRequestContext, type RequestContext } from '@/lib/infrastructure/auth/request-context';
import { lookupOutcome, readIdempotencyKey, recordOutcome } from './idempotency';
import { serialiseForJson } from '@/lib/infrastructure/db/decimal-mapper';
import { runInTenantScope } from '@/lib/infrastructure/db/tenant-scope';
import { logger } from '@/lib/infrastructure/logging/logger';
import {
  checkRateLimit,
  rateLimitHeaders,
  type RateLimitScope,
} from '@/lib/infrastructure/security/rate-limit';

/**
 * The single entry point every API route goes through.
 *
 * Centralising authentication, rate limiting, error shaping and serialisation
 * here means a route handler contains business intent and nothing else — and
 * that no route can accidentally omit one of them. The response envelope is
 * identical everywhere, so a client writes one error handler rather than twenty.
 */

export interface ApiSuccess<T> {
  readonly success: true;
  readonly data: T;
  readonly meta?: Record<string, unknown>;
}

export interface ApiFailure {
  readonly success: false;
  readonly error: {
    code: string;
    message: string;
    messageAr: string;
    messageEn: string;
    field?: string;
    details?: Record<string, string | number | boolean | null>;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export interface HandlerOptions {
  /** Rate-limit bucket. Defaults to the general API allowance. */
  readonly rateLimit?: RateLimitScope;
  /** Set false for endpoints that must work before sign-in. */
  readonly requireAuth?: boolean;
  /** Permission the caller must hold, checked before the handler runs. */
  readonly permission?: { resource: string; action: string };
  /**
   * Honour an `Idempotency-Key` header, so the same submission can be sent twice
   * without happening twice.
   *
   * Set this on anything the offline queue may replay. Without it a retry of a request
   * whose response was lost creates a second document — and the client cannot tell that
   * case from one that never arrived.
   */
  readonly idempotent?: boolean;
}

/**
 * Dynamic segments of the matched route, exactly as Next.js supplies them.
 *
 * Untyped on purpose: a URL segment is a string until something validates it.
 * Routes parse this with a schema rather than trusting the shape — an id that
 * arrives in the path deserves no more faith than one that arrives in the body.
 */
export type RouteParams = Readonly<Record<string, string | string[] | undefined>>;

type Handler<T> = (
  context: RequestContext,
  request: Request,
  params: RouteParams,
) => Promise<Result<T, DomainError>>;

/**
 * Wraps a handler with the cross-cutting concerns.
 *
 * Note the ordering: rate limiting comes before authentication, because an
 * unauthenticated flood must be cheap to reject. Authentication comes before the
 * permission check, which comes before any database work.
 *
 * The second argument is what Next.js passes for a dynamic route. Accepting it
 * here is what lets `/invoices/[id]/post` use this wrapper instead of
 * reimplementing authentication, rate limiting and error shaping by hand — which
 * is exactly how a route ends up quietly missing one of them.
 */
export function apiHandler<T>(handler: Handler<T>, options: HandlerOptions = {}) {
  return async (
    request: Request,
    routeContext?: { params?: RouteParams },
  ): Promise<NextResponse<ApiResponse<T>>> => {
    const started = Date.now();

    try {
      const contextResult = await getRequestContext();

      const identifier = contextResult.ok
        ? contextResult.value.userId
        : clientIdentifier(request);

      const limit = await checkRateLimit(options.rateLimit ?? 'api', identifier);
      if (!limit.allowed) {
        return failure(DomainErrors.rateLimited(limit.retryAfterSeconds), rateLimitHeaders(limit));
      }

      if (options.requireAuth !== false && !contextResult.ok) {
        return failure(contextResult.error);
      }

      if (!contextResult.ok) {
        // An anonymous endpoint still needs a context object to work with.
        return failure(DomainErrors.unauthenticated());
      }

      const context = contextResult.value;

      if (options.permission !== undefined) {
        const permitted = context.permissions.require(
          options.permission.resource,
          options.permission.action,
        );
        if (!permitted.ok) {
          logger.warn('Permission denied', {
            userId: context.userId,
            resource: options.permission.resource,
            action: options.permission.action,
            correlationId: context.correlationId,
          });
          return failure(permitted.error);
        }
      }

      const endpoint = new URL(request.url).pathname;

      // ── Idempotency ─────────────────────────────────────────────────────────
      //
      // Resolved after authentication, because a key is scoped to a tenant, and before
      // the handler, because the whole point is not to run it a second time.
      let idempotency: { key: string; body: unknown } | null = null;

      if (options.idempotent === true) {
        const keyResult = readIdempotencyKey(request);
        if (!keyResult.ok) return failure(keyResult.error, rateLimitHeaders(limit));

        if (keyResult.value !== null) {
          // Read from a clone: the handler parses the body itself, and a request body
          // is a stream that can only be consumed once.
          const body = await readJsonBody(request.clone());

          const stored = await runInTenantScope({ tenantId: context.tenantId }, () =>
            lookupOutcome({
              tenantId: context.tenantId,
              key: keyResult.value as string,
              endpoint,
              body,
            }),
          );
          if (!stored.ok) return failure(stored.error, rateLimitHeaders(limit));

          if (stored.value !== null) {
            logger.info('Replayed a recorded outcome for an idempotency key', {
              key: keyResult.value,
              endpoint,
              correlationId: context.correlationId,
            });
            // Verbatim, status included. The client must not be able to tell a replay
            // from the original, or it will act on the difference.
            return NextResponse.json(stored.value.responseBody as ApiResponse<T>, {
              status: stored.value.httpStatus,
              headers: { ...rateLimitHeaders(limit), 'Idempotent-Replay': 'true' },
            });
          }

          idempotency = { key: keyResult.value, body };
        }
      }

      // Everything the handler awaits — services, use cases, transactions —
      // runs inside this scope, so the tenant reaches the database session
      // without being threaded through as a parameter nobody may omit.
      const result = await runInTenantScope(
        {
          tenantId: context.tenantId,
          userId: context.userId,
          correlationId: context.correlationId,
        },
        () => handler(context, request, routeContext?.params ?? {}),
      );

      if (!result.ok) {
        const body: ApiFailure = { success: false, error: result.error.toJSON() };
        await rememberOutcome(idempotency, context, endpoint, result.error.httpStatus, body);
        return failure(result.error, rateLimitHeaders(limit));
      }

      logger.debug('API request completed', {
        path: endpoint,
        durationMs: Date.now() - started,
        correlationId: context.correlationId,
      });

      const successBody = { success: true as const, data: serialiseForJson(result.value) as T };
      await rememberOutcome(idempotency, context, endpoint, 200, successBody);

      return NextResponse.json(successBody, { headers: rateLimitHeaders(limit) });
    } catch (error) {
      // The last line of defence. Whatever went wrong, the client gets a stable
      // envelope and a reference; the detail goes to the log, never the wire.
      const reference = crypto.randomUUID();
      logger.error('Unhandled API error', {
        reference,
        path: new URL(request.url).pathname,
        error,
      });
      return failure(DomainErrors.internal(reference));
    }
  };
}

/** Parses a cloned body for hashing. A body that is not JSON hashes as `null`. */
async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * Records an outcome against an idempotency key, when there is one to record.
 *
 * Which statuses get remembered is the judgement here. A definitive answer — accepted,
 * or refused on its merits — must be remembered, or a replay re-runs the work. A
 * *transient* one must not be: recording a 500 or a 429 would pin the failure to the key
 * forever, so the retry the client is entitled to make would keep receiving the outage
 * that has since passed.
 */
async function rememberOutcome(
  idempotency: { key: string; body: unknown } | null,
  context: RequestContext,
  endpoint: string,
  httpStatus: number,
  responseBody: unknown,
): Promise<void> {
  if (idempotency === null) return;
  if (httpStatus >= 500 || httpStatus === 429) return;

  try {
    await runInTenantScope({ tenantId: context.tenantId }, () =>
      recordOutcome({
        tenantId: context.tenantId,
        userId: context.userId,
        key: idempotency.key,
        endpoint,
        body: idempotency.body,
        httpStatus,
        responseBody,
      }),
    );
  } catch (error) {
    // Swallowed on purpose, and this is the one place worth arguing about. The work has
    // already happened and the client is about to be told so; failing the response now
    // would make a successful invoice look like an error and invite the very retry this
    // record exists to absorb. The cost of losing the record is a possible duplicate on
    // a replay, which is strictly better than a guaranteed duplicate from a false
    // failure.
    logger.error('Could not record idempotency outcome', {
      key: idempotency.key,
      endpoint,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function failure<T>(
  error: DomainError,
  headers: Record<string, string> = {},
): NextResponse<ApiResponse<T>> {
  return NextResponse.json(
    { success: false, error: error.toJSON() } as ApiFailure,
    { status: error.httpStatus, headers },
  ) as NextResponse<ApiResponse<T>>;
}

/**
 * Identifies an anonymous caller for rate limiting.
 *
 * `x-forwarded-for` is only trusted when the deployment declares it is behind a
 * proxy; otherwise any client could rotate the header and evade the limit
 * entirely.
 */
function clientIdentifier(request: Request): string {
  if (process.env['TRUST_PROXY_HEADERS'] === 'true') {
    const forwarded = request.headers.get('x-forwarded-for');
    const first = forwarded?.split(',')[0]?.trim();
    if (first !== undefined && first !== '') return first;
  }
  return request.headers.get('x-real-ip') ?? 'anonymous';
}

/** Parses and validates pagination parameters, capping the page size. */
export function parsePagination(request: Request): { page: number; pageSize: number; skip: number } {
  const url = new URL(request.url);
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  // Capped deliberately: an unbounded page size is a denial-of-service vector
  // dressed up as a feature request.
  const requested = Number.parseInt(url.searchParams.get('pageSize') ?? '50', 10) || 50;
  const pageSize = Math.min(200, Math.max(1, requested));

  return { page, pageSize, skip: (page - 1) * pageSize };
}

export interface PaginatedResult<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
}

export function paginated<T>(
  items: readonly T[],
  total: number,
  pagination: { page: number; pageSize: number },
): PaginatedResult<T> {
  return {
    items,
    page: pagination.page,
    pageSize: pagination.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pagination.pageSize)),
  };
}
