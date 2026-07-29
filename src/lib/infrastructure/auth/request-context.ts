import { cookies, headers } from 'next/headers';
import { DomainErrors, type DomainError } from '@/lib/domain/shared/errors';
import { err, ok, type Result } from '@/lib/domain/shared/result';
import { AUTH_COOKIE_NAME, verifyAccessToken } from './jwt';
import { PermissionSet } from './rbac';

/**
 * The authenticated caller, assembled once per request.
 *
 * Everything a use case needs to authorise, audit and scope its work travels in
 * this one object — which is why no service takes a bare `userId` and then goes
 * looking for the rest.
 */
export interface RequestContext {
  readonly userId: string;
  readonly username: string;
  readonly tenantId: string;
  readonly branchId: string | null;
  readonly permissions: PermissionSet;
  readonly isSuperAdmin: boolean;
  readonly sessionId: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly locale: 'ar' | 'en';
  /** One id per use-case execution, stamped on every audit row and event. */
  readonly correlationId: string;
}

/**
 * Resolves the caller from the access-token cookie.
 *
 * Returns a failure rather than throwing, so a route can decide between
 * redirecting to the login page and returning a 401 body.
 */
export async function getRequestContext(): Promise<Result<RequestContext, DomainError>> {
  const cookieStore = cookies();
  const token = cookieStore.get(AUTH_COOKIE_NAME)?.value;

  if (token === undefined || token === '') {
    return err(DomainErrors.unauthenticated());
  }

  const verified = await verifyAccessToken(token);
  if (verified === null) {
    return err(DomainErrors.unauthenticated());
  }

  const headerList = headers();
  const { claims } = verified;

  return ok({
    userId: claims.sub,
    username: claims.username,
    tenantId: claims.tenantId,
    branchId: claims.branchId,
    permissions: new PermissionSet(claims.permissions, claims.isSuperAdmin),
    isSuperAdmin: claims.isSuperAdmin,
    sessionId: claims.sid,
    ipAddress: resolveClientIp(headerList),
    userAgent: headerList.get('user-agent'),
    locale: resolveLocale(headerList),
    correlationId: crypto.randomUUID(),
  });
}

/**
 * Determines the client address.
 *
 * `x-forwarded-for` is only trusted when the app is explicitly configured to sit
 * behind a proxy — otherwise any client can forge it and evade rate limiting by
 * rotating a header. The leftmost entry is the original client.
 */
function resolveClientIp(headerList: Headers): string | null {
  const trustProxy = process.env['TRUST_PROXY_HEADERS'] === 'true';

  if (trustProxy) {
    const forwarded = headerList.get('x-forwarded-for');
    if (forwarded !== null && forwarded !== '') {
      const first = forwarded.split(',')[0]?.trim();
      if (first !== undefined && first !== '') return first;
    }
    const realIp = headerList.get('x-real-ip');
    if (realIp !== null && realIp !== '') return realIp;
  }

  return headerList.get('x-vercel-forwarded-for') ?? null;
}

function resolveLocale(headerList: Headers): 'ar' | 'en' {
  const explicit = headerList.get('x-erp-locale');
  if (explicit === 'en') return 'en';
  if (explicit === 'ar') return 'ar';

  const accepted = headerList.get('accept-language') ?? '';
  return accepted.toLowerCase().startsWith('en') ? 'en' : 'ar';
}

/**
 * A context for work that has no authenticated caller — the seeder, a scheduled
 * job, the outbox dispatcher. Explicitly labelled so an audit row produced by a
 * background task is never mistaken for a user action.
 */
export function systemContext(tenantId: string, correlationId?: string): RequestContext {
  return {
    userId: 'system',
    username: 'system',
    tenantId,
    branchId: null,
    permissions: new PermissionSet([], true),
    isSuperAdmin: true,
    sessionId: 'system',
    ipAddress: null,
    userAgent: 'system',
    locale: 'ar',
    correlationId: correlationId ?? crypto.randomUUID(),
  };
}
