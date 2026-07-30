import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  generateSchedule,
  getAssetSchedule,
  listAssets,
  previewRun,
  runDepreciation,
} from '@/lib/application/services/depreciation-service';
import { DateOnly } from '@/lib/domain/shared/value-objects';

/**
 * Fixed asset depreciation, against a real database.
 *
 * The unit tests prove the arithmetic. What only a database can prove is everything the
 * arithmetic is wrapped in, and that is where the failures that matter live:
 *
 *   - the schedule totals the depreciable amount **after a round trip through
 *     `Decimal(19,4)`** — an amount that is exact in `Money` and lossy in the column is a
 *     schedule that leaves a residue on disposal;
 *   - a run posts **one balanced journal** and the ledger accepts it, which means the balance
 *     trigger agreed;
 *   - the register's `accumulatedDepreciation` ends up **equal to the last posted period's
 *     cumulative column**, not to a sum recomputed somewhere else;
 *   - **posting twice does not double-charge**, and **skipping a month is refused**;
 *   - the guards from migration 008 actually refuse what they were added to refuse.
 *
 * A fresh tenant per test rather than a shared one torn down between them: the fixture posts
 * journals, and a posted journal cannot be deleted — `journals_immutability` refuses it,
 * which is the point of an append-only ledger.
 */

const databaseUrl = process.env['DATABASE_URL'];
const prisma = new PrismaClient();

let tenantId = '';
let userId = '';
let branchId = '';
let assetAccountId = '';
let accumulatedAccountId = '';
let expenseAccountId = '';
let assetSequence = 0;

function audit() {
  return {
    tenantId,
    userId,
    ipAddress: null,
    userAgent: null,
    sessionId: null,
    correlationId: randomUUID(),
  };
}

async function createAsset(input: {
  cost: string;
  salvage: string;
  months: number;
  method?: 'STRAIGHT_LINE' | 'DECLINING_BALANCE';
  factor?: string;
  acquired: string;
  disposed?: string;
}): Promise<string> {
  assetSequence += 1;
  const asset = await prisma.fixedAsset.create({
    data: {
      tenantId,
      assetNumber: `FA-${assetSequence}`,
      nameAr: 'أصل',
      nameEn: 'Asset',
      branchId,
      acquisitionDate: new Date(input.acquired),
      acquisitionCost: input.cost,
      salvageValue: input.salvage,
      usefulLifeMonths: input.months,
      method: input.method ?? 'STRAIGHT_LINE',
      decliningFactor: input.factor ?? '2',
      // Migration 008 requires netBookValue to equal cost − accumulated, so the fixture
      // cannot leave it at zero.
      netBookValue: input.cost,
      assetAccountId,
      accumulatedAccountId,
      expenseAccountId,
      ...(input.disposed !== undefined ? { disposedAt: new Date(input.disposed) } : {}),
    },
    select: { id: true },
  });
  return asset.id;
}

describe.skipIf(databaseUrl === undefined || databaseUrl === '')('fixed asset depreciation', () => {
  beforeEach(async () => {
    const code = `DEPR_${randomUUID().slice(0, 8)}`;
    assetSequence = 0;

    const tenant = await prisma.tenant.create({
      data: { code, nameAr: 'إهلاك', nameEn: 'Depreciation' },
      select: { id: true },
    });
    tenantId = tenant.id;

    const user = await prisma.user.create({
      data: {
        tenantId,
        username: 'controller',
        email: `controller@${code}.spec`,
        passwordHash: 'x',
        fullNameAr: 'المدير المالي',
        fullNameEn: 'Controller',
      },
      select: { id: true },
    });
    userId = user.id;

    const branch = await prisma.branch.create({
      data: { tenantId, code: 'BR1', nameAr: 'الفرع', nameEn: 'Branch' },
      select: { id: true },
    });
    branchId = branch.id;

    const [assetAccount, accumulated, expense] = await Promise.all([
      prisma.account.create({
        data: {
          tenantId,
          code: '1210',
          nameAr: 'أثاث ومعدات',
          nameEn: 'Furniture and equipment',
          type: 'ASSET',
          nature: 'DEBIT',
          path: '1210',
        },
        select: { id: true },
      }),
      prisma.account.create({
        data: {
          tenantId,
          code: '1219',
          nameAr: 'مجمَّع إهلاك الأثاث',
          nameEn: 'Accumulated depreciation — furniture',
          type: 'ASSET',
          // A contra-asset: an asset account carrying a credit balance, which migration 3
          // made expressible. Writing the cost down directly would destroy the one figure a
          // fixed asset register exists to preserve.
          nature: 'CREDIT',
          isContra: true,
          path: '1219',
        },
        select: { id: true },
      }),
      prisma.account.create({
        data: {
          tenantId,
          code: '5310',
          nameAr: 'مصروف الإهلاك',
          nameEn: 'Depreciation expense',
          type: 'EXPENSE',
          nature: 'DEBIT',
          path: '5310',
        },
        select: { id: true },
      }),
    ]);
    assetAccountId = assetAccount.id;
    accumulatedAccountId = accumulated.id;
    expenseAccountId = expense.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('generating a schedule', () => {
    it('writes one period per month of the useful life', async () => {
      const assetId = await createAsset({
        cost: '12000.00',
        salvage: '0.00',
        months: 12,
        acquired: '2026-01-15',
      });

      const result = await generateSchedule({ tenantId, assetId, audit: audit() });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.created).toBe(12);
      expect(result.value.existing).toBe(0);
    });

    it('survives the round trip through Decimal(19,4) with an exact total', async () => {
      // 10,000 over 7 months does not divide. If the column narrowed the amounts the total
      // would come back short, and the asset would never fully depreciate.
      const assetId = await createAsset({
        cost: '10000.00',
        salvage: '0.00',
        months: 7,
        acquired: '2026-01-31',
      });

      await generateSchedule({ tenantId, assetId, audit: audit() });

      const totals = await prisma.depreciationSchedule.aggregate({
        where: { assetId },
        _sum: { amount: true },
        _count: true,
      });

      expect(totals._count).toBe(7);
      // Summed by PostgreSQL, not by the code under test — a total the service computed would
      // agree with itself whatever the column did to the parts.
      expect(totals._sum.amount?.toFixed(4)).toBe('10000.0000');
    });

    it('is idempotent — a second call creates nothing', async () => {
      const assetId = await createAsset({
        cost: '6000.00',
        salvage: '0.00',
        months: 6,
        acquired: '2026-01-10',
      });

      await generateSchedule({ tenantId, assetId, audit: audit() });
      const again = await generateSchedule({ tenantId, assetId, audit: audit() });

      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect(again.value.created).toBe(0);
      expect(again.value.existing).toBe(6);
    });

    it('refuses a disposed asset', async () => {
      const assetId = await createAsset({
        cost: '6000.00',
        salvage: '0.00',
        months: 6,
        acquired: '2026-01-10',
        disposed: '2026-03-31',
      });

      const result = await generateSchedule({ tenantId, assetId, audit: audit() });

      expect(result.ok).toBe(false);
    });

    it('stamps the asset tenant on every row', async () => {
      const assetId = await createAsset({
        cost: '1200.00',
        salvage: '0.00',
        months: 12,
        acquired: '2026-01-15',
      });

      await generateSchedule({ tenantId, assetId, audit: audit() });

      const foreign = await prisma.depreciationSchedule.count({
        where: { assetId, tenantId: { not: tenantId } },
      });

      expect(foreign).toBe(0);
    });
  });

  describe('the database guards', () => {
    it('refuses a schedule row whose tenant is not the asset tenant', async () => {
      const assetId = await createAsset({
        cost: '1200.00',
        salvage: '0.00',
        months: 12,
        acquired: '2026-01-15',
      });

      const other = await prisma.tenant.create({
        data: { code: `OTHER_${randomUUID().slice(0, 8)}`, nameAr: 'آخر', nameEn: 'Other' },
        select: { id: true },
      });

      await expect(
        prisma.depreciationSchedule.create({
          data: {
            tenantId: other.id,
            assetId,
            periodDate: new Date('2026-01-31'),
            amount: '100',
            accumulated: '100',
            netBookValue: '1100',
          },
        }),
      ).rejects.toThrow();
    });

    it('refuses a row posted with no journal', async () => {
      const assetId = await createAsset({
        cost: '1200.00',
        salvage: '0.00',
        months: 12,
        acquired: '2026-01-15',
      });

      await expect(
        prisma.depreciationSchedule.create({
          data: {
            tenantId,
            assetId,
            periodDate: new Date('2026-01-31'),
            amount: '100',
            accumulated: '100',
            netBookValue: '1100',
            isPosted: true,
          },
        }),
      ).rejects.toThrow();
    });

    it('refuses a negative charge', async () => {
      const assetId = await createAsset({
        cost: '1200.00',
        salvage: '0.00',
        months: 12,
        acquired: '2026-01-15',
      });

      await expect(
        prisma.depreciationSchedule.create({
          data: {
            tenantId,
            assetId,
            periodDate: new Date('2026-01-31'),
            amount: '-100',
            accumulated: '0',
            netBookValue: '1200',
          },
        }),
      ).rejects.toThrow();
    });

    it('refuses salvage at or above cost', async () => {
      await expect(
        createAsset({ cost: '1000.00', salvage: '1000.00', months: 12, acquired: '2026-01-15' }),
      ).rejects.toThrow();
    });

    it('refuses an asset depreciated past its salvage value', async () => {
      const assetId = await createAsset({
        cost: '1000.00',
        salvage: '200.00',
        months: 8,
        acquired: '2026-01-15',
      });

      // 900 of an 800 depreciable amount: 100 of value the company still holds, expensed.
      await expect(
        prisma.fixedAsset.update({
          where: { id: assetId },
          data: { accumulatedDepreciation: '900.00', netBookValue: '100.00' },
        }),
      ).rejects.toThrow();
    });

    it('refuses a net book value that disagrees with cost minus accumulated', async () => {
      const assetId = await createAsset({
        cost: '1000.00',
        salvage: '0.00',
        months: 10,
        acquired: '2026-01-15',
      });

      await expect(
        prisma.fixedAsset.update({
          where: { id: assetId },
          data: { accumulatedDepreciation: '400.00', netBookValue: '500.00' },
        }),
      ).rejects.toThrow();
    });

    it('refuses a declining-balance factor of 1', async () => {
      await expect(
        createAsset({
          cost: '1000.00',
          salvage: '0.00',
          months: 10,
          acquired: '2026-01-15',
          method: 'DECLINING_BALANCE',
          factor: '1',
        }),
      ).rejects.toThrow();
    });

    it('allows a factor of 1 on a straight-line asset', async () => {
      // The column keeps its default for straight-line assets, and the constraint must not
      // constrain a value it does not read.
      await expect(
        createAsset({
          cost: '1000.00',
          salvage: '0.00',
          months: 10,
          acquired: '2026-01-15',
          method: 'STRAIGHT_LINE',
          factor: '1',
        }),
      ).resolves.toBeTruthy();
    });
  });

  describe('previewing a run', () => {
    it('offers only periods whose month has ended', async () => {
      const assetId = await createAsset({
        cost: '1200.00',
        salvage: '0.00',
        months: 12,
        acquired: '2026-01-15',
      });
      await generateSchedule({ tenantId, assetId, audit: audit() });

      // Mid-March. January and February have ended; March has not, and a charge for a month
      // still running is a charge for time that has not passed.
      const preview = await previewRun({ tenantId, asOf: dateOnly('2026-03-15') });

      expect(preview.ok).toBe(true);
      if (!preview.ok) return;
      expect(preview.value.charges).toHaveLength(2);
      expect(preview.value.charges.map((charge) => charge.periodDate)).toEqual([
        '2026-01-31',
        '2026-02-28',
      ]);
      expect(preview.value.totalAmount).toBe('200.0000');
    });

    it('excludes a disposed asset', async () => {
      const live = await createAsset({
        cost: '1200.00',
        salvage: '0.00',
        months: 12,
        acquired: '2026-01-15',
      });
      const disposed = await createAsset({
        cost: '2400.00',
        salvage: '0.00',
        months: 12,
        acquired: '2026-01-15',
      });

      await generateSchedule({ tenantId, assetId: live, audit: audit() });
      await generateSchedule({ tenantId, assetId: disposed, audit: audit() });
      await prisma.fixedAsset.update({
        where: { id: disposed },
        data: { disposedAt: new Date('2026-02-15') },
      });

      const preview = await previewRun({ tenantId, asOf: dateOnly('2026-03-31') });

      expect(preview.ok).toBe(true);
      if (!preview.ok) return;
      expect(preview.value.charges.every((charge) => charge.assetId === live)).toBe(true);
      expect(preview.value.totalAmount).toBe('300.0000');
    });

    it('reports the accounts each charge will hit', async () => {
      const assetId = await createAsset({
        cost: '1200.00',
        salvage: '0.00',
        months: 12,
        acquired: '2026-01-15',
      });
      await generateSchedule({ tenantId, assetId, audit: audit() });

      const preview = await previewRun({ tenantId, asOf: dateOnly('2026-01-31') });

      expect(preview.ok).toBe(true);
      if (!preview.ok) return;
      expect(preview.value.charges[0]?.expenseAccountCode).toBe('5310');
      expect(preview.value.charges[0]?.accumulatedAccountCode).toBe('1219');
    });
  });

  describe('running a period', () => {
    it('posts one balanced journal for every due charge', async () => {
      const first = await createAsset({
        cost: '1200.00',
        salvage: '0.00',
        months: 12,
        acquired: '2026-01-15',
      });
      const second = await createAsset({
        cost: '2400.00',
        salvage: '0.00',
        months: 12,
        acquired: '2026-01-20',
      });

      await generateSchedule({ tenantId, assetId: first, audit: audit() });
      await generateSchedule({ tenantId, assetId: second, audit: audit() });

      const result = await runDepreciation({
        tenantId,
        asOf: dateOnly('2026-03-31'),
        userId,
        audit: audit(),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Three months of both assets: 3 × 100 + 3 × 200.
      expect(result.value.postedCount).toBe(6);
      expect(result.value.totalAmount).toBe('900.0000');
      expect(result.value.journalId).not.toBeNull();

      const journal = await prisma.journal.findFirstOrThrow({
        where: { id: result.value.journalId! },
        select: { status: true, type: true, totalDebit: true, totalCredit: true },
      });

      expect(journal.status).toBe('POSTED');
      expect(journal.type).toBe('DEPRECIATION');
      expect(journal.totalDebit.toFixed(2)).toBe('900.00');
      expect(journal.totalCredit.toFixed(2)).toBe(journal.totalDebit.toFixed(2));
    });

    it('compacts the lines by account rather than one pair per asset', async () => {
      const first = await createAsset({
        cost: '1200.00',
        salvage: '0.00',
        months: 12,
        acquired: '2026-01-15',
      });
      const second = await createAsset({
        cost: '2400.00',
        salvage: '0.00',
        months: 12,
        acquired: '2026-01-20',
      });
      await generateSchedule({ tenantId, assetId: first, audit: audit() });
      await generateSchedule({ tenantId, assetId: second, audit: audit() });

      const result = await runDepreciation({
        tenantId,
        asOf: dateOnly('2026-03-31'),
        userId,
        audit: audit(),
      });
      if (!result.ok) throw new Error('run failed');

      const lines = await prisma.journalLine.count({
        where: { journalId: result.value.journalId! },
      });

      // Both assets share one expense and one accumulated account, so six charges collapse
      // to two lines. An accountant expects one entry, not twelve.
      expect(lines).toBe(2);
    });

    it('leaves the asset cost untouched and moves only accumulated depreciation', async () => {
      const assetId = await createAsset({
        cost: '1200.00',
        salvage: '0.00',
        months: 12,
        acquired: '2026-01-15',
      });
      await generateSchedule({ tenantId, assetId, audit: audit() });

      await runDepreciation({ tenantId, asOf: dateOnly('2026-03-31'), userId, audit: audit() });

      const asset = await prisma.fixedAsset.findUniqueOrThrow({
        where: { id: assetId },
        select: { acquisitionCost: true, accumulatedDepreciation: true, netBookValue: true },
      });

      expect(asset.acquisitionCost.toFixed(2)).toBe('1200.00');
      expect(asset.accumulatedDepreciation.toFixed(2)).toBe('300.00');
      expect(asset.netBookValue.toFixed(2)).toBe('900.00');
    });

    it('sets the register from the last posted period, not from a separate sum', async () => {
      const assetId = await createAsset({
        cost: '10000.00',
        salvage: '1000.00',
        months: 7,
        acquired: '2026-01-31',
      });
      await generateSchedule({ tenantId, assetId, audit: audit() });

      await runDepreciation({ tenantId, asOf: dateOnly('2026-04-30'), userId, audit: audit() });

      const [asset, last] = await Promise.all([
        prisma.fixedAsset.findUniqueOrThrow({
          where: { id: assetId },
          select: { accumulatedDepreciation: true },
        }),
        prisma.depreciationSchedule.findFirstOrThrow({
          where: { assetId, isPosted: true },
          orderBy: { periodDate: 'desc' },
          select: { accumulated: true },
        }),
      ]);

      expect(asset.accumulatedDepreciation.toFixed(4)).toBe(last.accumulated.toFixed(4));
    });

    it('does not charge the same period twice', async () => {
      const assetId = await createAsset({
        cost: '1200.00',
        salvage: '0.00',
        months: 12,
        acquired: '2026-01-15',
      });
      await generateSchedule({ tenantId, assetId, audit: audit() });

      await runDepreciation({ tenantId, asOf: dateOnly('2026-03-31'), userId, audit: audit() });
      const again = await runDepreciation({
        tenantId,
        asOf: dateOnly('2026-03-31'),
        userId,
        audit: audit(),
      });

      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect(again.value.postedCount).toBe(0);
      expect(again.value.journalId).toBeNull();

      const asset = await prisma.fixedAsset.findUniqueOrThrow({
        where: { id: assetId },
        select: { accumulatedDepreciation: true },
      });
      expect(asset.accumulatedDepreciation.toFixed(2)).toBe('300.00');
    });

    it('carries on from where the last run stopped', async () => {
      const assetId = await createAsset({
        cost: '1200.00',
        salvage: '0.00',
        months: 12,
        acquired: '2026-01-15',
      });
      await generateSchedule({ tenantId, assetId, audit: audit() });

      await runDepreciation({ tenantId, asOf: dateOnly('2026-02-28'), userId, audit: audit() });
      const second = await runDepreciation({
        tenantId,
        asOf: dateOnly('2026-04-30'),
        userId,
        audit: audit(),
      });

      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.value.postedCount).toBe(2);

      const asset = await prisma.fixedAsset.findUniqueOrThrow({
        where: { id: assetId },
        select: { accumulatedDepreciation: true },
      });
      expect(asset.accumulatedDepreciation.toFixed(2)).toBe('400.00');
    });

    it('skips an asset whose schedule is posted out of order', async () => {
      // The register's accumulated column is read from the last posted period's cumulative
      // figure, which is only the true total when every period before it is posted. So an
      // asset with a *posted* period later than an unposted one has to be left alone: charging
      // it further would set the register from a cumulative figure that skips a month.
      const assetId = await createAsset({
        cost: '1200.00',
        salvage: '0.00',
        months: 12,
        acquired: '2026-01-15',
      });
      await generateSchedule({ tenantId, assetId, audit: audit() });

      const run = await runDepreciation({
        tenantId,
        asOf: dateOnly('2026-03-31'),
        userId,
        audit: audit(),
      });
      if (!run.ok) throw new Error('first run failed');

      // A repair gone wrong: January is reopened after February and March were charged. This
      // cannot arise from ordinary use, which is exactly why the service has to notice it
      // rather than assume it away.
      const january = await prisma.depreciationSchedule.findFirstOrThrow({
        where: { assetId },
        orderBy: { periodDate: 'asc' },
        select: { id: true },
      });
      await prisma.depreciationSchedule.update({
        where: { id: january.id },
        data: { isPosted: false, journalId: null, postedAt: null },
      });

      const second = await runDepreciation({
        tenantId,
        asOf: dateOnly('2026-05-31'),
        userId,
        audit: audit(),
      });

      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.value.postedCount).toBe(0);
      expect(second.value.journalId).toBeNull();
      expect(second.value.skipped).toHaveLength(1);
      expect(second.value.skipped[0]?.assetId).toBe(assetId);
      expect(second.value.skipped[0]?.reasonEn).toContain('later than an earlier unposted');
    });

    it('does not mistake a normally half-posted schedule for one out of order', async () => {
      // The ordering check must not fire on the ordinary case: three months posted, the rest
      // open. A check that refused this would refuse every second run.
      const assetId = await createAsset({
        cost: '1200.00',
        salvage: '0.00',
        months: 12,
        acquired: '2026-01-15',
      });
      await generateSchedule({ tenantId, assetId, audit: audit() });

      await runDepreciation({ tenantId, asOf: dateOnly('2026-03-31'), userId, audit: audit() });
      const second = await runDepreciation({
        tenantId,
        asOf: dateOnly('2026-05-31'),
        userId,
        audit: audit(),
      });

      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.value.skipped).toHaveLength(0);
      expect(second.value.postedCount).toBe(2);
    });

    it('leaves a disposed asset out of the run', async () => {
      const live = await createAsset({
        cost: '1200.00',
        salvage: '0.00',
        months: 12,
        acquired: '2026-01-15',
      });
      const disposed = await createAsset({
        cost: '2400.00',
        salvage: '0.00',
        months: 12,
        acquired: '2026-01-15',
      });

      await generateSchedule({ tenantId, assetId: live, audit: audit() });
      await generateSchedule({ tenantId, assetId: disposed, audit: audit() });

      await prisma.fixedAsset.update({
        where: { id: disposed },
        data: { disposedAt: new Date('2026-02-15') },
      });

      const result = await runDepreciation({
        tenantId,
        asOf: dateOnly('2026-03-31'),
        userId,
        audit: audit(),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Three months of the live asset only.
      expect(result.value.postedCount).toBe(3);
      expect(result.value.totalAmount).toBe('300.0000');
    });

    it('reports nothing due rather than failing when the register is current', async () => {
      const result = await runDepreciation({
        tenantId,
        asOf: dateOnly('2026-03-31'),
        userId,
        audit: audit(),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.postedCount).toBe(0);
      expect(result.value.journalId).toBeNull();
    });

    it('depreciates an asset to exactly its salvage value over its whole life', async () => {
      const assetId = await createAsset({
        cost: '10000.00',
        salvage: '1000.00',
        months: 24,
        method: 'DECLINING_BALANCE',
        factor: '2',
        acquired: '2026-01-31',
      });
      await generateSchedule({ tenantId, assetId, audit: audit() });

      const result = await runDepreciation({
        tenantId,
        // Past the end of the 24-month life, so every period is due.
        asOf: dateOnly('2028-12-31'),
        userId,
        audit: audit(),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.postedCount).toBe(24);
      expect(result.value.totalAmount).toBe('9000.0000');

      const asset = await prisma.fixedAsset.findUniqueOrThrow({
        where: { id: assetId },
        select: { netBookValue: true, accumulatedDepreciation: true },
      });

      // The floor, exactly. Not "about a thousand".
      expect(asset.netBookValue.toFixed(4)).toBe('1000.0000');
      expect(asset.accumulatedDepreciation.toFixed(4)).toBe('9000.0000');
    });
  });

  describe('reading the register', () => {
    it('reports schedule progress per asset', async () => {
      const assetId = await createAsset({
        cost: '1200.00',
        salvage: '0.00',
        months: 12,
        acquired: '2026-01-15',
      });
      await generateSchedule({ tenantId, assetId, audit: audit() });
      await runDepreciation({ tenantId, asOf: dateOnly('2026-03-31'), userId, audit: audit() });

      const assets = await listAssets({ tenantId });
      const asset = assets.find((row) => row.id === assetId);

      expect(asset?.scheduledPeriods).toBe(12);
      expect(asset?.postedPeriods).toBe(3);
      expect(asset?.nextDueDate).toBe('2026-04-30');
    });

    it('distinguishes an asset with no schedule from one that is up to date', async () => {
      const scheduled = await createAsset({
        cost: '1200.00',
        salvage: '0.00',
        months: 12,
        acquired: '2026-01-15',
      });
      const bare = await createAsset({
        cost: '1200.00',
        salvage: '0.00',
        months: 12,
        acquired: '2026-01-15',
      });
      await generateSchedule({ tenantId, assetId: scheduled, audit: audit() });

      const assets = await listAssets({ tenantId });

      expect(assets.find((row) => row.id === bare)?.scheduledPeriods).toBe(0);
      expect(assets.find((row) => row.id === bare)?.nextDueDate).toBeNull();
      expect(assets.find((row) => row.id === scheduled)?.scheduledPeriods).toBe(12);
    });

    it('marks the posted periods with their journal', async () => {
      const assetId = await createAsset({
        cost: '1200.00',
        salvage: '0.00',
        months: 12,
        acquired: '2026-01-15',
      });
      await generateSchedule({ tenantId, assetId, audit: audit() });
      const run = await runDepreciation({
        tenantId,
        asOf: dateOnly('2026-02-28'),
        userId,
        audit: audit(),
      });
      if (!run.ok) throw new Error('run failed');

      const view = await getAssetSchedule({ tenantId, assetId });

      expect(view.ok).toBe(true);
      if (!view.ok) return;

      const posted = view.value.periods.filter((period) => period.isPosted);
      expect(posted).toHaveLength(2);
      expect(posted.every((period) => period.journalId === run.value.journalId)).toBe(true);
      expect(posted.every((period) => period.postedAt !== null)).toBe(true);
    });

    it('refuses to read another tenant’s asset', async () => {
      const assetId = await createAsset({
        cost: '1200.00',
        salvage: '0.00',
        months: 12,
        acquired: '2026-01-15',
      });

      const other = await prisma.tenant.create({
        data: { code: `OTHER_${randomUUID().slice(0, 8)}`, nameAr: 'آخر', nameEn: 'Other' },
        select: { id: true },
      });

      const view = await getAssetSchedule({ tenantId: other.id, assetId });

      expect(view.ok).toBe(false);
    });
  });

  describe('the preview and the run agree', () => {
    it('previews exactly what the run posts', async () => {
      const assetId = await createAsset({
        cost: '10000.00',
        salvage: '1000.00',
        months: 7,
        acquired: '2026-01-31',
      });
      await generateSchedule({ tenantId, assetId, audit: audit() });

      const asOf = dateOnly('2026-04-30');
      const preview = await previewRun({ tenantId, asOf });
      const run = await runDepreciation({ tenantId, asOf, userId, audit: audit() });

      expect(preview.ok && run.ok).toBe(true);
      if (!preview.ok || !run.ok) return;

      expect(run.value.postedCount).toBe(preview.value.charges.length);
      expect(run.value.totalAmount).toBe(preview.value.totalAmount);
    });

    it('shows nothing to post once the run has happened', async () => {
      const assetId = await createAsset({
        cost: '1200.00',
        salvage: '0.00',
        months: 12,
        acquired: '2026-01-15',
      });
      await generateSchedule({ tenantId, assetId, audit: audit() });

      const asOf = dateOnly('2026-03-31');
      await runDepreciation({ tenantId, asOf, userId, audit: audit() });
      const preview = await previewRun({ tenantId, asOf });

      expect(preview.ok).toBe(true);
      if (!preview.ok) return;
      expect(preview.value.charges).toHaveLength(0);
      expect(preview.value.totalAmount).toBe('0.0000');
    });
  });
});

/** `DateOnly` or a thrown error — a fixture has no use for a `Result` it cannot act on. */
function dateOnly(value: string): DateOnly {
  const parsed = DateOnly.create(value);
  if (!parsed.ok) throw new Error(`bad fixture date ${value}`);
  return parsed.value;
}
