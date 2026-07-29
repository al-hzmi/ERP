import { NextResponse } from 'next/server';
import { recordAuthAudit } from '@/lib/infrastructure/audit/audit-logger';
import { AUTH_COOKIE_NAME, REFRESH_COOKIE_NAME } from '@/lib/infrastructure/auth/jwt';
import { getRequestContext } from '@/lib/infrastructure/auth/request-context';
import { hashToken } from '@/lib/infrastructure/crypto/encryption';
import { withTransaction } from '@/lib/infrastructure/db/prisma';
import { cookies } from 'next/headers';

/**
 * Sign-out.
 *
 * The refresh token is revoked server-side, not merely dropped from the browser:
 * clearing a cookie is a suggestion, and a token that is still valid in the
 * database is still a valid session for anyone who captured it.
 */
export async function POST(): Promise<NextResponse> {
  const context = await getRequestContext();
  const refreshToken = cookies().get(REFRESH_COOKIE_NAME)?.value;

  if (refreshToken !== undefined && refreshToken !== '') {
    await withTransaction(async (tx) => {
      // Revoke the entire rotation family — if this token was ever rotated, its
      // successors must die with it.
      const existing = await tx.refreshToken.findUnique({
        where: { tokenHash: hashToken(refreshToken) },
        select: { familyId: true },
      });

      if (existing !== null) {
        await tx.refreshToken.updateMany({
          where: { familyId: existing.familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }

      if (context.ok) {
        await recordAuthAudit(
          tx,
          {
            tenantId: context.value.tenantId,
            userId: context.value.userId,
            ipAddress: context.value.ipAddress,
            userAgent: context.value.userAgent,
            sessionId: context.value.sessionId,
            correlationId: context.value.correlationId,
          },
          'LOGOUT',
          {},
        );
      }
    });
  }

  const response = NextResponse.json({ success: true, data: { signedOut: true } });
  response.cookies.delete(AUTH_COOKIE_NAME);
  response.cookies.delete(REFRESH_COOKIE_NAME);
  return response;
}
