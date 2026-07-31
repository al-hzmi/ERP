import { z } from 'zod';
import { apiHandler } from '@/lib/api/handler';
import { DomainErrors } from '@/lib/domain/shared/errors';
import { err } from '@/lib/domain/shared/result';
import {
  createPaymentTerm,
  createPriceList,
  removePriceListLine,
  setPaymentTermActive,
  setPriceListActive,
  setPriceListLine,
} from '@/lib/application/services/commercial-setup-service';

/** Payment terms and price lists — both commercial setup, both `sales.customer` authority. */
const schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('createTerm'),
    code: z.string().trim().min(1).max(32),
    nameAr: z.string().trim().min(1).max(128),
    nameEn: z.string().trim().min(1).max(128),
    netDays: z.number().int().min(0).max(3650),
    discountDays: z.number().int().min(0).max(3650).nullish(),
    discountPercent: z.string().trim().nullish(),
  }),
  z.object({ action: z.literal('setTermActive'), id: z.string().uuid(), isActive: z.boolean() }),
  z.object({
    action: z.literal('createList'),
    code: z.string().trim().min(1).max(32),
    nameAr: z.string().trim().min(1).max(128),
    nameEn: z.string().trim().min(1).max(128),
    validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  }),
  z.object({ action: z.literal('setListActive'), id: z.string().uuid(), isActive: z.boolean() }),
  z.object({
    action: z.literal('setPrice'),
    priceListId: z.string().uuid(),
    productId: z.string().uuid(),
    unitPrice: z.string().trim(),
    minQuantity: z.string().trim().optional(),
  }),
  z.object({ action: z.literal('removePrice'), lineId: z.string().uuid() }),
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

    const creating =
      parsed.data.action === 'createTerm' ||
      parsed.data.action === 'createList' ||
      parsed.data.action === 'setPrice';

    const permitted = context.permissions.require(
      'sales.customer',
      creating ? 'create' : 'update',
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
      case 'createTerm':
        return createPaymentTerm({
          tenantId: context.tenantId,
          audit,
          code: parsed.data.code,
          nameAr: parsed.data.nameAr,
          nameEn: parsed.data.nameEn,
          netDays: parsed.data.netDays,
          discountDays: parsed.data.discountDays ?? null,
          discountPercent: parsed.data.discountPercent ?? null,
        });
      case 'setTermActive':
        return setPaymentTermActive({
          tenantId: context.tenantId,
          audit,
          id: parsed.data.id,
          isActive: parsed.data.isActive,
        });
      case 'createList':
        return createPriceList({
          tenantId: context.tenantId,
          audit,
          code: parsed.data.code,
          nameAr: parsed.data.nameAr,
          nameEn: parsed.data.nameEn,
          validFrom: parsed.data.validFrom,
          validTo: parsed.data.validTo ?? null,
        });
      case 'setListActive':
        return setPriceListActive({
          tenantId: context.tenantId,
          audit,
          id: parsed.data.id,
          isActive: parsed.data.isActive,
        });
      case 'setPrice':
        return setPriceListLine({
          tenantId: context.tenantId,
          audit,
          priceListId: parsed.data.priceListId,
          productId: parsed.data.productId,
          unitPrice: parsed.data.unitPrice,
          ...(parsed.data.minQuantity !== undefined
            ? { minQuantity: parsed.data.minQuantity }
            : {}),
        });
      case 'removePrice':
        return removePriceListLine({
          tenantId: context.tenantId,
          audit,
          lineId: parsed.data.lineId,
        });
    }
  },
  { rateLimit: 'mutation' },
);
