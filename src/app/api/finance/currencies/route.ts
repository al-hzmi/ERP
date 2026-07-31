import { z } from 'zod';
import { apiHandler } from '@/lib/api/handler';
import { DomainErrors } from '@/lib/domain/shared/errors';
import { err } from '@/lib/domain/shared/result';
import {
  createCurrency,
  recordExchangeRate,
  setCurrencyActive,
  setFunctionalCurrency,
} from '@/lib/application/services/currency-service';

/**
 * Currencies and the rates between them.
 *
 * `finance.account` rather than a resource of its own: the functional currency is the unit the
 * chart of accounts is denominated in, so whoever may reshape the chart may choose its unit.
 */
const schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('createCurrency'),
    code: z.string().trim().length(3),
    nameAr: z.string().trim().min(1).max(64),
    nameEn: z.string().trim().min(1).max(64),
    symbol: z.string().trim().max(8).default(''),
    minorUnits: z.number().int().min(0).max(4).default(2),
  }),
  z.object({ action: z.literal('setFunctional'), currencyId: z.string().uuid() }),
  z.object({
    action: z.literal('setActive'),
    currencyId: z.string().uuid(),
    isActive: z.boolean(),
  }),
  z.object({
    action: z.literal('recordRate'),
    fromCurrencyId: z.string().uuid(),
    toCurrencyId: z.string().uuid(),
    rate: z.string().trim(),
    validOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
]);

export const POST = apiHandler<{ id: string }>(
  async (context, request) => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return err(DomainErrors.validation('صيغة الطلب غير صحيحة.', 'Malformed request body.'));
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return err(
        DomainErrors.validation(
          'البيانات غير مكتملة أو غير صحيحة.',
          first?.message ?? 'Invalid payload.',
          typeof first?.path[0] === 'string' ? first.path[0] : undefined,
        ),
      );
    }

    const permitted = context.permissions.require(
      'finance.account',
      parsed.data.action === 'createCurrency' || parsed.data.action === 'recordRate'
        ? 'create'
        : 'update',
    );
    if (!permitted.ok) return permitted;

    const audit = {
      tenantId: context.tenantId,
      userId: context.userId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      sessionId: context.sessionId,
      correlationId: context.correlationId,
    };

    switch (parsed.data.action) {
      case 'createCurrency':
        return createCurrency({
          tenantId: context.tenantId,
          audit,
          code: parsed.data.code,
          nameAr: parsed.data.nameAr,
          nameEn: parsed.data.nameEn,
          symbol: parsed.data.symbol,
          minorUnits: parsed.data.minorUnits,
        });
      case 'setFunctional':
        return setFunctionalCurrency({
          tenantId: context.tenantId,
          audit,
          currencyId: parsed.data.currencyId,
        });
      case 'setActive':
        return setCurrencyActive({
          tenantId: context.tenantId,
          audit,
          currencyId: parsed.data.currencyId,
          isActive: parsed.data.isActive,
        });
      case 'recordRate':
        return recordExchangeRate({
          tenantId: context.tenantId,
          audit,
          fromCurrencyId: parsed.data.fromCurrencyId,
          toCurrencyId: parsed.data.toCurrencyId,
          rate: parsed.data.rate,
          validOn: parsed.data.validOn,
        });
    }
  },
  { rateLimit: 'mutation' },
);
