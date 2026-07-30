import { Prisma } from '@prisma/client';
import { DomainErrors, type DomainError } from '@/lib/domain/shared/errors';
import { err, ok, type Result } from '@/lib/domain/shared/result';
import { DateOnly } from '@/lib/domain/shared/value-objects';
import type { AuditContext } from '@/lib/infrastructure/audit/audit-logger';
import { recordAudit } from '@/lib/infrastructure/audit/audit-logger';
import { withTenantRead, withTransaction } from '@/lib/infrastructure/db/prisma';
import { logger } from '@/lib/infrastructure/logging/logger';
import { applyAdjustment } from './stock-operations-service';

/**
 * Physical stock counts.
 *
 * ## The one decision the whole feature rests on
 *
 * `expectedQuantity` is written when the sheet is **opened** and never recomputed. The naive
 * alternative — compare the typed count against `stock_levels` at save time — produces
 * variances that are arithmetic artefacts: a line counted at 09:00 and saved at 16:00 is
 * measured against a balance that absorbed a whole day of sales. The manager cannot tell those
 * from real losses, and a count whose entire purpose is finding real losses becomes noise.
 *
 * Freezing is enforced by `trg_stock_count_lines_immutability` rather than by this service
 * keeping its word, so a repair script or a future refactor cannot quietly unfreeze it.
 *
 * ## Variances post through `applyAdjustment`, not around it
 *
 * Finalisation calls the same function the manual adjustment screen calls, inside one
 * transaction. A parallel implementation would be a second place for the journal's direction,
 * the costing of an increase and the zero-value refusal to drift — and the drift would surface
 * as a count whose adjustments differ from an identical manual one.
 *
 * That also means every refusal `applyAdjustment` makes applies here: a shortage larger than
 * the position is refused by `erp_negative_stock_guard`, and the whole finalisation rolls back
 * rather than posting half a sheet.
 *
 * ## Uncounted lines are skipped, not treated as zero
 *
 * `countedQuantity IS NULL` means nobody reached that line. Writing those off would turn an
 * abandoned afternoon into a total write-down of everything untouched. The sheet reports how
 * many were left, and finalising with lines outstanding is allowed *and* reported — a partial
 * count of the fast-moving lines is a legitimate way to run one.
 */

export type StockCountStatus = 'COUNTING' | 'COMPLETED' | 'CANCELLED';

export interface StockCountLineView {
  readonly id: string;
  readonly productId: string;
  readonly sku: string;
  readonly nameAr: string;
  readonly expectedQuantity: string;
  readonly countedQuantity: string | null;
  readonly unitCostAtOpen: string;
  /** `counted − expected`, or `null` while uncounted. Never inferred as zero. */
  readonly variance: string | null;
  readonly varianceValue: string | null;
  readonly adjustmentMovementId: string | null;
}

export interface StockCountView {
  readonly id: string;
  readonly countNumber: string;
  readonly status: StockCountStatus;
  readonly countDate: string;
  readonly notes: string | null;
  readonly warehouse: { id: string; code: string; nameAr: string };
  readonly branchId: string;
  readonly openedAt: string;
  readonly finalisedAt: string | null;
  readonly lines: readonly StockCountLineView[];
  readonly summary: {
    totalLines: number;
    countedLines: number;
    varianceLines: number;
    shortageValue: string;
    surplusValue: string;
    netValue: string;
  };
}

function lineView(line: {
  id: string;
  productId: string;
  expectedQuantity: Prisma.Decimal;
  countedQuantity: Prisma.Decimal | null;
  unitCostAtOpen: Prisma.Decimal;
  adjustmentMovementId: string | null;
  product: { sku: string; nameAr: string };
}): StockCountLineView {
  const variance =
    line.countedQuantity === null ? null : line.countedQuantity.minus(line.expectedQuantity);

  return {
    id: line.id,
    productId: line.productId,
    sku: line.product.sku,
    nameAr: line.product.nameAr,
    expectedQuantity: line.expectedQuantity.toString(),
    countedQuantity: line.countedQuantity === null ? null : line.countedQuantity.toString(),
    unitCostAtOpen: line.unitCostAtOpen.toString(),
    variance: variance === null ? null : variance.toString(),
    varianceValue: variance === null ? null : variance.times(line.unitCostAtOpen).toString(),
    adjustmentMovementId: line.adjustmentMovementId,
  };
}

/**
 * Opens a sheet for a warehouse and freezes the position of everything in it.
 *
 * Only products with a `stock_levels` row are included. A product that has never been in this
 * warehouse has no expected quantity to freeze, and putting it on the sheet at zero would
 * invite a counter to record stock the system would then have to value from nothing — which is
 * the case the manual adjustment screen exists for, with an explicit unit cost.
 */
export async function openStockCount(input: {
  tenantId: string;
  userId: string;
  audit: AuditContext;
  warehouseId: string;
  countDate: string;
  notes?: string;
}): Promise<Result<{ countId: string; countNumber: string; lineCount: number }, DomainError>> {
  const date = DateOnly.create(input.countDate);
  if (!date.ok) return date;

  return withTransaction(async (tx) => {
    const warehouse = await tx.warehouse.findFirst({
      where: { id: input.warehouseId, tenantId: input.tenantId },
      select: { id: true, code: true, branchId: true },
    });

    if (warehouse === null) {
      return err(DomainErrors.notFound('المستودع', 'Warehouse', input.warehouseId));
    }

    // One open sheet per warehouse. Two would let the same shelf be counted twice against two
    // different frozen positions, and finalising both would post the variance twice.
    const existing = await tx.stockCount.findFirst({
      where: { tenantId: input.tenantId, warehouseId: input.warehouseId, status: 'COUNTING' },
      select: { id: true, countNumber: true },
    });

    if (existing !== null) {
      return err(
        DomainErrors.validation(
          `يوجد جرد مفتوح لهذا المستودع بالفعل (${existing.countNumber}). أغلقه أو ألغِه أولاً.`,
          `Stock count ${existing.countNumber} is already open for this warehouse.`,
        ),
      );
    }

    const positions = await tx.stockLevel.findMany({
      where: { tenantId: input.tenantId, warehouseId: input.warehouseId },
      select: { productId: true, quantityOnHand: true, averageCost: true },
    });

    if (positions.length === 0) {
      return err(
        DomainErrors.validation(
          'لا توجد أرصدة في هذا المستودع لجردها.',
          'This warehouse holds no stock to count.',
        ),
      );
    }

    // Numbered from the count of sheets rather than through `erp_next_document_number`: a
    // stock count is not a financial document, its number is a label, and taking one from the
    // shared sequence would put a gap in a series an auditor reads as gapless.
    const sequence = await tx.stockCount.count({ where: { tenantId: input.tenantId } });
    const countNumber = `SC-${date.value.year}-${String(sequence + 1).padStart(5, '0')}`;

    const count = await tx.stockCount.create({
      data: {
        tenantId: input.tenantId,
        countNumber,
        warehouseId: warehouse.id,
        branchId: warehouse.branchId,
        status: 'COUNTING',
        countDate: date.value.toDate(),
        openedById: input.userId,
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
      select: { id: true },
    });

    await tx.stockCountLine.createMany({
      data: positions.map((position) => ({
        tenantId: input.tenantId,
        countId: count.id,
        productId: position.productId,
        expectedQuantity: position.quantityOnHand,
        unitCostAtOpen: position.averageCost,
      })),
    });

    await recordAudit(
      tx,
      input.audit,
      'CREATE',
      { entityType: 'StockCount', entityId: count.id },
      {
        metadata: {
          countNumber,
          warehouseId: warehouse.id,
          warehouseCode: warehouse.code,
          lineCount: positions.length,
        },
      },
    );

    logger.info('Stock count opened', {
      countId: count.id,
      countNumber,
      lines: positions.length,
    });

    return ok({ countId: count.id, countNumber, lineCount: positions.length });
  });
}

/** Records counted quantities. Idempotent per line: recounting overwrites. */
export async function recordCountedQuantities(input: {
  tenantId: string;
  userId: string;
  countId: string;
  entries: readonly { lineId: string; countedQuantity: string | null }[];
}): Promise<Result<{ updated: number }, DomainError>> {
  return withTransaction(async (tx) => {
    const count = await tx.stockCount.findFirst({
      where: { id: input.countId, tenantId: input.tenantId },
      select: { status: true },
    });

    if (count === null) return err(DomainErrors.notFound('الجرد', 'Stock count', input.countId));

    if (count.status !== 'COUNTING') {
      return err(
        DomainErrors.validation(
          'لا يمكن تعديل جرد مُغلق.',
          'A finalised or cancelled count cannot be edited.',
        ),
      );
    }

    const now = new Date();
    let updated = 0;

    for (const entry of input.entries) {
      const parsed =
        entry.countedQuantity === null || entry.countedQuantity.trim() === ''
          ? null
          : entry.countedQuantity.trim();

      if (parsed !== null && !/^\d+(\.\d{1,4})?$/.test(parsed)) {
        return err(
          DomainErrors.invalidFormat('الكمية المعدودة', 'countedQuantity', '12.5', 'countedQuantity'),
        );
      }

      // `updateMany` with the tenant in the predicate: a line id from another tenant updates
      // nothing rather than throwing, and cannot reach a row it does not own.
      const result = await tx.stockCountLine.updateMany({
        where: { id: entry.lineId, tenantId: input.tenantId, countId: input.countId },
        data:
          parsed === null
            ? { countedQuantity: null, countedById: null, countedAt: null }
            : { countedQuantity: parsed, countedById: input.userId, countedAt: now },
      });

      updated += result.count;
    }

    return ok({ updated });
  });
}

export interface FinaliseOutcome {
  readonly countId: string;
  readonly countNumber: string;
  readonly adjustmentsPosted: number;
  readonly uncountedLines: number;
  readonly netValue: string;
}

/**
 * Posts every variance as a stock adjustment, in one transaction.
 *
 * All-or-nothing on purpose. A sheet that posted forty of its fifty variances and then hit a
 * negative-stock refusal would leave the warehouse in a state no one could reason about: the
 * register would show a completed count whose adjustments are partial, and re-running it would
 * double the forty that landed.
 */
export async function finaliseStockCount(input: {
  tenantId: string;
  userId: string;
  audit: AuditContext;
  countId: string;
}): Promise<Result<FinaliseOutcome, DomainError>> {
  return withTransaction(async (tx) => {
    const count = await tx.stockCount.findFirst({
      where: { id: input.countId, tenantId: input.tenantId },
      select: {
        id: true,
        countNumber: true,
        status: true,
        countDate: true,
        warehouseId: true,
        branchId: true,
        lines: {
          select: {
            id: true,
            productId: true,
            expectedQuantity: true,
            countedQuantity: true,
            unitCostAtOpen: true,
            product: { select: { sku: true, nameAr: true } },
          },
        },
      },
    });

    if (count === null) return err(DomainErrors.notFound('الجرد', 'Stock count', input.countId));

    if (count.status !== 'COUNTING') {
      return err(
        DomainErrors.validation(
          'هذا الجرد مُغلق بالفعل.',
          'This count has already been finalised or cancelled.',
        ),
      );
    }

    const counted = count.lines.filter((line) => line.countedQuantity !== null);
    const uncounted = count.lines.length - counted.length;

    if (counted.length === 0) {
      return err(
        DomainErrors.validation(
          'لم تُدخَل أي كمية معدودة — لا يوجد ما يُرحَّل.',
          'No quantities were counted, so there is nothing to post.',
        ),
      );
    }

    const countDate = count.countDate.toISOString().slice(0, 10);
    let posted = 0;
    let net = new Prisma.Decimal(0);

    for (const line of counted) {
      const variance = line.countedQuantity!.minus(line.expectedQuantity);
      // A line that matched is the desired outcome, not an event. Posting a zero adjustment
      // would be refused by `validate()` anyway — an empty entry is not an entry.
      if (variance.isZero()) continue;

      const adjustment = await applyAdjustment(tx, {
        tenantId: input.tenantId,
        userId: input.userId,
        audit: input.audit,
        branchId: count.branchId,
        productId: line.productId,
        warehouseId: count.warehouseId,
        quantity: variance.toString(),
        date: countDate,
        reason: `جرد فعلي ${count.countNumber} — ${line.product.sku}`,
        // The cost frozen at open, so a shortage is valued at what the stock was worth when
        // counting began rather than at whatever the average has drifted to since.
        ...(variance.greaterThan(0) ? { unitCost: line.unitCostAtOpen.toString() } : {}),
      });

      if (!adjustment.ok) return adjustment;

      await tx.stockCountLine.update({
        where: { id: line.id },
        data: { adjustmentMovementId: adjustment.value.movementId },
      });

      posted += 1;
      net = net.plus(variance.times(line.unitCostAtOpen));
    }

    await tx.stockCount.update({
      where: { id: count.id },
      data: { status: 'COMPLETED', finalisedById: input.userId, finalisedAt: new Date() },
    });

    await recordAudit(
      tx,
      input.audit,
      'POST',
      { entityType: 'StockCount', entityId: count.id },
      {
        metadata: {
          countNumber: count.countNumber,
          adjustmentsPosted: posted,
          countedLines: counted.length,
          uncountedLines: uncounted,
          netValue: net.toString(),
        },
      },
    );

    logger.info('Stock count finalised', {
      countId: count.id,
      countNumber: count.countNumber,
      adjustmentsPosted: posted,
      uncountedLines: uncounted,
    });

    return ok({
      countId: count.id,
      countNumber: count.countNumber,
      adjustmentsPosted: posted,
      uncountedLines: uncounted,
      netValue: net.toString(),
    });
  });
}

/** Abandons a sheet without posting anything. */
export async function cancelStockCount(input: {
  tenantId: string;
  userId: string;
  audit: AuditContext;
  countId: string;
}): Promise<Result<{ countId: string }, DomainError>> {
  return withTransaction(async (tx) => {
    const count = await tx.stockCount.findFirst({
      where: { id: input.countId, tenantId: input.tenantId },
      select: { status: true, countNumber: true },
    });

    if (count === null) return err(DomainErrors.notFound('الجرد', 'Stock count', input.countId));

    if (count.status !== 'COUNTING') {
      return err(
        DomainErrors.validation('هذا الجرد مُغلق بالفعل.', 'This count is already closed.'),
      );
    }

    await tx.stockCount.update({
      where: { id: input.countId },
      data: { status: 'CANCELLED', finalisedById: input.userId, finalisedAt: new Date() },
    });

    // Kept rather than deleted. An abandoned count is evidence that someone started one, and
    // the frozen positions are the only record of what the warehouse claimed at that moment.
    await recordAudit(
      tx,
      input.audit,
      'VOID',
      { entityType: 'StockCount', entityId: input.countId },
      { metadata: { countNumber: count.countNumber } },
    );

    return ok({ countId: input.countId });
  });
}

/** One sheet with its lines and the variance summary. */
export async function getStockCount(input: {
  tenantId: string;
  countId: string;
}): Promise<Result<StockCountView, DomainError>> {
  return withTenantRead(async (tx) => {
    const count = await tx.stockCount.findFirst({
      where: { id: input.countId, tenantId: input.tenantId },
      select: {
        id: true,
        countNumber: true,
        status: true,
        countDate: true,
        notes: true,
        branchId: true,
        openedAt: true,
        finalisedAt: true,
        warehouse: { select: { id: true, code: true, nameAr: true } },
        lines: {
          select: {
            id: true,
            productId: true,
            expectedQuantity: true,
            countedQuantity: true,
            unitCostAtOpen: true,
            adjustmentMovementId: true,
            product: { select: { sku: true, nameAr: true } },
          },
          orderBy: { product: { sku: 'asc' } },
        },
      },
    });

    if (count === null) return err(DomainErrors.notFound('الجرد', 'Stock count', input.countId));

    const lines = count.lines.map(lineView);

    let shortage = new Prisma.Decimal(0);
    let surplus = new Prisma.Decimal(0);
    let varianceLines = 0;

    for (const line of lines) {
      if (line.varianceValue === null) continue;
      const value = new Prisma.Decimal(line.varianceValue);
      if (value.isZero()) continue;
      varianceLines += 1;
      if (value.isNegative()) shortage = shortage.plus(value.abs());
      else surplus = surplus.plus(value);
    }

    return ok({
      id: count.id,
      countNumber: count.countNumber,
      status: count.status as StockCountStatus,
      countDate: count.countDate.toISOString().slice(0, 10),
      notes: count.notes,
      warehouse: count.warehouse,
      branchId: count.branchId,
      openedAt: count.openedAt.toISOString(),
      finalisedAt: count.finalisedAt === null ? null : count.finalisedAt.toISOString(),
      lines,
      summary: {
        totalLines: lines.length,
        countedLines: lines.filter((line) => line.countedQuantity !== null).length,
        varianceLines,
        shortageValue: shortage.toString(),
        surplusValue: surplus.toString(),
        netValue: surplus.minus(shortage).toString(),
      },
    });
  });
}

/** The register, newest first. */
export async function listStockCounts(input: {
  tenantId: string;
  page: number;
  pageSize: number;
}): Promise<{
  rows: {
    id: string;
    countNumber: string;
    status: string;
    countDate: string;
    warehouseCode: string;
    warehouseNameAr: string;
    totalLines: number;
    countedLines: number;
    finalisedAt: string | null;
  }[];
  total: number;
}> {
  return withTenantRead(async (tx) => {
    const where = { tenantId: input.tenantId };

    const [rows, total] = await Promise.all([
      tx.stockCount.findMany({
        where,
        select: {
          id: true,
          countNumber: true,
          status: true,
          countDate: true,
          finalisedAt: true,
          warehouse: { select: { code: true, nameAr: true } },
          _count: { select: { lines: true } },
        },
        orderBy: [{ countDate: 'desc' }, { countNumber: 'desc' }],
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
      }),
      tx.stockCount.count({ where }),
    ]);

    // Counted lines per sheet in one grouped query rather than one per row.
    const countedByCount = await tx.stockCountLine.groupBy({
      by: ['countId'],
      where: {
        tenantId: input.tenantId,
        countId: { in: rows.map((row) => row.id) },
        countedQuantity: { not: null },
      },
      _count: { _all: true },
    });

    const countedMap = new Map(
      countedByCount.map((entry) => [entry.countId, entry._count._all]),
    );

    return {
      rows: rows.map((row) => ({
        id: row.id,
        countNumber: row.countNumber,
        status: row.status,
        countDate: row.countDate.toISOString().slice(0, 10),
        warehouseCode: row.warehouse.code,
        warehouseNameAr: row.warehouse.nameAr,
        totalLines: row._count.lines,
        countedLines: countedMap.get(row.id) ?? 0,
        finalisedAt: row.finalisedAt === null ? null : row.finalisedAt.toISOString(),
      })),
      total,
    };
  });
}
