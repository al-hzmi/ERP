import { DomainErrors, type DomainError } from '../shared/errors';
import { Money } from '../shared/money';
import { Quantity } from '../shared/quantity';
import { err, ok, type Result } from '../shared/result';
import { DateOnly } from '../shared/value-objects';

/**
 * Inventory valuation, per IAS 2.
 *
 * Two policies are supported, and both live here as pure functions over
 * immutable snapshots: the caller loads state, asks what the answer is, and
 * writes the result back. Nothing in this file touches a database or a clock,
 * so every costing scenario — including the awkward ones — is unit-testable.
 *
 *   FIFO             — cost layers consumed oldest first, exact per-layer costing.
 *   Weighted average — a single running average per product/warehouse.
 */

export type CostingMethod = 'FIFO' | 'WEIGHTED_AVERAGE';

/** An open (or partially consumed) FIFO layer. */
export interface CostLayerSnapshot {
  readonly id: string;
  readonly remainingQuantity: Quantity;
  readonly unitCost: Money;
  readonly receivedAt: Date;
  readonly batchNumber: string | null;
  readonly expiryDate: DateOnly | null;
}

/** How much was taken from one layer, and what it cost. */
export interface LayerConsumption {
  readonly layerId: string;
  readonly quantity: Quantity;
  readonly unitCost: Money;
  readonly amount: Money;
  readonly batchNumber: string | null;
}

export interface IssueCostResult {
  /** Which layers were drawn down, in the order they were consumed. */
  readonly consumptions: readonly LayerConsumption[];
  /** Total cost of goods sold for this issue. */
  readonly totalCost: Money;
  /** Weighted unit cost of the issue as a whole — for reporting, not for posting. */
  readonly averageUnitCost: Money;
}

export interface IssueCostOptions {
  /** Issue date, used to reject expired stock. Defaults to today. */
  readonly issueDate?: DateOnly;
  /** When set, only layers of this batch are eligible. */
  readonly batchNumber?: string;
  /** Product identity, for readable error messages. */
  readonly productNameAr: string;
  readonly productNameEn: string;
  readonly warehouseNameAr: string;
  readonly warehouseNameEn: string;
  readonly functionalCurrency: string;
}

/**
 * Consumes `quantity` from the given layers, oldest first.
 *
 * Refuses rather than improvises: if the layers cannot cover the request, or if
 * the oldest eligible layer has expired, nothing is consumed and the caller gets
 * a message naming the product, the warehouse and the actual numbers. Silently
 * issuing at zero cost — the usual shortcut — corrupts COGS for the whole period.
 */
export function consumeFifo(
  layers: readonly CostLayerSnapshot[],
  quantity: Quantity,
  options: IssueCostOptions,
): Result<IssueCostResult, DomainError> {
  const currency = options.functionalCurrency;

  if (!quantity.isPositive) {
    return err(
      DomainErrors.validation(
        'الكمية المطلوبة يجب أن تكون أكبر من صفر.',
        'The requested quantity must be greater than zero.',
        'quantity',
      ),
    );
  }

  const issueDate = options.issueDate ?? DateOnly.today();

  const eligible = layers
    .filter((layer) => layer.remainingQuantity.isPositive)
    .filter((layer) =>
      options.batchNumber === undefined ? true : layer.batchNumber === options.batchNumber,
    )
    // Oldest receipt first; ties broken by layer id so the result is deterministic.
    .sort((a, b) => {
      const delta = a.receivedAt.getTime() - b.receivedAt.getTime();
      return delta !== 0 ? delta : a.id.localeCompare(b.id);
    });

  const available = Quantity.sum(eligible.map((layer) => layer.remainingQuantity));
  if (available.lessThan(quantity)) {
    return err(
      DomainErrors.insufficientStock(
        quantity.toDisplayString(),
        available.toDisplayString(),
        options.productNameAr,
        options.productNameEn,
        options.warehouseNameAr,
        options.warehouseNameEn,
      ),
    );
  }

  const consumptions: LayerConsumption[] = [];
  let remaining = quantity;
  let totalCost = Money.zero(currency);

  for (const layer of eligible) {
    if (!remaining.isPositive) break;

    // Expiry is checked only on layers we would actually touch. An expired layer
    // sitting behind enough fresh stock is a reporting problem, not a blocker.
    if (layer.expiryDate !== null && layer.expiryDate.isBefore(issueDate)) {
      return err(
        DomainErrors.expiredBatch(
          layer.batchNumber ?? layer.id,
          layer.expiryDate.toString(),
          options.productNameAr,
          options.productNameEn,
        ),
      );
    }

    const taken = Quantity.min(remaining, layer.remainingQuantity);
    const amount = layer.unitCost.multiply(taken.toString());

    consumptions.push({
      layerId: layer.id,
      quantity: taken,
      unitCost: layer.unitCost,
      amount,
      batchNumber: layer.batchNumber,
    });

    totalCost = totalCost.add(amount);
    remaining = remaining.subtract(taken);
  }

  const averageUnitCost = quantity.isZero
    ? Money.zero(currency)
    : totalCost.divide(quantity.toString());

  return ok({ consumptions, totalCost, averageUnitCost });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Weighted average
// ─────────────────────────────────────────────────────────────────────────────

export interface AveragePosition {
  readonly quantityOnHand: Quantity;
  readonly averageCost: Money;
  readonly totalValue: Money;
}

/**
 * Folds a receipt into a weighted-average position.
 *
 * The average is recomputed from total value over total quantity rather than by
 * adjusting the old average, so it can never drift: the invariant
 * `totalValue == quantityOnHand * averageCost` holds after every receipt, to the
 * limit of 4-decimal representation.
 */
export function applyAverageReceipt(
  position: AveragePosition,
  receiptQuantity: Quantity,
  receiptUnitCost: Money,
): Result<AveragePosition, DomainError> {
  if (!receiptQuantity.isPositive) {
    return err(
      DomainErrors.validation(
        'كمية الإدخال يجب أن تكون أكبر من صفر.',
        'The receipt quantity must be greater than zero.',
        'quantity',
      ),
    );
  }

  const currency = receiptUnitCost.currency;
  const receiptValue = receiptUnitCost.multiply(receiptQuantity.toString());
  const newQuantity = position.quantityOnHand.add(receiptQuantity);
  const newValue = position.totalValue.add(receiptValue);

  // A receipt into a negative position (permitted only when the tenant allows
  // negative stock) can leave zero on hand; the average then resets to the
  // receipt cost rather than dividing by zero.
  const newAverage = newQuantity.isPositive
    ? newValue.divide(newQuantity.toString())
    : receiptUnitCost;

  return ok({
    quantityOnHand: newQuantity,
    averageCost: newAverage,
    totalValue: newValue,
  });
}

/**
 * Draws down a weighted-average position.
 *
 * The issue is costed at the *current* average — the average itself is not
 * changed by an issue, which is the defining property of the method.
 */
export function applyAverageIssue(
  position: AveragePosition,
  issueQuantity: Quantity,
  options: Pick<
    IssueCostOptions,
    'productNameAr' | 'productNameEn' | 'warehouseNameAr' | 'warehouseNameEn'
  >,
  allowNegativeStock = false,
): Result<{ position: AveragePosition; cost: Money }, DomainError> {
  if (!issueQuantity.isPositive) {
    return err(
      DomainErrors.validation(
        'كمية الصرف يجب أن تكون أكبر من صفر.',
        'The issue quantity must be greater than zero.',
        'quantity',
      ),
    );
  }

  if (!allowNegativeStock && position.quantityOnHand.lessThan(issueQuantity)) {
    return err(
      DomainErrors.insufficientStock(
        issueQuantity.toDisplayString(),
        position.quantityOnHand.toDisplayString(),
        options.productNameAr,
        options.productNameEn,
        options.warehouseNameAr,
        options.warehouseNameEn,
      ),
    );
  }

  const cost = position.averageCost.multiply(issueQuantity.toString());
  const newQuantity = position.quantityOnHand.subtract(issueQuantity);
  const newValue = position.totalValue.subtract(cost);

  return ok({
    position: {
      quantityOnHand: newQuantity,
      // An issue never moves the average — that is what defines the method.
      averageCost: position.averageCost,
      // Fully depleting a position zeroes its value rather than leaving a
      // rounding residue behind to distort the next receipt's average.
      totalValue: newQuantity.isZero ? Money.zero(cost.currency) : newValue,
    },
    cost,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Unified entry point
// ─────────────────────────────────────────────────────────────────────────────

export interface IssueValuationInput {
  readonly method: CostingMethod;
  readonly layers: readonly CostLayerSnapshot[];
  readonly position: AveragePosition;
  readonly quantity: Quantity;
  readonly options: IssueCostOptions;
  readonly allowNegativeStock: boolean;
}

export interface IssueValuation {
  readonly totalCost: Money;
  readonly unitCost: Money;
  /** Empty under weighted average; populated under FIFO so layers can be drawn down. */
  readonly consumptions: readonly LayerConsumption[];
  readonly resultingPosition: AveragePosition;
}

/**
 * Values an issue under whichever policy applies, so callers never branch on the
 * costing method themselves. Adding a third method (standard cost, specific
 * identification) touches this function and nothing else.
 */
export function valueIssue(input: IssueValuationInput): Result<IssueValuation, DomainError> {
  if (input.method === 'FIFO') {
    const fifo = consumeFifo(input.layers, input.quantity, input.options);
    if (!fifo.ok) return fifo;

    const newQuantity = input.position.quantityOnHand.subtract(input.quantity);
    const newValue = input.position.totalValue.subtract(fifo.value.totalCost);

    return ok({
      totalCost: fifo.value.totalCost,
      unitCost: fifo.value.averageUnitCost,
      consumptions: fifo.value.consumptions,
      resultingPosition: {
        quantityOnHand: newQuantity,
        averageCost: newQuantity.isPositive
          ? newValue.divide(newQuantity.toString())
          : input.position.averageCost,
        totalValue: newQuantity.isZero ? Money.zero(newValue.currency) : newValue,
      },
    });
  }

  const average = applyAverageIssue(
    input.position,
    input.quantity,
    input.options,
    input.allowNegativeStock,
  );
  if (!average.ok) return average;

  return ok({
    totalCost: average.value.cost,
    unitCost: input.position.averageCost,
    consumptions: [],
    resultingPosition: average.value.position,
  });
}

/**
 * Lists layers that are expired as at `asOf` and still carry stock.
 * Feeds the expiry report and the pre-issue warning banner.
 */
export function findExpiredLayers(
  layers: readonly CostLayerSnapshot[],
  asOf: DateOnly = DateOnly.today(),
): CostLayerSnapshot[] {
  return layers.filter(
    (layer) =>
      layer.remainingQuantity.isPositive &&
      layer.expiryDate !== null &&
      layer.expiryDate.isBefore(asOf),
  );
}

/** Layers expiring within `days`, so purchasing can act before they are a loss. */
export function findExpiringLayers(
  layers: readonly CostLayerSnapshot[],
  days: number,
  asOf: DateOnly = DateOnly.today(),
): CostLayerSnapshot[] {
  const horizon = asOf.addDays(days);
  return layers.filter(
    (layer) =>
      layer.remainingQuantity.isPositive &&
      layer.expiryDate !== null &&
      !layer.expiryDate.isBefore(asOf) &&
      !layer.expiryDate.isAfter(horizon),
  );
}
