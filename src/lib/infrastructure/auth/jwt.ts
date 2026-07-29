import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

/**
 * Access-token issuance and verification.
 *
 * Access tokens are short-lived (15 minutes) and stateless; refresh tokens are
 * long-lived, opaque and stored hashed, so revocation is real rather than
 * aspirational. The split is what lets an administrator disable an account and
 * have it take effect within one token lifetime, without a database read on
 * every single request.
 */

const ISSUER = 'erp.enterprise';
const AUDIENCE = 'erp.api';

/**
 * Declared standalone rather than as `extends JWTPayload`: that interface carries
 * an `[key: string]: unknown` index signature, which would erase the precise
 * types of every claim the moment they were read back out.
 */
export interface AccessTokenClaims {
  /** User id. */
  sub: string;
  iat?: number;
  exp?: number;
  tenantId: string;
  username: string;
  /** Branch the session is currently operating in. */
  branchId: string | null;
  roles: string[];
  /** Compact `resource:action` strings; `*` wildcards are expanded server-side. */
  permissions: string[];
  isSuperAdmin: boolean;
  /** Session id, correlating the access token with its refresh-token family. */
  sid: string;
}

export interface VerifiedToken {
  readonly claims: AccessTokenClaims;
  readonly expiresAt: Date;
}

function getSecret(): Uint8Array {
  const secret = process.env['AUTH_SECRET'];
  if (secret === undefined || secret.length < 32) {
    throw new Error('AUTH_SECRET must be set and at least 32 characters long.');
  }
  return new TextEncoder().encode(secret);
}

function accessTokenTtlSeconds(): number {
  const configured = Number.parseInt(process.env['AUTH_ACCESS_TOKEN_TTL_SECONDS'] ?? '', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 900;
}

export function refreshTokenTtlSeconds(): number {
  const configured = Number.parseInt(process.env['AUTH_REFRESH_TOKEN_TTL_SECONDS'] ?? '', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 604_800;
}

export type AccessTokenInput = Omit<AccessTokenClaims, 'iat' | 'exp'>;

export async function signAccessToken(
  claims: AccessTokenInput,
): Promise<{ token: string; expiresAt: Date }> {
  const ttl = accessTokenTtlSeconds();
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAtSeconds = issuedAt + ttl;

  const token = await new SignJWT({ ...claims } satisfies JWTPayload)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(claims.sub)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAtSeconds)
    .sign(getSecret());

  return { token, expiresAt: new Date(expiresAtSeconds * 1000) };
}

/**
 * Verifies a token's signature, issuer, audience and expiry.
 *
 * Returns null rather than throwing: an expired or forged token is an expected
 * condition on a public endpoint, not an exceptional one.
 */
export async function verifyAccessToken(token: string): Promise<VerifiedToken | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
      // Tolerate a small amount of clock drift between app servers.
      clockTolerance: 5,
    });

    const claims = toAccessTokenClaims(payload);
    if (claims === null) return null;

    return {
      claims,
      expiresAt: new Date((payload.exp ?? 0) * 1000),
    };
  } catch {
    return null;
  }
}

/**
 * Structural validation of a decoded payload.
 *
 * A token signed with our key but carrying the wrong shape — a stale format from
 * a previous release, say — is rejected rather than trusted for the fields that
 * happen to be present.
 */
function toAccessTokenClaims(payload: JWTPayload): AccessTokenClaims | null {
  const { sub, tenantId, username, sid, isSuperAdmin, roles, permissions, branchId } = payload;

  if (
    typeof sub !== 'string' ||
    typeof tenantId !== 'string' ||
    typeof username !== 'string' ||
    typeof sid !== 'string' ||
    typeof isSuperAdmin !== 'boolean' ||
    !isStringArray(roles) ||
    !isStringArray(permissions)
  ) {
    return null;
  }

  return {
    sub,
    tenantId,
    username,
    sid,
    isSuperAdmin,
    roles,
    permissions,
    branchId: typeof branchId === 'string' ? branchId : null,
    ...(typeof payload.iat === 'number' ? { iat: payload.iat } : {}),
    ...(typeof payload.exp === 'number' ? { exp: payload.exp } : {}),
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * Cookie attributes for the auth cookies.
 *
 * `httpOnly` puts the tokens out of reach of any XSS that does get through;
 * `sameSite: 'lax'` blocks the cross-site form post that CSRF depends on while
 * still allowing normal top-level navigation into the app.
 */
export const AUTH_COOKIE_NAME = 'erp_access_token';
export const REFRESH_COOKIE_NAME = 'erp_refresh_token';

export function authCookieOptions(maxAgeSeconds: number): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

export { accessTokenTtlSeconds };
