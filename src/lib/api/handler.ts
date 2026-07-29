import { NextResponse } from 'next/server';
import { DomainError, DomainErrors } from '@/lib/domain/shared/errors';
import type { Result } from '@/lib/domain/shared/result';
import { getRequestContext, type RequestContext } from '@/lib/infrastructure/auth/request-context';
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
}

type Handler<T> = (context: RequestContext, request: Request) => Promise<Result<T, DomainError>>;

/**
 * Wraps a handler with the cross-cutting concerns.
 *
 * Note the ordering: rate limiting comes before authentication, because an
 * unauthenticated flood must be cheap to reject. Authentication comes before the
 * permission check, which comes before any database work.
 */
export function apiHandler<T>(handler: Handler<T>, options: HandlerOptions = {}) {
  return async (request: Request): Promise<NextResponse<ApiResponse<T>>> => {
    const started = Date.now();

    try {
      const contextResult = await getRequestContext();

      const identifier = contextResult.ok
        ? contextResult.value.userId
        : clientIdentifier(request);

      const limit = checkRateLimit(options.rateLimit ?? 'api', identifier);
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

      // Everything the handler awaits — services, use cases, transactions —
      // runs inside this scope, so the tenant reaches the database session
      // without being threaded through as a parameter nobody may omit.
      const result = await runInTenantScope(
        {
          tenantId: context.tenantId,
          userId: context.userId,
          correlationId: context.correlationId,
        },
        () => handler(context, request),
      );

      if (!result.ok) {
        return failure(result.error, rateLimitHeaders(limit));
      }

      logger.debug('API request completed', {
        path: new URL(request.url).pathname,
        durationMs: Date.now() - started,
        correlationId: context.correlationId,
      });

      return NextResponse.json(
        { success: true, data: serialiseForJson(result.value) as T },
        { headers: rateLimitHeaders(limit) },
      );
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
