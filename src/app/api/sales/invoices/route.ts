import { z } from 'zod';
import { apiHandler, paginated, parsePagination } from '@/lib/api/handler';
import { calculateInvoice } from '@/lib/domain/sales/invoice-calculator';
import { DomainErrors } from '@/lib/domain/shared/errors';
import { Money } from '@/lib/domain/shared/money';
import { Quantity } from '@/lib/domain/shared/quantity';
import { err, ok } from '@/lib/domain/shared/result';
import { DateOnly } from '@/lib/domain/shared/value-objects';
import { allocateDocumentNumber } from '@/lib/application/services/numbering-service';
import { resolveExchangeRate } from '@/lib/application/services/tenant-context-loader';
import { recordAudit } from '@/lib/infrastructure/audit/audit-logger';
import { prisma, withTransaction } from '@/lib/infrastructure/db/prisma';

/**
 * Sales invoice collection.
 *
 * GET is server-side paginated and filtered — the client never receives more
 * than one page, however many invoices exist. POST creates a DRAFT only:
 * posting is a separate, separately-permissioned action, which is what makes
 * segregation of duties possible at all.
 */

export const GET = apiHandler(
  async (context, request) => {
    const url = new URL(request.url);
    const pagination = parsePagination(request);

    const status = url.searchParams.get('status');
    const counterpartyId = url.searchParams.get('counterpartyId');
    const branchId = url.searchParams.get('branchId');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const query = url.searchParams.get('q');

    const where = {
      tenantId: context.tenantId,
      type: 'SALES_INVOICE' as const,
      ...(status !== null ? { status: status as never } : {}),
      ...(counterpartyId !== null ? { counterpartyId } : {}),
      ...(branchId !== null ? { branchId } : {}),
      ...(from !== null || to !== null
        ? {
            issueDate: {
              ...(from !== null ? { gte: new Date(from) } : {}),
              ...(to !== null ? { lte: new Date(to) } : {}),
            },
          }
        : {}),
      ...(query !== null && query !== ''
        ? {
            OR: [
              { documentNumber: { contains: query, mode: 'insensitive' as const } },
              { counterparty: { nameAr: { contains: query, mode: 'insensitive' as const } } },
              { counterparty: { nameEn: { contains: query, mode: 'insensitive' as const } } },
            ],
          }
        : {}),
    };

    // Count and page fetched together: two round trips, not one per row.
    const [items, total] = await Promise.all([
      prisma.document.findMany({
        where,
        select: {
          id: true,
          documentNumber: true,
          status: true,
          issueDate: true,
          dueDate: true,
          currency: true,
          subtotal: true,
          discountTotal: true,
          taxTotal: true,
          total: true,
          paidAmount: true,
          isPosted: true,
          counterparty: { select: { id: true, code: true, nameAr: true, nameEn: true } },
          branch: { select: { id: true, nameAr: true } },
          _count: { select: { lines: true } },
        },
        orderBy: [{ issueDate: 'desc' }, { documentNumber: 'desc' }],
        skip: pagination.skip,
        take: pagination.pageSize,
      }),
      prisma.document.count({ where }),
    ]);

    return ok(
      paginated(
        items.map((item) => ({
          ...item,
          outstanding: item.total.minus(item.paidAmount).toFixed(4),
          lineCount: item._count.lines,
        })),
        total,
        pagination,
      ),
    );
  },
  { permission: { resource: 'sales.invoice', action: 'read' } },
);

const createInvoiceSchema = z.object({
  counterpartyId: z.string().uuid(),
  branchId: z.string().uuid(),
  warehouseId: z.string().uuid().nullable().optional(),
  issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  currency: z.string().length(3).default('SAR'),
  exchangeRate: z.string().optional(),
  notes: z.string().max(1024).optional(),
  lines: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantity: z.string().regex(/^\d+(\.\d{1,4})?$/),
        unitPrice: z.string().regex(/^\d+(\.\d{1,4})?$/),
        discount: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
        taxRate: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
        descriptionAr: z.string().max(512).optional(),
        batchNumber: z.string().max(64).optional(),
        serialNumber: z.string().max(64).optional(),
      }),
    )
    .min(1),
});

export const POST = apiHandler(
  async (context, request) => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return err(DomainErrors.validation('صيغة الطلب غير صحيحة.', 'Malformed request body.'));
    }

    const parsed = createInvoiceSchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return err(
        DomainErrors.validation(
          `بيانات غير صالحة في الحقل "${issue?.path.join('.') ?? ''}".`,
          `Invalid value for "${issue?.path.join('.') ?? ''}": ${issue?.message ?? ''}`,
          issue?.path.join('.'),
        ),
      );
    }

    const input = parsed.data;

    const issueDate = DateOnly.create(input.issueDate);
    if (!issueDate.ok) return issueDate;

    // Products are loaded in one query, not one per line: an invoice with fifty
    // lines must not become fifty round trips.
    const products = await prisma.product.findMany({
      where: {
        tenantId: context.tenantId,
        id: { in: input.lines.map((line) => line.productId) },
      },
      select: { id: true, taxRate: true, nameAr: true, isActive: true },
    });

    const productById = new Map(products.map((product) => [product.id, product]));

    for (const line of input.lines) {
      const product = productById.get(line.productId);
      if (product === undefined) {
        return err(DomainErrors.notFound('الصنف', 'Product', line.productId));
      }
      if (!product.isActive) {
        return err(
          DomainErrors.validation(
            `الصنف "${product.nameAr}" غير نشط.`,
            `Product "${product.nameAr}" is inactive.`,
            'lines',
          ),
        );
      }
    }

    const calculated = calculateInvoice(
      input.lines.map((line) => ({
        productId: line.productId,
        quantity: Quantity.of(line.quantity),
        unitPrice: Money.of(line.unitPrice, input.currency),
        discount: Money.of(line.discount ?? '0', input.currency),
        taxRate: line.taxRate ?? productById.get(line.productId)?.taxRate.toFixed(2) ?? '15.00',
        ...(line.descriptionAr !== undefined ? { descriptionAr: line.descriptionAr } : {}),
        ...(line.batchNumber !== undefined ? { batchNumber: line.batchNumber } : {}),
        ...(line.serialNumber !== undefined ? { serialNumber: line.serialNumber } : {}),
      })),
      { currency: input.currency },
    );

    if (!calculated.ok) return calculated;

    return withTransaction(async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: context.tenantId },
        select: { functionalCurrency: true },
      });

      const rate = await resolveExchangeRate(
        tx,
        context.tenantId,
        input.currency,
        tenant.functionalCurrency,
        issueDate.value.toDate(),
        input.exchangeRate,
      );
      if (!rate.ok) return rate;

      const counterparty = await tx.counterparty.findUnique({
        where: { id: input.counterpartyId },
        select: { tenantId: true, paymentTerms: true },
      });

      if (counterparty === null || counterparty.tenantId !== context.tenantId) {
        return err(DomainErrors.notFound('العميل', 'Customer', input.counterpartyId));
      }

      const dueDate =
        input.dueDate !== undefined
          ? DateOnly.create(input.dueDate)
          : ok(issueDate.value.addDays(counterparty.paymentTerms));
      if (!dueDate.ok) return dueDate;

      const documentNumber = await allocateDocumentNumber(
        tx,
        context.tenantId,
        'SALES_INVOICE',
        issueDate.value.year,
      );

      const document = await tx.document.create({
        data: {
          tenantId: context.tenantId,
          documentNumber,
          type: 'SALES_INVOICE',
          status: 'DRAFT',
          counterpartyId: input.counterpartyId,
          branchId: input.branchId,
          warehouseId: input.warehouseId ?? null,
          issueDate: issueDate.value.toDate(),
          dueDate: dueDate.value.toDate(),
          currency: input.currency,
          exchangeRate: rate.value,
          subtotal: calculated.value.subtotal.toString(),
          discountTotal: calculated.value.discountTotal.toString(),
          taxTotal: calculated.value.taxTotal.toString(),
          total: calculated.value.total.toString(),
          notes: input.notes ?? null,
          createdById: context.userId,
        },
        select: { id: true },
      });

      await tx.documentLine.createMany({
        data: calculated.value.lines.map((line) => ({
          tenantId: context.tenantId,
          documentId: document.id,
          lineNumber: line.lineNumber,
          productId: line.productId,
          descriptionAr: line.descriptionAr,
          quantity: line.quantity.toString(),
          unitPrice: line.unitPrice.toString(),
          discount: line.discount.toString(),
          taxRate: line.taxRate,
          taxAmount: line.taxAmount.toString(),
          lineTotal: line.lineTotal.toString(),
          batchNumber: line.batchNumber,
          serialNumber: line.serialNumber,
        })),
      });

      await recordAudit(
        tx,
        {
          tenantId: context.tenantId,
          userId: context.userId,
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          sessionId: context.sessionId,
          correlationId: context.correlationId,
        },
        'CREATE',
        { entityType: 'Document', entityId: document.id },
        {
          metadata: {
            documentNumber,
            type: 'SALES_INVOICE',
            total: calculated.value.total.toString(),
            currency: input.currency,
            lineCount: calculated.value.lines.length,
          },
        },
      );

      return ok({
        documentId: document.id,
        documentNumber,
        subtotal: calculated.value.subtotal.toString(),
        discountTotal: calculated.value.discountTotal.toString(),
        taxTotal: calculated.value.taxTotal.toString(),
        total: calculated.value.total.toString(),
        // Surfaced so the UI can tell the user their duplicate lines were merged
        // rather than silently changing what they typed.
        mergedProductIds: calculated.value.mergedProductIds,
      });
    });
  },
  { permission: { resource: 'sales.invoice', action: 'create' }, rateLimit: 'mutation' },
);
