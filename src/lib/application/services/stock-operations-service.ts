import { JournalEntryDraft } from '@/lib/domain/accounting/journal-entry';
import { DomainErrors, type DomainError } from '@/lib/domain/shared/errors';
import { Money } from '@/lib/domain/shared/money';
import { Quantity } from '@/lib/domain/shared/quantity';
import { err, ok, type Result } from '@/lib/domain/shared/result';
import { DateOnly } from '@/lib/domain/shared/value-objects';
import type { AuditContext } from '@/lib/infrastructure/audit/audit-logger';
import { recordAudit } from '@/lib/infrastructure/audit/audit-logger';
import { withTenantRead, withTransaction, type TransactionClient } from '@/lib/infrastructure/db/prisma';
import { eventBus } from '@/lib/infrastructure/events/event-bus';
import { logger } from '@/lib/infrastructure/logging/logger';
import { issueStock, receiveStock, transferStock } from './inventory-service';
import { persistJournalEntry } from './journal-service';

/**
 * Stock transfers and adjustments.
 *
 * `transferStock`, `receiveStock` and `issueStock` have been tested since the first commit
 * with nothing calling them from outside the seed. This is the seam, and it adds exactly one
 * thing they do not do: the ledger entry an adjustment needs.
 *
 * ## Why a transfer posts no journal and an adjustment does
 *
 * A transfer moves stock between two warehouses. Both sit in the same inventory GL account, so
 * the entry would be `Dr Inventory / Cr Inventory` for the same amount — a journal that says
 * nothing and balances trivially. The value has not left the company, so the ledger has nothing
 * to record. (A company that valued each warehouse in its own account would need one; this
 * chart does not.)
 *
 * An adjustment is different in kind: stock appears or disappears. The value *has* changed, and
 * the counter-entry is a gain or a loss. Writing the movement without the journal would leave
 * inventory on the balance sheet disagreeing with the sum of its movements, which is precisely
 * what `erp_stock_value_consistency` exists to make impossible — so the write would fail, late
 * and confusingly, rather than be quietly wrong.
 *
 * ## The costing of an increase
 *
 * A positive adjustment needs a unit cost, and there is no document to take one from. The
 * current weighted-average cost is used, because valuing found stock at anything else would
 * shift the average on a movement that represents no purchase. Where there is no existing
 * position the caller must supply a cost — and is refused rather than defaulted to zero, since
 * zero-valued stock silently understates inventory forever after.
 */

export interface TransferInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly audit: AuditContext;
  readonly branchId: string;
  readonly productId: string;
  readonly fromWarehouseId: string;
  readonly toWarehouseId: string;
  readonly quantity: string;
  readonly date: string;
  readonly notes?: string;
}

export interface AdjustmentInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly audit: AuditContext;
  readonly branchId: string;
  readonly productId: string;
  readonly warehouseId: string;
  /** Signed: positive is a surplus found, negative is a shortage written off. */
  readonly quantity: string;
  readonly date: string;
  readonly reason: string;
  /** Required only for an increase with no existing position to take a cost from. */
  readonly unitCost?: string;
}

interface PostingContext {
  readonly currency: string;
  readonly allowNegativeStock: boolean;
  readonly costingMethod: 'FIFO' | 'WEIGHTED_AVERAGE';
  readonly inventoryAccountId: string;
  readonly adjustmentAccountId: string;
}

/** Names the movement services need for their refusals, plus the tenant's posting settings. */
async function loadContext(
  tx: TransactionClient,
  tenantId: string,
): Promise<Result<PostingContext, DomainError>> {
  const [tenant, mappings] = await Promise.all([
    tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { functionalCurrency: true, allowNegativeStock: true, costingMethod: true },
    }),
    tx.accountMapping.findMany({
      where: { tenantId, key: { in: ['INVENTORY', 'INVENTORY_ADJUSTMENT'] } },
      select: { key: true, accountId: true },
    }),
  ]);

  const byKey = new Map(mappings.map((mapping) => [mapping.key, mapping.accountId]));
  const inventoryAccountId = byKey.get('INVENTORY');
  const adjustmentAccountId = byKey.get('INVENTORY_ADJUSTMENT');

  if (inventoryAccountId === undefined || adjustmentAccountId === undefined) {
    // Named rather than swallowed: a missing mapping is a configuration error an administrator
    // can fix, and "something went wrong" would send them looking in the wrong place.
    return err(
      DomainErrors.validation(
        'لم تُضبط حسابات المخزون أو تسويات المخزون في إعدادات الترحيل.',
        'The INVENTORY or INVENTORY_ADJUSTMENT account mapping is not configured.',
      ),
    );
  }

  return ok({
    currency: tenant.functionalCurrency,
    allowNegativeStock: tenant.allowNegativeStock,
    costingMethod: tenant.costingMethod,
    inventoryAccountId,
    adjustmentAccountId,
  });
}

export interface StockOperationRow {
  readonly id: string;
  readonly movementNumber: string;
  readonly type: string;
  readonly movementDate: string;
  readonly quantity: string;
  readonly totalCost: string;
  readonly notes: string | null;
  readonly transferGroupId: string | null;
  readonly product: { id: string; sku: string; nameAr: string };
  readonly warehouse: { code: string; nameAr: string };
  readonly fromWarehouse: { code: string } | null;
  readonly toWarehouse: { code: string } | null;
}

/** Transfers and adjustments, newest first. One query serves both registers. */
export async function listStockOperations(input: {
  tenantId: string;
  kind: 'TRANSFER' | 'ADJUSTMENT';
  warehouseId?: string;
  page: number;
  pageSize: number;
}): Promise<{ rows: StockOperationRow[]; total: number }> {
  return withTenantRead(async (tx) => {
    const where = {
      tenantId: input.tenantId,
      type: input.kind,
      ...(input.warehouseId !== undefined ? { warehouseId: input.warehouseId } : {}),
    };

    const [rows, total] = await Promise.all([
      tx.inventoryMovement.findMany({
        where,
        select: {
          id: true,
          movementNumber: true,
          type: true,
          movementDate: true,
          quantity: true,
          totalCost: true,
          notes: true,
          transferGroupId: true,
          product: { select: { id: true, sku: true, nameAr: true } },
          warehouse: { select: { code: true, nameAr: true } },
          fromWarehouse: { select: { code: true } },
          toWarehouse: { select: { code: true } },
        },
        orderBy: [{ movementDate: 'desc' }, { movementNumber: 'desc' }],
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
      }),
      tx.inventoryMovement.count({ where }),
    ]);

    return {
      rows: rows.map((row) => ({
        id: row.id,
        movementNumber: row.movementNumber,
        type: row.type,
        movementDate: row.movementDate.toISOString().slice(0, 10),
        quantity: row.quantity.toString(),
        totalCost: row.totalCost.toString(),
        notes: row.notes,
        transferGroupId: row.transferGroupId,
        product: row.product,
        warehouse: row.warehouse,
        fromWarehouse: row.fromWarehouse,
        toWarehouse: row.toWarehouse,
      })),
      total,
    };
  });
}

export interface TransferOutcome {
  readonly transferGroupId: string;
  readonly transferredValue: string;
}

/** Moves stock between two warehouses. No journal — see the note at the top of this file. */
export async function recordTransfer(
  input: TransferInput,
): Promise<Result<TransferOutcome, DomainError>> {
  const date = DateOnly.create(input.date);
  if (!date.ok) return date;

  let quantity: Quantity;
  try {
    quantity = Quantity.of(input.quantity);
  } catch {
    return err(DomainErrors.invalidFormat('الكمية', 'quantity', '10.5', 'quantity'));
  }

  if (!quantity.isPositive) {
    return err(
      DomainErrors.validation(
        'كمية التحويل يجب أن تكون أكبر من صفر.',
        'The transfer quantity must be greater than zero.',
        'quantity',
      ),
    );
  }

  return withTransaction(async (tx) => {
    const context = await loadContext(tx, input.tenantId);
    if (!context.ok) return context;

    const [product, from] = await Promise.all([
      tx.product.findFirst({
        where: { id: input.productId, tenantId: input.tenantId },
        select: { nameAr: true, nameEn: true, isStockItem: true, costingMethod: true },
      }),
      tx.warehouse.findFirst({
        where: { id: input.fromWarehouseId, tenantId: input.tenantId },
        select: { nameAr: true, nameEn: true },
      }),
    ]);

    if (product === null) {
      return err(DomainErrors.notFound('الصنف', 'Product', input.productId));
    }
    if (from === null) {
      return err(DomainErrors.notFound('المستودع', 'Warehouse', input.fromWarehouseId));
    }
    if (!product.isStockItem) {
      return err(
        DomainErrors.validation(
          'الصنف خدمي ولا يُخزَّن، فلا يمكن تحويله.',
          'A service product holds no stock and cannot be transferred.',
          'productId',
        ),
      );
    }

    const result = await transferStock(tx, {
      tenantId: input.tenantId,
      branchId: input.branchId,
      productId: input.productId,
      date: date.value,
      createdById: input.userId,
      fromWarehouseId: input.fromWarehouseId,
      toWarehouseId: input.toWarehouseId,
      quantity,
      costingMethod: product.costingMethod ?? context.value.costingMethod,
      allowNegativeStock: context.value.allowNegativeStock,
      currency: context.value.currency,
      productNameAr: product.nameAr,
      productNameEn: product.nameEn,
      fromWarehouseNameAr: from.nameAr,
      fromWarehouseNameEn: from.nameEn,
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    });

    if (!result.ok) return result;

    await recordAudit(
      tx,
      input.audit,
      'CREATE',
      { entityType: 'StockTransfer', entityId: result.value.transferGroupId },
      {
        metadata: {
          productId: input.productId,
          fromWarehouseId: input.fromWarehouseId,
          toWarehouseId: input.toWarehouseId,
          quantity: input.quantity,
          value: result.value.transferredValue.toString(),
        },
      },
    );

    await eventBus.enqueue(tx, result.value.events);

    logger.info('Stock transfer recorded', {
      transferGroupId: result.value.transferGroupId,
      productId: input.productId,
    });

    return ok({
      transferGroupId: result.value.transferGroupId,
      transferredValue: result.value.transferredValue.toString(),
    });
  });
}

export interface AdjustmentOutcome {
  readonly movementId: string;
  readonly movementNumber: string;
  readonly journalId: string;
  readonly entryNumber: string;
  readonly value: string;
  readonly direction: 'INCREASE' | 'DECREASE';
}

/**
 * Writes stock up or down, and posts the gain or loss.
 *
 * The movement and the journal share one transaction. Splitting them would allow a stock
 * change with no ledger entry to survive a crash — the exact drift the consistency guard
 * exists to prevent, arrived at by a different route.
 */
export async function recordAdjustment(
  input: AdjustmentInput,
): Promise<Result<AdjustmentOutcome, DomainError>> {
  return withTransaction((tx) => applyAdjustment(tx, input));
}

/**
 * The adjustment itself, inside a caller's transaction.
 *
 * Split out so the stock-count service can post a sheet's variances through *this* code path
 * rather than a parallel one. It matters: a second implementation would be a second place for
 * the journal's direction, the costing of an increase, and the zero-value refusal to drift —
 * and the drift would show up as a stock count whose adjustments differ from an identical
 * manual one.
 *
 * Nesting `withTransaction` inside another transaction would open a second connection and a
 * second transaction, so the wrapper above owns the boundary and this function never opens one.
 */
export async function applyAdjustment(
  tx: TransactionClient,
  input: AdjustmentInput,
): Promise<Result<AdjustmentOutcome, DomainError>> {
  const date = DateOnly.create(input.date);
  if (!date.ok) return date;

  if (input.reason.trim() === '') {
    // An adjustment with no stated reason is an unexplained change in the company's assets.
    // The register would show a number nobody can account for a month later.
    return err(
      DomainErrors.validation(
        'يجب ذكر سبب التسوية.',
        'An adjustment must state its reason.',
        'reason',
      ),
    );
  }

  const signed = input.quantity.trim();
  const isDecrease = signed.startsWith('-');
  const magnitude = isDecrease ? signed.slice(1) : signed;

  let quantity: Quantity;
  try {
    quantity = Quantity.of(magnitude);
  } catch {
    return err(DomainErrors.invalidFormat('الكمية', 'quantity', '-5 أو 5', 'quantity'));
  }

  if (!quantity.isPositive) {
    return err(
      DomainErrors.validation(
        'كمية التسوية لا يمكن أن تكون صفراً.',
        'An adjustment of zero changes nothing.',
        'quantity',
      ),
    );
  }

  {
    const context = await loadContext(tx, input.tenantId);
    if (!context.ok) return context;

    const [product, warehouse, position] = await Promise.all([
      tx.product.findFirst({
        where: { id: input.productId, tenantId: input.tenantId },
        select: { nameAr: true, nameEn: true, isStockItem: true, costingMethod: true },
      }),
      tx.warehouse.findFirst({
        where: { id: input.warehouseId, tenantId: input.tenantId },
        select: { nameAr: true, nameEn: true },
      }),
      tx.stockLevel.findFirst({
        where: {
          tenantId: input.tenantId,
          productId: input.productId,
          warehouseId: input.warehouseId,
        },
        select: { averageCost: true },
      }),
    ]);

    if (product === null) return err(DomainErrors.notFound('الصنف', 'Product', input.productId));
    if (warehouse === null) {
      return err(DomainErrors.notFound('المستودع', 'Warehouse', input.warehouseId));
    }
    if (!product.isStockItem) {
      return err(
        DomainErrors.validation(
          'الصنف خدمي ولا يُخزَّن، فلا تنطبق عليه التسويات.',
          'A service product holds no stock to adjust.',
          'productId',
        ),
      );
    }

    const costingMethod = product.costingMethod ?? context.value.costingMethod;

    let movement;
    if (isDecrease) {
      // The cost of a write-off is whatever the costing method consumes — FIFO layers or the
      // running average. Taking it from the caller would let a shortage be valued at a price
      // that was never paid.
      movement = await issueStock(tx, {
        tenantId: input.tenantId,
        branchId: input.branchId,
        productId: input.productId,
        warehouseId: input.warehouseId,
        date: date.value,
        createdById: input.userId,
        quantity,
        costingMethod,
        allowNegativeStock: context.value.allowNegativeStock,
        movementType: 'ADJUSTMENT',
        productNameAr: product.nameAr,
        productNameEn: product.nameEn,
        warehouseNameAr: warehouse.nameAr,
        warehouseNameEn: warehouse.nameEn,
        currency: context.value.currency,
        notes: input.reason,
      });
    } else {
      const fallback = position?.averageCost;
      const supplied = input.unitCost?.trim();

      if ((supplied === undefined || supplied === '') && (fallback === undefined || fallback.isZero())) {
        return err(
          DomainErrors.validation(
            'لا يوجد رصيد سابق لهذا الصنف في المستودع، فيجب تحديد تكلفة الوحدة.',
            'No existing position to take a cost from — a unit cost is required.',
            'unitCost',
          ),
        );
      }

      let unitCost: Money;
      try {
        unitCost =
          supplied !== undefined && supplied !== ''
            ? Money.of(supplied, context.value.currency)
            : Money.of(fallback!.toFixed(4), context.value.currency);
      } catch {
        return err(DomainErrors.invalidFormat('تكلفة الوحدة', 'unitCost', '12.50', 'unitCost'));
      }

      movement = await receiveStock(tx, {
        tenantId: input.tenantId,
        branchId: input.branchId,
        productId: input.productId,
        warehouseId: input.warehouseId,
        date: date.value,
        createdById: input.userId,
        quantity,
        unitCost,
        costingMethod,
        movementType: 'ADJUSTMENT',
        notes: input.reason,
      });
    }

    if (!movement.ok) return movement;

    const value = movement.value.totalCost;

    // A zero-valued adjustment writes no journal. It can happen legitimately — adjusting a
    // product whose average cost is zero — and an entry of `Dr 0 / Cr 0` would be refused by
    // `validate()` anyway, correctly: an empty entry is not an entry.
    if (value.isZero) {
      return err(
        DomainErrors.validation(
          'قيمة التسوية صفر — لا يمكن ترحيل قيد بلا مبلغ. حدِّد تكلفة الوحدة.',
          'The adjustment has zero value, so no journal can be posted. Supply a unit cost.',
          'unitCost',
        ),
      );
    }

    const draft = new JournalEntryDraft({
      tenantId: input.tenantId,
      type: 'INVENTORY',
      date: date.value,
      descriptionAr: `تسوية مخزون — ${product.nameAr} — ${input.reason}`,
      descriptionEn: `Stock adjustment — ${product.nameEn}`,
      branchId: input.branchId,
      referenceType: 'STOCK_ADJUSTMENT',
      referenceId: movement.value.movementId,
      currency: context.value.currency,
      exchangeRate: '1.000000',
      functionalCurrency: context.value.currency,
    });

    if (isDecrease) {
      // Stock gone: the loss is an expense, and inventory comes down.
      draft.debit(context.value.adjustmentAccountId, value, { description: input.reason });
      draft.credit(context.value.inventoryAccountId, value, { description: input.reason });
    } else {
      // Stock found: inventory goes up against the same adjustment account, which nets the
      // period's surpluses against its shortages — which is what a stock-loss line is for.
      draft.debit(context.value.inventoryAccountId, value, { description: input.reason });
      draft.credit(context.value.adjustmentAccountId, value, { description: input.reason });
    }

    const entry = draft.validate();
    if (!entry.ok) return entry;

    const posted = await persistJournalEntry(tx, entry.value, {
      audit: input.audit,
      createdById: input.userId,
      postImmediately: true,
    });
    if (!posted.ok) return posted;

    await recordAudit(
      tx,
      input.audit,
      'CREATE',
      { entityType: 'StockAdjustment', entityId: movement.value.movementId },
      {
        metadata: {
          productId: input.productId,
          warehouseId: input.warehouseId,
          quantity: input.quantity,
          value: value.toString(),
          reason: input.reason,
          journalId: posted.value.journalId,
        },
      },
    );

    await eventBus.enqueue(tx, movement.value.events);

    logger.info('Stock adjustment posted', {
      movementId: movement.value.movementId,
      journalId: posted.value.journalId,
      direction: isDecrease ? 'DECREASE' : 'INCREASE',
    });

    return ok({
      movementId: movement.value.movementId,
      movementNumber: movement.value.movementNumber,
      journalId: posted.value.journalId,
      entryNumber: posted.value.entryNumber,
      value: value.toString(),
      direction: isDecrease ? ('DECREASE' as const) : ('INCREASE' as const),
    });
  }
}
