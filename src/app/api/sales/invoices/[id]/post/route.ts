import { NextResponse } from 'next/server';
import { DomainErrors } from '@/lib/domain/shared/errors';
import { postSalesInvoice } from '@/lib/application/use-cases/post-sales-invoice';
import { getRequestContext } from '@/lib/infrastructure/auth/request-context';
import { serialiseForJson } from '@/lib/infrastructure/db/decimal-mapper';
import { logger } from '@/lib/infrastructure/logging/logger';
import { checkRateLimit, rateLimitHeaders } from '@/lib/infrastructure/security/rate-limit';

/**
 * Posts a sales invoice.
 *
 * A dedicated route rather than a PATCH on the invoice, because posting is not
 * an edit: it is a distinct, irreversible business act with its own permission,
 * its own segregation-of-duties rule and its own audit entry.
 *
 * Written against the raw signature rather than `apiHandler` because Next.js
 * passes the dynamic route params as a second argument.
 */
export async function POST(
  request: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const contextResult = await getRequestContext();

  if (!contextResult.ok) {
    return NextResponse.json(
      { success: false, error: contextResult.error.toJSON() },
      { status: contextResult.error.httpStatus },
    );
  }

  const context = contextResult.value;

  const limit = checkRateLimit('mutation', context.userId);
  if (!limit.allowed) {
    const error = DomainErrors.rateLimited(limit.retryAfterSeconds);
    return NextResponse.json(
      { success: false, error: error.toJSON() },
      { status: 429, headers: rateLimitHeaders(limit) },
    );
  }

  try {
    const result = await postSalesInvoice(context, { documentId: params.id });

    if (!result.ok) {
      return NextResponse.json(
        { success: false, error: result.error.toJSON() },
        { status: result.error.httpStatus },
      );
    }

    return NextResponse.json({ success: true, data: serialiseForJson(result.value) });
  } catch (error) {
    const reference = crypto.randomUUID();
    logger.error('Failed to post sales invoice', { reference, documentId: params.id, error });
    const domainError = DomainErrors.internal(reference);
    return NextResponse.json(
      { success: false, error: domainError.toJSON() },
      { status: 500 },
    );
  }
}
