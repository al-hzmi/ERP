import { Prisma } from '@prisma/client';
import type { AssemblyStatus } from '@prisma/client';
import { DomainErrors, type DomainError } from '@/lib/domain/shared/errors';
import { err, ok, type Result } from '@/lib/domain/shared/result';
import type { AuditContext } from '@/lib/infrastructure/audit/audit-logger';
import { recordAudit } from '@/lib/infrastructure/audit/audit-logger';
import { withTenantRead, withTransaction } from '@/lib/infrastructure/db/prisma';
import { allocateDocumentNumber } from './numbering-service';

/**
 * Payment terms, price lists and assembly orders.
 *
 * Three small features in one module because each is a header, a few fields and a list, and
 * three files of forty lines would be three imports for no gain in clarity.
 *
 * ## Two of these are catalogues, and the screens say so
 *
 * **Payment terms are not applied to invoices.** `documents.dueDate` is still whatever the
 * invoice screen sets. Attaching a term to a counterparty and deriving the due date from it is
 * a small change in the invoice path and a large change in meaning: every open invoice's
 * ageing bucket would move the day it shipped.
 *
 * **Price lists are not read at invoicing.** The invoice screen uses the product's
 * `salePrice`. A pricing engine has to answer which list wins when a customer is on two, and
 * what happens to a quotation priced under a list that has since expired — questions with
 * business answers, not schema answers.
 *
 * **Completing an assembly order moves no stock.** Consuming components and receiving the
 * output requires costing the assembled item from its components' cost layers. That is real
 * inventory accounting, and doing it badly would corrupt the valuation the whole system rests
 * on. The order tracks intent and status; the movements are a seam.
 */

// ─────────────────────────────────────────────────────────────────────────────
//  Payment terms
// ─────────────────────────────────────────────────────────────────────────────

export interface PaymentTermRow {
  readonly id: string;
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly netDays: number;
  readonly discountDays: number | null;
  readonly discountPercent: string | null;
  readonly isActive: boolean;
}

export async function listPaymentTerms(input: {
  tenantId: string;
  includeInactive: boolean;
}): Promise<PaymentTermRow[]> {
  return withTenantRead(async (tx) => {
    const rows = await tx.paymentTerm.findMany({
      where: { tenantId: input.tenantId, ...(input.includeInactive ? {} : { isActive: true }) },
      orderBy: { netDays: 'asc' },
    });

    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      nameAr: row.nameAr,
      nameEn: row.nameEn,
      netDays: row.netDays,
      discountDays: row.discountDays,
      discountPercent: row.discountPercent?.toString() ?? null,
      isActive: row.isActive,
    }));
  });
}

export async function createPaymentTerm(input: {
  tenantId: string;
  audit: AuditContext;
  code: string;
  nameAr: string;
  nameEn: string;
  netDays: number;
  discountDays?: number | null;
  discountPercent?: string | null;
}): Promise<Result<{ id: string }, DomainError>> {
  const code = input.code.trim();

  if (code === '' || input.nameAr.trim() === '' || input.nameEn.trim() === '') {
    return err(
      DomainErrors.validation('الرمز والاسمان مطلوبة.', 'Code and both names are required.', 'code'),
    );
  }

  if (!Number.isInteger(input.netDays) || input.netDays < 0 || input.netDays > 3650) {
    return err(
      DomainErrors.validation(
        'مدة السداد يجب أن تكون بين 0 و3650 يوماً.',
        'Net days must be between 0 and 3650.',
        'netDays',
      ),
    );
  }

  const hasDiscount =
    input.discountDays !== undefined &&
    input.discountDays !== null &&
    input.discountPercent !== undefined &&
    input.discountPercent !== null &&
    input.discountPercent !== '';

  // Mirrors the CHECK constraint. Checked here too so the user gets an Arabic sentence rather
  // than a constraint-violation error, but the database is the one that actually decides.
  if (hasDiscount) {
    const days = input.discountDays as number;
    const percent = Number(input.discountPercent);

    if (days < 0 || days > input.netDays) {
      return err(
        DomainErrors.validation(
          'مدة الخصم يجب ألا تتجاوز مدة السداد.',
          'The discount window cannot exceed the payment term.',
          'discountDays',
        ),
      );
    }

    if (!Number.isFinite(percent) || percent <= 0 || percent >= 100) {
      return err(
        DomainErrors.validation(
          'نسبة الخصم يجب أن تكون بين 0 و100.',
          'The discount percentage must be between 0 and 100.',
          'discountPercent',
        ),
      );
    }
  }

  return withTransaction(async (tx) => {
    try {
      const created = await tx.paymentTerm.create({
        data: {
          tenantId: input.tenantId,
          code,
          nameAr: input.nameAr.trim(),
          nameEn: input.nameEn.trim(),
          netDays: input.netDays,
          discountDays: hasDiscount ? (input.discountDays as number) : null,
          discountPercent: hasDiscount ? new Prisma.Decimal(input.discountPercent as string) : null,
        },
        select: { id: true },
      });

      await recordAudit(
        tx,
        input.audit,
        'CREATE',
        { entityType: 'paymentTerm', entityId: created.id },
        { metadata: { code, netDays: input.netDays } },
      );

      return ok(created);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return err(
          DomainErrors.validation(
            `الرمز "${code}" مستخدم بالفعل.`,
            'That code is already in use.',
            'code',
          ),
        );
      }
      throw error;
    }
  });
}

export async function setPaymentTermActive(input: {
  tenantId: string;
  audit: AuditContext;
  id: string;
  isActive: boolean;
}): Promise<Result<{ id: string }, DomainError>> {
  return withTransaction(async (tx) => {
    const updated = await tx.paymentTerm.updateMany({
      where: { id: input.id, tenantId: input.tenantId },
      data: { isActive: input.isActive },
    });

    if (updated.count === 0) {
      return err(DomainErrors.notFound('شرط الدفع', 'Payment term', input.id));
    }

    await recordAudit(
      tx,
      input.audit,
      'UPDATE',
      { entityType: 'paymentTerm', entityId: input.id },
      { metadata: { isActive: input.isActive } },
    );

    return ok({ id: input.id });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Price lists
// ─────────────────────────────────────────────────────────────────────────────

export interface PriceListRow {
  readonly id: string;
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly currency: string;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly isActive: boolean;
  readonly lineCount: number;
}

export interface PriceListLineRow {
  readonly id: string;
  readonly productId: string;
  readonly productSku: string;
  readonly productNameAr: string;
  readonly unitPrice: string;
  readonly minQuantity: string;
  /** The product's own price, for comparison — the point of a list is that it differs. */
  readonly standardPrice: string;
}

export async function listPriceLists(input: {
  tenantId: string;
  includeInactive: boolean;
}): Promise<PriceListRow[]> {
  return withTenantRead(async (tx) => {
    const rows = await tx.priceList.findMany({
      where: { tenantId: input.tenantId, ...(input.includeInactive ? {} : { isActive: true }) },
      orderBy: { code: 'asc' },
      select: {
        id: true,
        code: true,
        nameAr: true,
        nameEn: true,
        currency: true,
        validFrom: true,
        validTo: true,
        isActive: true,
        _count: { select: { lines: true } },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      nameAr: row.nameAr,
      nameEn: row.nameEn,
      currency: row.currency,
      validFrom: row.validFrom.toISOString().slice(0, 10),
      validTo: row.validTo?.toISOString().slice(0, 10) ?? null,
      isActive: row.isActive,
      lineCount: row._count.lines,
    }));
  });
}

export async function getPriceList(input: {
  tenantId: string;
  id: string;
}): Promise<(PriceListRow & { lines: readonly PriceListLineRow[] }) | null> {
  return withTenantRead(async (tx) => {
    const row = await tx.priceList.findFirst({
      where: { id: input.id, tenantId: input.tenantId },
      select: {
        id: true,
        code: true,
        nameAr: true,
        nameEn: true,
        currency: true,
        validFrom: true,
        validTo: true,
        isActive: true,
        _count: { select: { lines: true } },
        lines: {
          orderBy: [{ productId: 'asc' }, { minQuantity: 'asc' }],
          select: {
            id: true,
            productId: true,
            unitPrice: true,
            minQuantity: true,
            product: { select: { sku: true, nameAr: true, salePrice: true } },
          },
        },
      },
    });

    if (row === null) return null;

    return {
      id: row.id,
      code: row.code,
      nameAr: row.nameAr,
      nameEn: row.nameEn,
      currency: row.currency,
      validFrom: row.validFrom.toISOString().slice(0, 10),
      validTo: row.validTo?.toISOString().slice(0, 10) ?? null,
      isActive: row.isActive,
      lineCount: row._count.lines,
      lines: row.lines.map((line) => ({
        id: line.id,
        productId: line.productId,
        productSku: line.product.sku,
        productNameAr: line.product.nameAr,
        unitPrice: line.unitPrice.toString(),
        minQuantity: line.minQuantity.toString(),
        standardPrice: line.product.salePrice.toString(),
      })),
    };
  });
}

export async function createPriceList(input: {
  tenantId: string;
  audit: AuditContext;
  code: string;
  nameAr: string;
  nameEn: string;
  validFrom: string;
  validTo?: string | null;
}): Promise<Result<{ id: string }, DomainError>> {
  const code = input.code.trim();

  if (code === '' || input.nameAr.trim() === '' || input.nameEn.trim() === '') {
    return err(
      DomainErrors.validation('الرمز والاسمان مطلوبة.', 'Code and both names are required.', 'code'),
    );
  }

  const validTo = input.validTo === undefined || input.validTo === null || input.validTo === ''
    ? null
    : input.validTo;

  if (validTo !== null && validTo < input.validFrom) {
    return err(
      DomainErrors.validation(
        'تاريخ نهاية الصلاحية يجب أن يكون بعد تاريخ البداية.',
        'The end of validity must not precede its start.',
        'validTo',
      ),
    );
  }

  return withTransaction(async (tx) => {
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: input.tenantId },
      select: { functionalCurrency: true },
    });

    try {
      const created = await tx.priceList.create({
        data: {
          tenantId: input.tenantId,
          code,
          nameAr: input.nameAr.trim(),
          nameEn: input.nameEn.trim(),
          currency: tenant.functionalCurrency,
          validFrom: new Date(`${input.validFrom}T00:00:00.000Z`),
          validTo: validTo === null ? null : new Date(`${validTo}T00:00:00.000Z`),
        },
        select: { id: true },
      });

      await recordAudit(
        tx,
        input.audit,
        'CREATE',
        { entityType: 'priceList', entityId: created.id },
        { metadata: { code } },
      );

      return ok(created);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return err(
          DomainErrors.validation(
            `الرمز "${code}" مستخدم بالفعل.`,
            'That code is already in use.',
            'code',
          ),
        );
      }
      throw error;
    }
  });
}

/**
 * Adds or re-prices one product on a list.
 *
 * An upsert rather than an insert: re-entering a product at the same quantity tier is what
 * "change this price" looks like from the screen, and refusing it would send the user hunting
 * for a delete button to press first.
 */
export async function setPriceListLine(input: {
  tenantId: string;
  audit: AuditContext;
  priceListId: string;
  productId: string;
  unitPrice: string;
  minQuantity?: string;
}): Promise<Result<{ id: string }, DomainError>> {
  if (!/^\d+(\.\d{1,4})?$/.test(input.unitPrice)) {
    return err(
      DomainErrors.validation(
        'السعر يجب أن يكون رقماً موجباً.',
        'The price must be a non-negative number.',
        'unitPrice',
      ),
    );
  }

  const minQuantity = input.minQuantity ?? '1';
  if (!/^\d+(\.\d{1,4})?$/.test(minQuantity) || Number(minQuantity) <= 0) {
    return err(
      DomainErrors.validation(
        'الكمية الأدنى يجب أن تكون أكبر من صفر.',
        'The minimum quantity must be greater than zero.',
        'minQuantity',
      ),
    );
  }

  return withTransaction(async (tx) => {
    const list = await tx.priceList.findFirst({
      where: { id: input.priceListId, tenantId: input.tenantId },
      select: { id: true },
    });

    if (list === null) {
      return err(DomainErrors.notFound('قائمة الأسعار', 'Price list', input.priceListId));
    }

    const product = await tx.product.findFirst({
      where: { id: input.productId, tenantId: input.tenantId },
      select: { id: true, sku: true },
    });

    if (product === null) {
      return err(DomainErrors.notFound('الصنف', 'Product', input.productId));
    }

    const existing = await tx.priceListLine.findFirst({
      where: {
        priceListId: list.id,
        productId: product.id,
        minQuantity: new Prisma.Decimal(minQuantity),
      },
      select: { id: true },
    });

    const id = existing === null
      ? (
          await tx.priceListLine.create({
            data: {
              tenantId: input.tenantId,
              priceListId: list.id,
              productId: product.id,
              unitPrice: new Prisma.Decimal(input.unitPrice),
              minQuantity: new Prisma.Decimal(minQuantity),
            },
            select: { id: true },
          })
        ).id
      : (
          await tx.priceListLine.update({
            where: { id: existing.id },
            data: { unitPrice: new Prisma.Decimal(input.unitPrice) },
            select: { id: true },
          })
        ).id;

    await recordAudit(
      tx,
      input.audit,
      existing === null ? 'CREATE' : 'UPDATE',
      { entityType: 'priceListLine', entityId: id },
      { metadata: { sku: product.sku, unitPrice: input.unitPrice, minQuantity } },
    );

    return ok({ id });
  });
}

export async function removePriceListLine(input: {
  tenantId: string;
  audit: AuditContext;
  lineId: string;
}): Promise<Result<{ id: string }, DomainError>> {
  return withTransaction(async (tx) => {
    // Unlike the reference tables, a price list line *can* be deleted: nothing references it.
    // It is a price somebody typed, not a fact anything else was filed against.
    const deleted = await tx.priceListLine.deleteMany({
      where: { id: input.lineId, tenantId: input.tenantId },
    });

    if (deleted.count === 0) {
      return err(DomainErrors.notFound('السطر', 'Price list line', input.lineId));
    }

    await recordAudit(tx, input.audit, 'DELETE', {
      entityType: 'priceListLine',
      entityId: input.lineId,
    });

    return ok({ id: input.lineId });
  });
}

export async function setPriceListActive(input: {
  tenantId: string;
  audit: AuditContext;
  id: string;
  isActive: boolean;
}): Promise<Result<{ id: string }, DomainError>> {
  return withTransaction(async (tx) => {
    const updated = await tx.priceList.updateMany({
      where: { id: input.id, tenantId: input.tenantId },
      data: { isActive: input.isActive },
    });

    if (updated.count === 0) {
      return err(DomainErrors.notFound('قائمة الأسعار', 'Price list', input.id));
    }

    await recordAudit(
      tx,
      input.audit,
      'UPDATE',
      { entityType: 'priceList', entityId: input.id },
      { metadata: { isActive: input.isActive } },
    );

    return ok({ id: input.id });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Assembly orders
// ─────────────────────────────────────────────────────────────────────────────

export const ASSEMBLY_STATUS_LABELS_AR: Record<AssemblyStatus, string> = {
  DRAFT: 'مسودة',
  COMPLETED: 'منفَّذ',
  CANCELLED: 'ملغى',
};

export interface AssemblyOrderRow {
  readonly id: string;
  readonly orderNumber: string;
  readonly status: AssemblyStatus;
  readonly productId: string;
  readonly productSku: string;
  readonly productNameAr: string;
  readonly quantity: string;
  readonly warehouseNameAr: string;
  readonly orderDate: string;
  readonly notes: string | null;
  readonly componentCount: number;
}

export interface AssemblyComponentRow {
  readonly id: string;
  readonly productId: string;
  readonly productSku: string;
  readonly productNameAr: string;
  readonly quantityPerUnit: string;
  /** `quantityPerUnit × order quantity` — what the order would consume if it moved stock. */
  readonly totalRequired: string;
  /** Current balance in the order's warehouse, so a shortfall is visible before it is built. */
  readonly available: string;
}

export async function listAssemblyOrders(input: {
  tenantId: string;
  status?: AssemblyStatus;
  limit?: number;
}): Promise<AssemblyOrderRow[]> {
  return withTenantRead(async (tx) => {
    const rows = await tx.assemblyOrder.findMany({
      where: {
        tenantId: input.tenantId,
        ...(input.status !== undefined ? { status: input.status } : {}),
      },
      orderBy: [{ orderDate: 'desc' }, { orderNumber: 'desc' }],
      take: input.limit ?? 100,
      select: {
        id: true,
        orderNumber: true,
        status: true,
        productId: true,
        quantity: true,
        orderDate: true,
        notes: true,
        product: { select: { sku: true, nameAr: true } },
        warehouse: { select: { nameAr: true } },
        _count: { select: { lines: true } },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      orderNumber: row.orderNumber,
      status: row.status,
      productId: row.productId,
      productSku: row.product.sku,
      productNameAr: row.product.nameAr,
      quantity: row.quantity.toString(),
      warehouseNameAr: row.warehouse.nameAr,
      orderDate: row.orderDate.toISOString().slice(0, 10),
      notes: row.notes,
      componentCount: row._count.lines,
    }));
  });
}

export async function getAssemblyOrder(input: {
  tenantId: string;
  id: string;
}): Promise<(AssemblyOrderRow & { components: readonly AssemblyComponentRow[] }) | null> {
  return withTenantRead(async (tx) => {
    const row = await tx.assemblyOrder.findFirst({
      where: { id: input.id, tenantId: input.tenantId },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        productId: true,
        quantity: true,
        orderDate: true,
        notes: true,
        warehouseId: true,
        product: { select: { sku: true, nameAr: true } },
        warehouse: { select: { nameAr: true } },
        _count: { select: { lines: true } },
        lines: {
          select: {
            id: true,
            productId: true,
            quantityPerUnit: true,
            product: { select: { sku: true, nameAr: true } },
          },
        },
      },
    });

    if (row === null) return null;

    // One query for every component's balance rather than one per line.
    const levels = await tx.stockLevel.findMany({
      where: {
        tenantId: input.tenantId,
        warehouseId: row.warehouseId,
        productId: { in: row.lines.map((line) => line.productId) },
      },
      select: { productId: true, quantityOnHand: true },
    });

    const onHand = new Map(levels.map((level) => [level.productId, level.quantityOnHand]));

    return {
      id: row.id,
      orderNumber: row.orderNumber,
      status: row.status,
      productId: row.productId,
      productSku: row.product.sku,
      productNameAr: row.product.nameAr,
      quantity: row.quantity.toString(),
      warehouseNameAr: row.warehouse.nameAr,
      orderDate: row.orderDate.toISOString().slice(0, 10),
      notes: row.notes,
      componentCount: row._count.lines,
      components: row.lines.map((line) => ({
        id: line.id,
        productId: line.productId,
        productSku: line.product.sku,
        productNameAr: line.product.nameAr,
        quantityPerUnit: line.quantityPerUnit.toString(),
        totalRequired: line.quantityPerUnit.times(row.quantity).toString(),
        available: (onHand.get(line.productId) ?? new Prisma.Decimal(0)).toString(),
      })),
    };
  });
}

export async function createAssemblyOrder(input: {
  tenantId: string;
  userId: string;
  audit: AuditContext;
  productId: string;
  quantity: string;
  warehouseId: string;
  orderDate: string;
  notes?: string;
  components: readonly { productId: string; quantityPerUnit: string }[];
}): Promise<Result<{ id: string; orderNumber: string }, DomainError>> {
  if (input.components.length === 0) {
    return err(
      DomainErrors.validation(
        'أمر التجميع يحتاج مكوّناً واحداً على الأقل.',
        'An assembly order needs at least one component.',
        'components',
      ),
    );
  }

  if (!/^\d+(\.\d{1,4})?$/.test(input.quantity) || Number(input.quantity) <= 0) {
    return err(
      DomainErrors.validation(
        'الكمية يجب أن تكون أكبر من صفر.',
        'The quantity must be greater than zero.',
        'quantity',
      ),
    );
  }

  // Caught here as well as by the trigger, so the message names the problem rather than
  // surfacing a raw ERP13.
  if (input.components.some((component) => component.productId === input.productId)) {
    return err(
      DomainErrors.validation(
        'لا يمكن أن يكون الصنف المنتَج أحد مكوّناته.',
        'The output product cannot be one of its own components.',
        'components',
      ),
    );
  }

  return withTransaction(async (tx) => {
    const warehouse = await tx.warehouse.findFirst({
      where: { id: input.warehouseId, tenantId: input.tenantId, isActive: true },
      select: { id: true, branchId: true },
    });

    if (warehouse === null) {
      return err(DomainErrors.notFound('المستودع', 'Warehouse', input.warehouseId));
    }

    const productIds = [input.productId, ...input.components.map((c) => c.productId)];
    const products = await tx.product.findMany({
      where: { id: { in: [...new Set(productIds)] }, tenantId: input.tenantId },
      select: { id: true },
    });

    if (products.length !== new Set(productIds).size) {
      const found = new Set(products.map((product) => product.id));
      return err(
        DomainErrors.notFound('الصنف', 'Product', productIds.find((id) => !found.has(id)) ?? ''),
      );
    }

    const year = Number(input.orderDate.slice(0, 4));
    const orderNumber = await allocateDocumentNumber(tx, input.tenantId, 'ASSEMBLY_ORDER', year);

    const order = await tx.assemblyOrder.create({
      data: {
        tenantId: input.tenantId,
        orderNumber,
        productId: input.productId,
        quantity: new Prisma.Decimal(input.quantity),
        warehouseId: warehouse.id,
        branchId: warehouse.branchId,
        orderDate: new Date(`${input.orderDate}T00:00:00.000Z`),
        notes: input.notes?.trim() === '' ? null : (input.notes?.trim() ?? null),
        createdById: input.userId,
      },
      select: { id: true, orderNumber: true },
    });

    await tx.assemblyOrderLine.createMany({
      data: input.components.map((component) => ({
        tenantId: input.tenantId,
        assemblyOrderId: order.id,
        productId: component.productId,
        quantityPerUnit: new Prisma.Decimal(component.quantityPerUnit),
      })),
    });

    await recordAudit(
      tx,
      input.audit,
      'CREATE',
      { entityType: 'assemblyOrder', entityId: order.id },
      { metadata: { orderNumber: order.orderNumber, components: input.components.length } },
    );

    return ok(order);
  });
}

/**
 * Marks an assembly order complete or cancelled.
 *
 * **This moves no stock.** See the note at the head of this file: consuming components and
 * receiving the output at a cost derived from their cost layers is real inventory accounting,
 * and a half-built version of it would corrupt the valuation every report depends on. The
 * status records what happened on the floor; the movements are a seam left open on purpose.
 */
export async function setAssemblyStatus(input: {
  tenantId: string;
  audit: AuditContext;
  id: string;
  status: 'COMPLETED' | 'CANCELLED';
}): Promise<Result<{ id: string }, DomainError>> {
  return withTransaction(async (tx) => {
    const order = await tx.assemblyOrder.findFirst({
      where: { id: input.id, tenantId: input.tenantId },
      select: { id: true, status: true, orderNumber: true },
    });

    if (order === null) {
      return err(DomainErrors.notFound('أمر التجميع', 'Assembly order', input.id));
    }

    if (order.status !== 'DRAFT') {
      return err(
        DomainErrors.validation(
          `أمر التجميع ${order.orderNumber} ${ASSEMBLY_STATUS_LABELS_AR[order.status]} بالفعل.`,
          'This assembly order is already closed.',
        ),
      );
    }

    await tx.assemblyOrder.update({
      where: { id: order.id },
      data: { status: input.status, completedAt: new Date() },
    });

    await recordAudit(
      tx,
      input.audit,
      'UPDATE',
      { entityType: 'assemblyOrder', entityId: order.id },
      { metadata: { orderNumber: order.orderNumber, to: input.status } },
    );

    return ok({ id: order.id });
  });
}
