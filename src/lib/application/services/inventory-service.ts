import type { MovementType } from '@prisma/client';
import {
  applyAverageReceipt,
  valueIssue,
  type AveragePosition,
  type CostLayerSnapshot,
  type CostingMethod,
  type LayerConsumption,
} from '@/lib/domain/inventory/costing';
import { createDomainEvent, type DomainEvent } from '@/lib/domain/shared/domain-event';
import { DomainErrors, type DomainError } from '@/lib/domain/shared/errors';
import { Money } from '@/lib/domain/shared/money';
import { Quantity } from '@/lib/domain/shared/quantity';
import { err, ok, type Result } from '@/lib/domain/shared/result';
import { DateOnly } from '@/lib/domain/shared/value-objects';
import { fromMoney, fromQuantity } from '@/lib/infrastructure/db/decimal-mapper';
import type { TransactionClient } from '@/lib/infrastructure/db/prisma';
import { allocateDocumentNumber } from './numbering-service';

/**
 * The stock ledger.
 *
 * Two invariants are maintained here, together, in one transaction:
 *   1. `stock_levels` always equals the sum of the movements behind it.
 *   2. `total_value` always equals `quantity_on_hand * average_cost`.
 *
 * Both are protected by taking a row lock on the stock level *before* reading
 * the quantity that the decision depends on. Without that lock, two concurrent
 * sales of the last unit both read "1 available", both succeed, and the
 * warehouse is short one item that the system says it has.
 */

export interface StockPosition extends AveragePosition {
  readonly stockLevelId: string | null;
  readonly quantityReserved: Quantity;
}

/**
 * Reads a stock position, taking a row lock for the rest of the transaction.
 *
 * Amounts are cast to text in SQL and re-parsed by the domain's decimal types —
 * the value never passes through a JavaScript `number`.
 */
export async function lockStockPosition(
  tx: TransactionClient,
  tenantId: string,
  productId: string,
  warehouseId: string,
  currency: string,
): Promise<StockPosition> {
  const rows = await tx.$queryRaw<
    {
      id: string;
      quantityOnHand: string;
      quantityReserved: string;
      averageCost: string;
      totalValue: string;
    }[]
  >`
    SELECT "id",
           "quantityOnHand"::text   AS "quantityOnHand",
           "quantityReserved"::text AS "quantityReserved",
           "averageCost"::text      AS "averageCost",
           "totalValue"::text       AS "totalValue"
      FROM "stock_levels"
     WHERE "tenantId" = ${tenantId}::uuid
       AND "productId" = ${productId}::uuid
       AND "warehouseId" = ${warehouseId}::uuid
       FOR UPDATE
  `;

  const row = rows[0];

  if (row === undefined) {
    return {
      stockLevelId: null,
      quantityOnHand: Quantity.zero(),
      quantityReserved: Quantity.zero(),
      averageCost: Money.zero(currency),
      totalValue: Money.zero(currency),
    };
  }

  return {
    stockLevelId: row.id,
    quantityOnHand: Quantity.of(row.quantityOnHand),
    quantityReserved: Quantity.of(row.quantityReserved),
    averageCost: Money.of(row.averageCost, currency),
    totalValue: Money.of(row.totalValue, currency),
  };
}

/** Available to promise: what is on hand minus what is already committed. */
export function availableQuantity(position: StockPosition): Quantity {
  return position.quantityOnHand.subtract(position.quantityReserved);
}

export interface MovementIdentity {
  readonly tenantId: string;
  readonly branchId: string;
  readonly warehouseId: string;
  readonly productId: string;
  readonly date: DateOnly;
  readonly createdById: string;
  readonly referenceType?: string;
  readonly referenceId?: string;
  readonly notes?: string;
}

export interface ReceiveStockInput extends MovementIdentity {
  readonly quantity: Quantity;
  readonly unitCost: Money;
  readonly costingMethod: CostingMethod;
  readonly batchNumber?: string;
  readonly serialNumber?: string;
  readonly expiryDate?: DateOnly;
  readonly movementType?: Extract<MovementType, 'IN' | 'RETURN' | 'ADJUSTMENT'>;
}

export interface MovementResult {
  readonly movementId: string;
  readonly movementNumber: string;
  readonly totalCost: Money;
  readonly balanceAfter: Quantity;
  readonly events: readonly DomainEvent[];
}

/**
 * Records a receipt: a purchase, a customer return, or a positive stock count
 * adjustment.
 *
 * Under weighted average the running cost is recomputed from total value over
 * total quantity. Under FIFO a new cost layer is opened. Both happen for every
 * receipt regardless of the active method, so a tenant can switch policy without
 * losing the history the other method needs.
 */
export async function receiveStock(
  tx: TransactionClient,
  input: ReceiveStockInput,
): Promise<Result<MovementResult, DomainError>> {
  if (!input.quantity.isPositive) {
    return err(
      DomainErrors.validation(
        'كمية الإدخال يجب أن تكون أكبر من صفر.',
        'The receipt quantity must be greater than zero.',
        'quantity',
      ),
    );
  }

  const currency = input.unitCost.currency;
  const position = await lockStockPosition(
    tx,
    input.tenantId,
    input.productId,
    input.warehouseId,
    currency,
  );

  const updated = applyAverageReceipt(position, input.quantity, input.unitCost);
  if (!updated.ok) return updated;

  const totalCost = input.unitCost.multiply(input.quantity.toString());
  const movementNumber = await allocateDocumentNumber(
    tx,
    input.tenantId,
    'INVENTORY_MOVEMENT',
    input.date.year,
  );

  const movement = await tx.inventoryMovement.create({
    data: {
      tenantId: input.tenantId,
      movementNumber,
      type: input.movementType ?? 'IN',
      movementDate: input.date.toDate(),
      productId: input.productId,
      warehouseId: input.warehouseId,
      branchId: input.branchId,
      quantity: fromQuantity(input.quantity),
      unitCost: fromMoney(input.unitCost),
      totalCost: fromMoney(totalCost),
      balanceAfter: fromQuantity(updated.value.quantityOnHand),
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      batchNumber: input.batchNumber ?? null,
      serialNumber: input.serialNumber ?? null,
      expiryDate: input.expiryDate?.toDate() ?? null,
      notes: input.notes ?? null,
      createdById: input.createdById,
    },
    select: { id: true },
  });

  await upsertStockLevel(tx, input, updated.value, position.stockLevelId);

  // A FIFO layer is opened for every receipt, even when the tenant currently
  // values at weighted average — switching policy later must not require a
  // history rebuild that the data no longer supports.
  await tx.costLayer.create({
    data: {
      tenantId: input.tenantId,
      productId: input.productId,
      warehouseId: input.warehouseId,
      sourceMovementId: movement.id,
      receivedAt: input.date.toDate(),
      originalQuantity: fromQuantity(input.quantity),
      remainingQuantity: fromQuantity(input.quantity),
      unitCost: fromMoney(input.unitCost),
      batchNumber: input.batchNumber ?? null,
      expiryDate: input.expiryDate?.toDate() ?? null,
    },
  });

  const events: DomainEvent[] = [
    createDomainEvent(
      'inventory.movement.recorded',
      movement.id,
      {
        movementId: movement.id,
        movementNumber,
        type: input.movementType ?? 'IN',
        productId: input.productId,
        warehouseId: input.warehouseId,
        quantity: input.quantity.toString(),
        unitCost: input.unitCost.toString(),
        totalCost: totalCost.toString(),
        balanceAfter: updated.value.quantityOnHand.toString(),
      },
      { correlationId: crypto.randomUUID(), tenantId: input.tenantId },
    ),
  ];

  return ok({
    movementId: movement.id,
    movementNumber,
    totalCost,
    balanceAfter: updated.value.quantityOnHand,
    events,
  });
}

export interface IssueStockInput extends MovementIdentity {
  readonly quantity: Quantity;
  readonly costingMethod: CostingMethod;
  readonly allowNegativeStock: boolean;
  readonly batchNumber?: string;
  readonly serialNumber?: string;
  readonly movementType?: Extract<MovementType, 'OUT' | 'TRANSFER' | 'ADJUSTMENT'>;
  /** For readable refusals — the user needs the product's name, not its uuid. */
  readonly productNameAr: string;
  readonly productNameEn: string;
  readonly warehouseNameAr: string;
  readonly warehouseNameEn: string;
  readonly currency: string;
}

/**
 * Records an issue: a sale, a supplier return, a negative adjustment, or the
 * outbound leg of a transfer.
 *
 * Refuses before writing anything if stock is insufficient or the batch that
 * would be consumed has expired. The refusal names the product, the warehouse
 * and both numbers, because "insufficient stock" alone tells a warehouse clerk
 * nothing they can act on.
 */
export async function issueStock(
  tx: TransactionClient,
  input: IssueStockInput,
): Promise<Result<MovementResult & { consumptions: readonly LayerConsumption[] }, DomainError>> {
  if (!input.quantity.isPositive) {
    return err(
      DomainErrors.validation(
        'كمية الصرف يجب أن تكون أكبر من صفر.',
        'The issue quantity must be greater than zero.',
        'quantity',
      ),
    );
  }

  const position = await lockStockPosition(
    tx,
    input.tenantId,
    input.productId,
    input.warehouseId,
    input.currency,
  );

  const layers = await loadOpenCostLayers(
    tx,
    input.tenantId,
    input.productId,
    input.warehouseId,
    input.currency,
  );

  const valuation = valueIssue({
    method: input.costingMethod,
    layers,
    position,
    quantity: input.quantity,
    allowNegativeStock: input.allowNegativeStock,
    options: {
      issueDate: input.date,
      ...(input.batchNumber !== undefined ? { batchNumber: input.batchNumber } : {}),
      productNameAr: input.productNameAr,
      productNameEn: input.productNameEn,
      warehouseNameAr: input.warehouseNameAr,
      warehouseNameEn: input.warehouseNameEn,
      functionalCurrency: input.currency,
    },
  });

  if (!valuation.ok) return valuation;

  // Weighted average skips the FIFO availability check inside `valueIssue`
  // only when negative stock is permitted; this guard covers the other path.
  if (!input.allowNegativeStock && position.quantityOnHand.lessThan(input.quantity)) {
    return err(
      DomainErrors.insufficientStock(
        input.quantity.toDisplayString(),
        position.quantityOnHand.toDisplayString(),
        input.productNameAr,
        input.productNameEn,
        input.warehouseNameAr,
        input.warehouseNameEn,
      ),
    );
  }

  const movementNumber = await allocateDocumentNumber(
    tx,
    input.tenantId,
    'INVENTORY_MOVEMENT',
    input.date.year,
  );

  const unitCost = input.quantity.isZero
    ? Money.zero(input.currency)
    : valuation.value.totalCost.divide(input.quantity.toString());

  const movement = await tx.inventoryMovement.create({
    data: {
      tenantId: input.tenantId,
      movementNumber,
      type: input.movementType ?? 'OUT',
      movementDate: input.date.toDate(),
      productId: input.productId,
      warehouseId: input.warehouseId,
      branchId: input.branchId,
      quantity: fromQuantity(input.quantity),
      unitCost: fromMoney(unitCost),
      totalCost: fromMoney(valuation.value.totalCost),
      balanceAfter: fromQuantity(valuation.value.resultingPosition.quantityOnHand),
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      batchNumber: input.batchNumber ?? null,
      serialNumber: input.serialNumber ?? null,
      notes: input.notes ?? null,
      createdById: input.createdById,
    },
    select: { id: true },
  });

  await upsertStockLevel(
    tx,
    input,
    valuation.value.resultingPosition,
    position.stockLevelId,
  );

  // Draw down the FIFO layers the valuation decided to consume.
  for (const consumption of valuation.value.consumptions) {
    await tx.costLayer.update({
      where: { id: consumption.layerId },
      data: { remainingQuantity: { decrement: fromQuantity(consumption.quantity) } },
    });
  }

  const events: DomainEvent[] = [
    createDomainEvent(
      'inventory.movement.recorded',
      movement.id,
      {
        movementId: movement.id,
        movementNumber,
        type: input.movementType ?? 'OUT',
        productId: input.productId,
        warehouseId: input.warehouseId,
        quantity: input.quantity.toString(),
        unitCost: unitCost.toString(),
        totalCost: valuation.value.totalCost.toString(),
        balanceAfter: valuation.value.resultingPosition.quantityOnHand.toString(),
      },
      { correlationId: crypto.randomUUID(), tenantId: input.tenantId },
    ),
  ];

  if (valuation.value.resultingPosition.quantityOnHand.lessThanOrEqual(Quantity.zero())) {
    events.push(
      createDomainEvent(
        'inventory.stock.depleted',
        input.productId,
        {
          productId: input.productId,
          warehouseId: input.warehouseId,
          quantityOnHand: valuation.value.resultingPosition.quantityOnHand.toString(),
        },
        { correlationId: crypto.randomUUID(), tenantId: input.tenantId },
      ),
    );
  }

  return ok({
    movementId: movement.id,
    movementNumber,
    totalCost: valuation.value.totalCost,
    balanceAfter: valuation.value.resultingPosition.quantityOnHand,
    consumptions: valuation.value.consumptions,
    events,
  });
}

export interface TransferStockInput extends Omit<MovementIdentity, 'warehouseId'> {
  readonly fromWarehouseId: string;
  readonly toWarehouseId: string;
  readonly quantity: Quantity;
  readonly costingMethod: CostingMethod;
  readonly allowNegativeStock: boolean;
  readonly productNameAr: string;
  readonly productNameEn: string;
  readonly fromWarehouseNameAr: string;
  readonly fromWarehouseNameEn: string;
  readonly currency: string;
  readonly batchNumber?: string;
}

export interface TransferResult {
  readonly transferGroupId: string;
  readonly outMovementId: string;
  readonly inMovementId: string;
  readonly transferredValue: Money;
  readonly events: readonly DomainEvent[];
}

/**
 * Moves stock between warehouses as two linked movements.
 *
 * The pair shares a `transferGroupId` so that a stock card shows an unambiguous
 * "out of A, into B" rather than an unexplained disappearance followed by an
 * unexplained appearance. The receiving warehouse takes on the cost the sending
 * warehouse released, so a transfer moves value without creating or destroying
 * any — no P&L impact, which is the whole point.
 */
export async function transferStock(
  tx: TransactionClient,
  input: TransferStockInput,
): Promise<Result<TransferResult, DomainError>> {
  if (input.fromWarehouseId === input.toWarehouseId) {
    return err(DomainErrors.sameWarehouseTransfer());
  }

  const transferGroupId = crypto.randomUUID();

  const issued = await issueStock(tx, {
    ...input,
    warehouseId: input.fromWarehouseId,
    movementType: 'TRANSFER',
    warehouseNameAr: input.fromWarehouseNameAr,
    warehouseNameEn: input.fromWarehouseNameEn,
    referenceType: input.referenceType ?? 'STOCK_TRANSFER',
    referenceId: input.referenceId ?? transferGroupId,
  });

  if (!issued.ok) return issued;

  const unitCost = issued.value.totalCost.divide(input.quantity.toString());

  const received = await receiveStock(tx, {
    ...input,
    warehouseId: input.toWarehouseId,
    unitCost,
    movementType: 'IN',
    referenceType: input.referenceType ?? 'STOCK_TRANSFER',
    referenceId: input.referenceId ?? transferGroupId,
  });

  if (!received.ok) return received;

  // Stamp both legs so the pair is discoverable from either end.
  await tx.$executeRaw`
    UPDATE "inventory_movements"
       SET "transferGroupId" = ${transferGroupId}::uuid,
           "fromWarehouseId" = ${input.fromWarehouseId}::uuid,
           "toWarehouseId"   = ${input.toWarehouseId}::uuid
     WHERE "id" IN (${issued.value.movementId}::uuid, ${received.value.movementId}::uuid)
       AND "movementDate" = ${input.date.toDate()}::date
  `;

  return ok({
    transferGroupId,
    outMovementId: issued.value.movementId,
    inMovementId: received.value.movementId,
    transferredValue: issued.value.totalCost,
    events: [
      ...issued.value.events,
      ...received.value.events,
      createDomainEvent(
        'inventory.transfer.completed',
        transferGroupId,
        {
          transferGroupId,
          productId: input.productId,
          fromWarehouseId: input.fromWarehouseId,
          toWarehouseId: input.toWarehouseId,
          quantity: input.quantity.toString(),
        },
        { correlationId: crypto.randomUUID(), tenantId: input.tenantId },
      ),
    ],
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Internals
// ─────────────────────────────────────────────────────────────────────────────

async function upsertStockLevel(
  tx: TransactionClient,
  identity: Pick<MovementIdentity, 'tenantId' | 'productId' | 'warehouseId'>,
  position: AveragePosition,
  existingId: string | null,
): Promise<void> {
  const data = {
    quantityOnHand: fromQuantity(position.quantityOnHand),
    averageCost: fromMoney(position.averageCost),
    totalValue: fromMoney(position.totalValue),
    lastMovementAt: new Date(),
  };

  if (existingId !== null) {
    await tx.stockLevel.update({ where: { id: existingId }, data });
    return;
  }

  await tx.stockLevel.create({
    data: {
      tenantId: identity.tenantId,
      productId: identity.productId,
      warehouseId: identity.warehouseId,
      ...data,
    },
  });
}

async function loadOpenCostLayers(
  tx: TransactionClient,
  tenantId: string,
  productId: string,
  warehouseId: string,
  currency: string,
): Promise<CostLayerSnapshot[]> {
  const layers = await tx.costLayer.findMany({
    where: {
      tenantId,
      productId,
      warehouseId,
      remainingQuantity: { gt: 0 },
    },
    orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      remainingQuantity: true,
      unitCost: true,
      receivedAt: true,
      batchNumber: true,
      expiryDate: true,
    },
  });

  return layers.map((layer) => ({
    id: layer.id,
    remainingQuantity: Quantity.of(layer.remainingQuantity.toFixed(4)),
    unitCost: Money.of(layer.unitCost.toFixed(4), currency),
    receivedAt: layer.receivedAt,
    batchNumber: layer.batchNumber,
    expiryDate: layer.expiryDate === null ? null : DateOnly.fromDate(layer.expiryDate),
  }));
}
