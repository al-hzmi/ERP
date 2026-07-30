import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Row-level security on the child tables migration 004 missed.
 *
 * Migration 004 finds its targets by looking for a `tenantId` column. Six tables were
 * reachable only through a tenant-scoped parent, carried no such column, and were therefore
 * passed over entirely — readable and writable across every tenant in the cluster under
 * `erp_app`. Two of them are as sensitive as anything in the schema: `payroll_lines` is
 * individual salaries and `bank_statement_lines` is a company's whole cash movement.
 *
 * Migration 009 denormalises the tenant onto each row and applies the standard policy. This
 * asserts the two halves of that separately, because they fail independently:
 *
 *   1. **The policy exists and is shaped right** — enabled, fail-closed, and with a WITH CHECK
 *      clause as well as a USING one. A USING clause alone filters what a tenant can *read*
 *      while letting it write a row stamped with someone else's id, which is the
 *      half-applied version of this control and the easiest to ship by accident.
 *   2. **The denormalisation cannot drift** — the trigger refuses a row whose tenant differs
 *      from its parent's. Without it, a denormalised tenant is a second source of truth, and
 *      the policy would be enforcing the wrong one.
 *
 * These run as the owner, which PostgreSQL exempts from its own policies, so they assert on
 * the catalogue and on the trigger rather than by trying to read another tenant's rows.
 * `tenant-isolation-as-app-role.test.ts` is where the policies are exercised from a role they
 * actually apply to.
 */

const databaseUrl = process.env['DATABASE_URL'];
const prisma = new PrismaClient();

/** Child table, its parent, and the foreign key between them — the mapping migration 009 drives from. */
const CHILD_TABLES = [
  { child: 'fiscal_periods', parent: 'fiscal_years', fk: 'fiscalYearId' },
  { child: 'zatca_invoices', parent: 'documents', fk: 'documentId' },
  { child: 'bank_statement_lines', parent: 'bank_statements', fk: 'bankStatementId' },
  { child: 'payroll_lines', parent: 'payroll_runs', fk: 'payrollRunId' },
  { child: 'approval_steps', parent: 'approval_policies', fk: 'policyId' },
  { child: 'approval_actions', parent: 'approval_requests', fk: 'requestId' },
] as const;

interface PolicyRow {
  readonly tablename: string;
  readonly qual: string | null;
  readonly with_check: string | null;
  readonly roles: string[];
}

let tenantId = '';
let otherTenantId = '';
let fiscalYearId = '';

describe.skipIf(databaseUrl === undefined || databaseUrl === '')('child-table isolation', () => {
  beforeAll(async () => {
    const [tenant, other] = await Promise.all([
      prisma.tenant.create({
        data: { code: `CHILD_${randomUUID().slice(0, 8)}`, nameAr: 'أول', nameEn: 'First' },
        select: { id: true },
      }),
      prisma.tenant.create({
        data: { code: `CHILD_${randomUUID().slice(0, 8)}`, nameAr: 'ثانٍ', nameEn: 'Second' },
        select: { id: true },
      }),
    ]);
    tenantId = tenant.id;
    otherTenantId = other.id;

    const fiscalYear = await prisma.fiscalYear.create({
      data: {
        tenantId,
        year: 2026,
        startDate: new Date('2026-01-01'),
        endDate: new Date('2026-12-31'),
      },
      select: { id: true },
    });
    fiscalYearId = fiscalYear.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('the policies', () => {
    it('is enabled on every one of the six', async () => {
      const rows = await prisma.$queryRaw<{ relname: string }[]>`
        SELECT c.relname
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relrowsecurity
      `;

      const enabled = new Set(rows.map((row) => row.relname));
      const missing = CHILD_TABLES.filter((entry) => !enabled.has(entry.child)).map(
        (entry) => entry.child,
      );

      expect(missing).toEqual([]);
    });

    it('compares the tenant on read and on write, not only on read', async () => {
      const policies = await prisma.$queryRaw<PolicyRow[]>`
        SELECT tablename, qual, with_check, roles::text[] AS roles
          FROM pg_policies
         WHERE schemaname = 'public' AND policyname ~ 'tenant_isolation$'
      `;

      const byTable = new Map(policies.map((policy) => [policy.tablename, policy]));

      for (const { child } of CHILD_TABLES) {
        const policy = byTable.get(child);
        expect(policy, `no policy on ${child}`).toBeDefined();
        expect(policy?.qual ?? '').toContain('erp_current_tenant()');
        expect(policy?.with_check ?? '').toContain('erp_current_tenant()');
        expect(policy?.roles).toContain('erp_app');
      }
    });

    it('leaves none of them fail-open', async () => {
      const policies = await prisma.$queryRaw<PolicyRow[]>`
        SELECT tablename, qual, with_check, roles::text[] AS roles
          FROM pg_policies
         WHERE schemaname = 'public' AND policyname ~ 'tenant_isolation$'
      `;

      // `IS NULL` in the predicate is the exact regression migration 004 existed to remove: it
      // is how a policy says "and if nobody told me which tenant, show everything".
      const children = new Set<string>(CHILD_TABLES.map((entry) => entry.child));
      const failOpen = policies
        .filter((policy) => children.has(policy.tablename))
        .filter(
          (policy) =>
            (policy.qual ?? '').includes('IS NULL') ||
            (policy.with_check ?? '').includes('IS NULL'),
        );

      expect(failOpen.map((policy) => policy.tablename)).toEqual([]);
    });

    it('indexes the column the policy filters on', async () => {
      // The policy adds `"tenantId" = ...` to every query whether the caller wrote it or not.
      // Without an index leading with that column it is a filter over the whole table, which
      // is how a security control becomes a performance regression nobody attributes to it.
      const rows = await prisma.$queryRaw<{ tablename: string; indexdef: string }[]>`
        SELECT tablename, indexdef FROM pg_indexes WHERE schemaname = 'public'
      `;

      for (const { child } of CHILD_TABLES) {
        const indexed = rows.some(
          (row) => row.tablename === child && /\("tenantId"/.test(row.indexdef),
        );
        expect(indexed, `${child} has no index leading with tenantId`).toBe(true);
      }
    });
  });

  describe('the guard against drift', () => {
    it('installs a trigger on every one of the six', async () => {
      const rows = await prisma.$queryRaw<{ tgname: string }[]>`
        SELECT tgname FROM pg_trigger WHERE NOT tgisinternal
      `;

      const triggers = new Set(rows.map((row) => row.tgname));
      const missing = CHILD_TABLES.filter(
        (entry) => !triggers.has(`trg_${entry.child}_tenant`),
      ).map((entry) => entry.child);

      expect(missing).toEqual([]);
    });

    it('refuses a row whose tenant is not its parent’s', async () => {
      // The whole risk of denormalising: a child stamped with a tenant that does not own its
      // parent. The policy would then enforce the wrong owner, and enforce it confidently.
      await expect(
        prisma.fiscalPeriod.create({
          data: {
            tenantId: otherTenantId,
            fiscalYearId,
            periodNumber: 1,
            startDate: new Date('2026-01-01'),
            endDate: new Date('2026-01-31'),
          },
        }),
      ).rejects.toThrow();
    });

    it('accepts a row whose tenant matches', async () => {
      await expect(
        prisma.fiscalPeriod.create({
          data: {
            tenantId,
            fiscalYearId,
            periodNumber: 2,
            startDate: new Date('2026-02-01'),
            endDate: new Date('2026-02-28'),
          },
          select: { id: true },
        }),
      ).resolves.toBeTruthy();
    });

    it('refuses an update that moves a row to another tenant', async () => {
      // An INSERT-only guard would let a correct row be rewritten into a wrong one, which is
      // the same hole reached a step later.
      const period = await prisma.fiscalPeriod.create({
        data: {
          tenantId,
          fiscalYearId,
          periodNumber: 3,
          startDate: new Date('2026-03-01'),
          endDate: new Date('2026-03-31'),
        },
        select: { id: true },
      });

      await expect(
        prisma.fiscalPeriod.update({
          where: { id: period.id },
          data: { tenantId: otherTenantId },
        }),
      ).rejects.toThrow();
    });
  });

  describe('the gap cannot silently reopen', () => {
    it('leaves no table without either a policy or a stated exemption', async () => {
      // The same assertion migration 009 makes at deploy time, repeated here so it is checked
      // on every run rather than only when a migration is applied. Duplicated from the SQL on
      // purpose: if the two lists drift, this is where it surfaces.
      const exempt = new Set([
        '_prisma_migrations',
        'tenants',
        'permissions',
        'rate_limit_counters',
        'refresh_tokens',
        'role_permissions',
        'user_roles',
      ]);

      const rows = await prisma.$queryRaw<{ relname: string }[]>`
        SELECT c.relname
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relkind IN ('r', 'p')
           AND c.relispartition = false
           AND NOT EXISTS (
                 SELECT 1 FROM pg_policies p
                  WHERE p.schemaname = 'public'
                    AND p.tablename = c.relname
                    AND p.policyname = c.relname || '_tenant_isolation'
               )
      `;

      const unprotected = rows.map((row) => row.relname).filter((name) => !exempt.has(name));

      expect(unprotected).toEqual([]);
    });
  });
});
