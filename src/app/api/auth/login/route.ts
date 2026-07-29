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
import { logger } from '@/lib/infrastructure/logging/logger';
import { checkRateLimit, resetRateLimit } from '@/lib/infrastructure/security/rate-limit';

/**
 * Sign-in.
 *
 * Three things here are deliberate and easy to get wrong:
 *
 *  1. **The response never distinguishes an unknown user from a wrong password.**
 *     Doing so turns the login form into a free account-enumeration oracle.
 *  2. **Rate limiting is keyed on username AND address.** Keying on username
 *     alone lets one attacker lock every account out; on address alone lets a
 *     botnet walk straight past it.
 *  3. **A failed attempt still costs a bcrypt verification.** Returning early for
 *     an unknown user makes the response measurably faster and leaks exactly the
 *     fact rule 1 is protecting.
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
  const limit = checkRateLimit('auth', rateKey);
  if (!limit.allowed) {
    return json(DomainErrors.rateLimited(limit.retryAfterSeconds), 429, {
      'Retry-After': String(limit.retryAfterSeconds),
    });
  }

  const user = await prisma.user.findFirst({
    where: {
      username,
      ...(tenantCode !== undefined ? { tenant: { code: tenantCode } } : {}),
    },
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

  resetRateLimit('auth', rateKey);

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
 * Records a failed attempt and applies the escalating lockout.
 *
 * Deliberately not inside the caller's transaction: the counter must persist
 * even when everything else about the request is rejected.
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
