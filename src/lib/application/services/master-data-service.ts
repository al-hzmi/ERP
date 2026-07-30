import { Prisma } from '@prisma/client';
import { DomainErrors, type DomainError } from '@/lib/domain/shared/errors';
import { err, ok, type Result } from '@/lib/domain/shared/result';
import type { AuditContext } from '@/lib/infrastructure/audit/audit-logger';
import { recordAudit } from '@/lib/infrastructure/audit/audit-logger';
import { withTenantRead, withTransaction } from '@/lib/infrastructure/db/prisma';

/**
 * The small reference tables: categories, brands, units of measure and cost centres.
 *
 * One service for four models because they are the same shape — a code, two names, an active
 * flag — and the only interesting differences are which of them is used where. Four
 * near-identical services would be four places for the duplicate-code refusal to drift.
 *
 * ## What these screens deliberately cannot do
 *
 * **Delete.** Every one of these is referenced by rows that outlive it: a category by
 * products, a unit by everything ever priced in it, a cost centre by journal lines already
 * posted. The foreign keys are `ON DELETE RESTRICT`, so a delete button would fail on any
 * record old enough to matter and succeed only on ones nobody minded. Deactivating is the
 * operation that exists, and it is the honest one — history keeps its references and nothing
 * new can be filed against a dead code.
 *
 * **Renumber.** The code is the join key humans use across reports and imports. Changing it
 * silently rewrites the meaning of every document already printed with it.
 */

export type MasterDataKind = 'category' | 'brand' | 'unit' | 'costCenter';

export interface MasterDataRow {
  readonly id: string;
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly isActive: boolean;
  /** How many records point at this one. What makes deactivating meaningful. */
  readonly usageCount: number;
  /** Kind-specific extra, already formatted for display. */
  readonly detail: string | null;
}

export interface MasterDataDefinition {
  readonly titleAr: string;
  readonly descriptionAr: string;
  /** Label for the kind-specific column, or `null` when there is none. */
  readonly detailLabelAr: string | null;
  readonly usageLabelAr: string;
  readonly codeLabelAr: string;
  /** Brands have no code of their own in this schema — the English name is the key. */
  readonly hasCode: boolean;
  readonly resource: string;
}

export const MASTER_DATA: Record<MasterDataKind, MasterDataDefinition> = {
  category: {
    titleAr: 'التصنيفات',
    descriptionAr: 'تصنيف الأصناف — يُستخدم في تجميع تقارير المبيعات والمخزون',
    detailLabelAr: 'التصنيف الأب',
    usageLabelAr: 'الأصناف',
    codeLabelAr: 'الرمز',
    hasCode: true,
    resource: 'inventory.product',
  },
  brand: {
    titleAr: 'الماركات',
    descriptionAr: 'العلامات التجارية المرتبطة بالأصناف',
    detailLabelAr: null,
    usageLabelAr: 'الأصناف',
    codeLabelAr: 'الاسم بالإنجليزية',
    hasCode: false,
    resource: 'inventory.product',
  },
  unit: {
    titleAr: 'وحدات القياس',
    descriptionAr: 'وحدات البيع والشراء ومعامل التحويل إلى الوحدة الأساسية',
    detailLabelAr: 'معامل التحويل',
    usageLabelAr: 'الأصناف',
    codeLabelAr: 'الرمز',
    hasCode: true,
    resource: 'inventory.product',
  },
  costCenter: {
    titleAr: 'مراكز التكلفة',
    descriptionAr: 'أبعاد تحليلية تُوسم بها سطور القيود لتقارير الربحية',
    detailLabelAr: null,
    usageLabelAr: 'سطور القيود',
    codeLabelAr: 'الرمز',
    hasCode: true,
    resource: 'finance.journal',
  },
};

export async function listMasterData(input: {
  tenantId: string;
  kind: MasterDataKind;
  includeInactive: boolean;
}): Promise<MasterDataRow[]> {
  return withTenantRead(async (tx) => {
    const activeFilter = input.includeInactive ? {} : { isActive: true };

    if (input.kind === 'category') {
      const rows = await tx.category.findMany({
        where: { tenantId: input.tenantId, ...activeFilter },
        select: {
          id: true,
          code: true,
          nameAr: true,
          nameEn: true,
          isActive: true,
          parent: { select: { nameAr: true } },
          _count: { select: { products: true } },
        },
        orderBy: { code: 'asc' },
      });

      return rows.map((row) => ({
        id: row.id,
        code: row.code,
        nameAr: row.nameAr,
        nameEn: row.nameEn,
        isActive: row.isActive,
        usageCount: row._count.products,
        detail: row.parent?.nameAr ?? null,
      }));
    }

    if (input.kind === 'brand') {
      const rows = await tx.brand.findMany({
        where: { tenantId: input.tenantId, ...activeFilter },
        select: {
          id: true,
          nameAr: true,
          nameEn: true,
          isActive: true,
          _count: { select: { products: true } },
        },
        orderBy: { nameEn: 'asc' },
      });

      return rows.map((row) => ({
        id: row.id,
        // The unique key for a brand is its English name; there is no code column.
        code: row.nameEn,
        nameAr: row.nameAr,
        nameEn: row.nameEn,
        isActive: row.isActive,
        usageCount: row._count.products,
        detail: null,
      }));
    }

    if (input.kind === 'unit') {
      const rows = await tx.unitOfMeasure.findMany({
        where: { tenantId: input.tenantId, ...activeFilter },
        select: {
          id: true,
          code: true,
          nameAr: true,
          nameEn: true,
          baseFactor: true,
          isActive: true,
          _count: { select: { products: true } },
        },
        orderBy: { code: 'asc' },
      });

      return rows.map((row) => ({
        id: row.id,
        code: row.code,
        nameAr: row.nameAr,
        nameEn: row.nameEn,
        isActive: row.isActive,
        usageCount: row._count.products,
        detail: row.baseFactor.toString(),
      }));
    }

    const rows = await tx.costCenter.findMany({
      where: { tenantId: input.tenantId, ...activeFilter },
      select: {
        id: true,
        code: true,
        nameAr: true,
        nameEn: true,
        isActive: true,
        _count: { select: { journalLines: true } },
      },
      orderBy: { code: 'asc' },
    });

    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      nameAr: row.nameAr,
      nameEn: row.nameEn,
      isActive: row.isActive,
      usageCount: row._count.journalLines,
      detail: null,
    }));
  });
}

export interface CreateMasterDataInput {
  readonly tenantId: string;
  readonly audit: AuditContext;
  readonly kind: MasterDataKind;
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string;
  /** Unit of measure only. */
  readonly baseFactor?: string;
}

/**
 * Adds a record.
 *
 * The duplicate-code refusal is translated from the unique constraint rather than checked
 * first: a check followed by an insert is a race two administrators can lose together, and the
 * index is the only thing that actually decides.
 */
export async function createMasterData(
  input: CreateMasterDataInput,
): Promise<Result<{ id: string }, DomainError>> {
  const code = input.code.trim();
  const nameAr = input.nameAr.trim();
  const nameEn = input.nameEn.trim();

  if (nameAr === '' || nameEn === '') {
    return err(
      DomainErrors.validation(
        'الاسم بالعربية والإنجليزية مطلوبان.',
        'Both the Arabic and English names are required.',
        'nameAr',
      ),
    );
  }

  if (MASTER_DATA[input.kind].hasCode && code === '') {
    return err(
      DomainErrors.validation('الرمز مطلوب.', 'A code is required.', 'code'),
    );
  }

  return withTransaction(async (tx) => {
    try {
      let id: string;

      if (input.kind === 'category') {
        const created = await tx.category.create({
          data: { tenantId: input.tenantId, code, nameAr, nameEn },
          select: { id: true },
        });
        id = created.id;
      } else if (input.kind === 'brand') {
        const created = await tx.brand.create({
          data: { tenantId: input.tenantId, nameAr, nameEn },
          select: { id: true },
        });
        id = created.id;
      } else if (input.kind === 'unit') {
        const factor = (input.baseFactor ?? '1').trim();
        if (!/^\d+(\.\d{1,6})?$/.test(factor) || Number(factor) <= 0) {
          return err(
            DomainErrors.validation(
              'معامل التحويل يجب أن يكون رقماً موجباً.',
              'The base factor must be a positive number.',
              'baseFactor',
            ),
          );
        }
        const created = await tx.unitOfMeasure.create({
          data: { tenantId: input.tenantId, code, nameAr, nameEn, baseFactor: factor },
          select: { id: true },
        });
        id = created.id;
      } else {
        const created = await tx.costCenter.create({
          data: { tenantId: input.tenantId, code, nameAr, nameEn },
          select: { id: true },
        });
        id = created.id;
      }

      await recordAudit(
        tx,
        input.audit,
        'CREATE',
        { entityType: input.kind, entityId: id },
        { metadata: { code, nameAr, nameEn } },
      );

      return ok({ id });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return err(
          DomainErrors.validation(
            MASTER_DATA[input.kind].hasCode
              ? `الرمز "${code}" مستخدم بالفعل.`
              : `الاسم "${nameEn}" مستخدم بالفعل.`,
            'That code is already in use.',
            MASTER_DATA[input.kind].hasCode ? 'code' : 'nameEn',
          ),
        );
      }
      throw error;
    }
  });
}

/**
 * Activates or deactivates a record.
 *
 * The only lifecycle operation offered. See the note at the top of this file for why there is
 * no delete: the foreign keys are RESTRICT, so a delete would fail on exactly the records that
 * matter and succeed on the ones nobody would miss.
 */
export async function setMasterDataActive(input: {
  tenantId: string;
  audit: AuditContext;
  kind: MasterDataKind;
  id: string;
  isActive: boolean;
}): Promise<Result<{ id: string }, DomainError>> {
  return withTransaction(async (tx) => {
    const where = { id: input.id, tenantId: input.tenantId };
    const data = { isActive: input.isActive };

    const updated =
      input.kind === 'category'
        ? await tx.category.updateMany({ where, data })
        : input.kind === 'brand'
          ? await tx.brand.updateMany({ where, data })
          : input.kind === 'unit'
            ? await tx.unitOfMeasure.updateMany({ where, data })
            : await tx.costCenter.updateMany({ where, data });

    if (updated.count === 0) {
      return err(DomainErrors.notFound('السجل', 'Record', input.id));
    }

    await recordAudit(
      tx,
      input.audit,
      'UPDATE',
      { entityType: input.kind, entityId: input.id },
      { metadata: { isActive: input.isActive } },
    );

    return ok({ id: input.id });
  });
}
