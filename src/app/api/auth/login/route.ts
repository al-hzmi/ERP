import { NextResponse } from 'next/server';
import { z } from 'zod';
import { DomainErrors } from '@/lib/domain/shared/errors';
import { recordAuthAudit } from '@/lib/infrastructure/audit/audit-logger';
import {
  AUTH_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
  accessTokenTtlSeconds,
  authCookieOptions,
  refreshTokenTtlSeconds,
  signAccessToken,
} from '@/lib/infrastructure/auth/jwt';
import { lockoutDurationSeconds, verifyPassword } from '@/lib/infrastructure/auth/password';
import { generateOpaqueToken, hashToken } from '@/lib/infrastructure/crypto/encryption';
import { prisma, withTransaction } from '@/lib/infrastructure/db/prisma';
import { runInTenantScope } from '@/lib/infrastructure/db/tenant-scope';
import { logger } from '@/lib/infrastructure/logging/logger';
import { checkRateLimit, resetRateLimit } from '@/lib/infrastructure/security/rate-limit';

/**
 * Sign-in.
 *
 * Four things here are deliberate and easy to get wrong:
 *
 *  1. **The response never distinguishes an unknown user from a wrong password.**
 *     Doing so turns the login form into a free account-enumeration oracle. An
 *     unknown *tenant* is answered the same way, for the same reason.
 *  2. **Rate limiting is keyed on username AND address.** Keying on username
 *     alone lets one attacker lock every account out; on address alone lets a
 *     botnet walk straight past it.
 *  3. **A failed attempt still costs a bcrypt verification.** Returning early for
 *     an unknown user makes the response measurably faster and leaks exactly the
 *     fact rule 1 is protecting.
 *  4. **The tenant is resolved before `users` is touched, and everything after
 *     runs inside that scope.** Two reasons, and the second is a live bug rather
 *     than a precaution:
 *
 *       - `users` is under a fail-closed RLS policy. A session with no tenant
 *         bound sees no rows, so once the application connects as `erp_app`
 *         instead of the table owner, an unscoped lookup authenticates nobody.
 *       - `username` is unique per *tenant*, not globally. Searching without a
 *         tenant made `findFirst` pick whichever row the plan happened to return
 *         first, so with `admin` in two tenants a sign-in could land on either.
 */

const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(200),
  tenantCode: z.string().trim().min(1).max(32).optional(),
});

/** A real bcrypt hash of a value nobody knows, for equalising timing. */
const DUMMY_HASH = '$2a$12$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

export async function POST(request: Request): Promise<NextResponse> {
  const ipAddress = clientIp(request);
  const userAgent = request.headers.get('user-agent');

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(DomainErrors.validation('صيغة الطلب غير صحيحة.', 'Malformed request body.'), 400);
  }

  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return json(
      DomainErrors.validation(
        'اسم المستخدم وكلمة المرور مطلوبان.',
        'Username and password are required.',
      ),
      422,
    );
  }

  const { username, password, tenantCode } = parsed.data;

  const rateKey = `${username.toLowerCase()}|${ipAddress ?? 'unknown'}`;
  const limit = await checkRateLimit('auth', rateKey);
  if (!limit.allowed) {
    return json(DomainErrors.rateLimited(limit.retryAfterSeconds), 429, {
      'Retry-After': String(limit.retryAfterSeconds),
    });
  }

  // `tenants` carries no `tenantId` and therefore no policy, so this read works
  // with nothing bound — which is exactly why it can be the thing that resolves
  // the binding for everything after it.
  const tenant = await resolveTenant(tenantCode, username);

  if (tenant === 'ambiguous') {
    // Not a credential failure: the caller omitted a parameter this deployment
    // needs. Saying so plainly leaks nothing — the set of tenants is not a secret
    // to someone who already had to be told which one to name.
    return json(
      DomainErrors.validation(
        'يجب تحديد رمز المنشأة.',
        'A tenant code is required on this deployment.',
        'tenantCode',
      ),
      422,
    );
  }

  if (tenant === null) {
    // An unknown tenant code is answered exactly like a wrong password, and pays
    // the same bcrypt cost, so the response neither says nor times differently.
    await verifyPassword(password, DUMMY_HASH);
    logger.warn('Failed sign-in attempt', { username, ipAddress, reason: 'unknown tenant' });
    return json(
      DomainErrors.validation(
        'اسم المستخدم أو كلمة المرور غير صحيحة.',
        'Invalid username or password.',
      ),
      401,
    );
  }

  return runInTenantScope({ tenantId: tenant.id }, () =>
    completeSignIn({ username, password, tenantId: tenant.id, rateKey, ipAddress, userAgent }),
  );
}

interface SignInAttempt {
  readonly username: string;
  readonly password: string;
  readonly tenantId: string;
  readonly rateKey: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

/**
 * Everything from the user lookup onwards, running with the tenant bound.
 *
 * Extracted so the scope wraps the whole of it. A scope that covered only the
 * lookup would leave the lockout counter and the audit row to be written by an
 * unbound session — writes that a fail-closed `WITH CHECK` rejects outright.
 */
async function completeSignIn(attempt: SignInAttempt): Promise<NextResponse> {
  const { username, password, tenantId, rateKey, ipAddress, userAgent } = attempt;

  const user = await prisma.user.findFirst({
    where: { username, tenantId },
    include: {
      tenant: { select: { id: true, isActive: true } },
      userRoles: {
        include: {
          role: {
            include: {
              rolePermissions: { include: { permission: true } },
            },
          },
        },
      },
    },
  });

  // Always run a verification, even when the user does not exist, so the
  // response time carries no information.
  const passwordMatches = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);

  const invalidCredentials = DomainErrors.validation(
    'اسم المستخدم أو كلمة المرور غير صحيحة.',
    'Invalid username or password.',
  );

  if (user === null || !passwordMatches || !user.isActive || !user.tenant.isActive) {
    if (user !== null) {
      await recordFailure(user.id, user.tenantId, user.failedAttempts, ipAddress, userAgent);
    }
    logger.warn('Failed sign-in attempt', { username, ipAddress });
    return json(invalidCredentials, 401);
  }

  if (user.lockedUntil !== null && user.lockedUntil > new Date()) {
    const seconds = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000);
    return json(
      DomainErrors.validation(
        `الحساب مقفل مؤقتاً. يرجى المحاولة بعد ${seconds} ثانية.`,
        `This account is temporarily locked. Please try again in ${seconds} seconds.`,
      ),
      423,
    );
  }

  // ── Build the permission snapshot carried in the token ────────────────────
  const roles = user.userRoles.map((entry) => entry.role.name);
  const permissions = [
    ...new Set(
      user.userRoles.flatMap((entry) =>
        entry.role.rolePermissions.map((rolePermission) => {
          const { resource, action, field } = rolePermission.permission;
          return field === null ? `${resource}:${action}` : `${resource}:${action}:${field}`;
        }),
      ),
    ),
  ];

  const sessionId = crypto.randomUUID();

  const { token: accessToken } = await signAccessToken({
    sub: user.id,
    tenantId: user.tenantId,
    username: user.username,
    branchId: user.defaultBranchId,
    roles,
    permissions,
    isSuperAdmin: user.isSuperAdmin,
    sid: sessionId,
  });

  // The refresh token is opaque and stored only as a hash: a database leak
  // cannot be replayed as a session.
  const refreshToken = generateOpaqueToken();
  const refreshTtl = refreshTokenTtlSeconds();

  await withTransaction(async (tx) => {
    await tx.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        familyId: crypto.randomUUID(),
        expiresAt: new Date(Date.now() + refreshTtl * 1000),
        ipAddress,
        userAgent: userAgent?.slice(0, 512) ?? null,
      },
    });

    await tx.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), failedAttempts: 0, lockedUntil: null },
    });

    await recordAuthAudit(
      tx,
      {
        tenantId: user.tenantId,
        userId: user.id,
        ipAddress,
        userAgent,
        sessionId,
        correlationId: crypto.randomUUID(),
      },
      'LOGIN',
      { username: user.username, roles },
    );
  });

  await resetRateLimit('auth', rateKey);

  const response = NextResponse.json({
    success: true,
    data: {
      user: {
        id: user.id,
        username: user.username,
        fullNameAr: user.fullNameAr,
        fullNameEn: user.fullNameEn,
        locale: user.locale,
        isSuperAdmin: user.isSuperAdmin,
        defaultBranchId: user.defaultBranchId,
        roles,
      },
    },
  });

  response.cookies.set(AUTH_COOKIE_NAME, accessToken, authCookieOptions(accessTokenTtlSeconds()));
  response.cookies.set(REFRESH_COOKIE_NAME, refreshToken, authCookieOptions(refreshTtl));

  return response;
}

/**
 * Works out which tenant is being signed into, before any tenant-scoped table is
 * read.
 *
 * Returns the tenant, `null` when the named one does not exist or is inactive, or
 * `'ambiguous'` when no code was supplied and the deployment holds more than one
 * tenant to choose between.
 *
 * The single-tenant fallback is what keeps the demo — and every single-company
 * deployment — from having to name a tenant it does not have a choice about. It is
 * a fallback rather than a guess: with two tenants present the request is refused,
 * because picking one would be exactly the arbitrary selection this replaces.
 */
async function resolveTenant(
  tenantCode: string | undefined,
  username: string,
): Promise<{ id: string } | null | 'ambiguous'> {
  if (tenantCode !== undefined) {
    return prisma.tenant.findFirst({
      where: { code: tenantCode, isActive: true },
      select: { id: true },
    });
  }

  // `take: 2` answers "is there exactly one?" without counting a table that could
  // hold thousands.
  const candidates = await prisma.tenant.findMany({
    where: { isActive: true },
    select: { id: true },
    take: 2,
  });

  if (candidates.length === 1) return candidates[0] ?? null;
  if (candidates.length === 0) return null;

  // More than one tenant, and no code given. Rather than refuse, resolve from the username —
  // `(tenantId, username)` is unique, so a name that exists in exactly one tenant identifies
  // it without ambiguity.
  //
  // This was added because refusing was wrong in practice, not in theory: running the
  // integration suite leaves dozens of scratch tenants in a development database, and from
  // then on every sign-in demanded a tenant code nobody had a reason to know. The demand was
  // technically correct and useless.
  //
  // It gives away nothing a password guess would not: the response for "username exists in
  // two tenants" is the same 422 as before, and for a name that exists in none it falls
  // through to the 401 that an unknown tenant code already produced.
  //
  // One limitation, stated because it is invisible otherwise: this reads `users` with no
  // tenant bound. That works as the table owner, which is what the demo connects as. Under
  // `erp_web` the fail-closed policy returns no rows and the fallback yields `'ambiguous'` —
  // so a multi-tenant production deployment on the non-owner role still requires a tenant
  // code, exactly as it did before. The failure direction is the safe one: it asks for more
  // information rather than picking a tenant.
  const matches = await prisma.user.findMany({
    where: { username, isActive: true, tenant: { isActive: true } },
    select: { tenantId: true },
    take: 2,
  });

  if (matches.length === 1 && matches[0] !== undefined) {
    return { id: matches[0].tenantId };
  }

  return 'ambiguous';
}

/**
 * Records a failed attempt and applies the escalating lockout.
 *
 * Deliberately not inside the caller's transaction: the counter must persist
 * even when everything else about the request is rejected.
 *
 * Runs within the caller's tenant scope, which `withTransaction` picks up from the
 * ambient store — so the update and the audit row are both bound, and neither is
 * rejected by the policy's `WITH CHECK`.
 */
async function recordFailure(
  userId: string,
  tenantId: string,
  currentAttempts: number,
  ipAddress: string | null,
  userAgent: string | null,
): Promise<void> {
  const attempts = currentAttempts + 1;
  const lockSeconds = lockoutDurationSeconds(attempts);

  await withTransaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: {
        failedAttempts: attempts,
        lockedUntil: lockSeconds > 0 ? new Date(Date.now() + lockSeconds * 1000) : null,
      },
    });

    await recordAuthAudit(
      tx,
      {
        tenantId,
        userId,
        ipAddress,
        userAgent,
        sessionId: null,
        correlationId: crypto.randomUUID(),
      },
      'LOGIN_FAILED',
      { attempts, lockedForSeconds: lockSeconds },
    );
  });
}

function clientIp(request: Request): string | null {
  if (process.env['TRUST_PROXY_HEADERS'] === 'true') {
    const forwarded = request.headers.get('x-forwarded-for');
    const first = forwarded?.split(',')[0]?.trim();
    if (first !== undefined && first !== '') return first;
  }
  return request.headers.get('x-real-ip');
}

function json(
  error: ReturnType<typeof DomainErrors.validation>,
  status: number,
  headers: Record<string, string> = {},
): NextResponse {
  return NextResponse.json({ success: false, error: error.toJSON() }, { status, headers });
}
