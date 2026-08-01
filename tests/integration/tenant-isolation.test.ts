import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { withTenantRead, withTransaction } from '@/lib/infrastructure/db/prisma';
import { runInTenantScope } from '@/lib/infrastructure/db/tenant-scope';

/**
 * Row-level tenant isolation.
 *
 * Migration 002 installed policies that read `erp_current_tenant() IS NULL OR
 * ...`, which meant an unscoped session saw every tenant's rows — and nothing
 * called the function that sets the scope, so every session was unscoped. The
 * control existed in the schema and did nothing at all.
 *
 * These tests exist so that cannot quietly happen twice. Two of them inspect the
 * catalogue rather than data: a policy's shape is the thing that regressed, and
 * asserting on rows would not have caught it while the application still
 * connects as the owner. The rest prove the binding actually reaches the
 * database session, from both entry points and through the ambient scope.
 */

const prisma = new PrismaClient();

/** Tables migration 004 protects. Duplicated from the SQL on purpose: if the two
 *  lists drift, this test is where it surfaces. */
const TENANT_SCOPED_TABLES = [
  'users',
  'roles',
  'branches',
  'warehouses',
  'cost_centers',
  'projects',
  'currencies',
  'exchange_rates',
  'accounts',
  'account_mappings',
  'fiscal_years',
  'journals',
  'journal_lines',
  'categories',
  'brands',
  'units_of_measure',
  'products',
  'counterparties',
  'documents',
  'document_lines',
  'inventory_movements',
  'stock_levels',
  'cost_layers',
  'payments',
  'payment_allocations',
  'bank_statements',
  'departments',
  'employees',
  'payroll_runs',
  'audit_logs',
  'outbox_events',
  'number_sequences',
  'notifications',
  'approval_policies',
  'approval_requests',
  'fixed_assets',
  // Added by migration 006. It carries a `tenantId`, so it joins the policy set —
  // unlike `rate_limit_counters`, which is consulted before authentication and
  // therefore deliberately has no policy at all.
  'request_idempotency',
  // Added by migration 008. It had no policy at all until then: it was reachable only through
  // its asset, so it carried no `tenantId` and migration 004 passed it over — leaving it
  // readable across every tenant in the cluster. Migration 008 denormalises the tenant onto
  // the row (kept honest by a trigger) so the standard policy applies.
  //
  'depreciation_schedules',
  // Added by migration 009, which closed the same gap on the remaining six child tables. Each
  // was reachable only through a tenant-scoped parent, carried no `tenantId`, and so was
  // invisible to migration 004 — which selects its targets *by* that column. Two of these are
  // as sensitive as anything in the schema: `payroll_lines` is individual salaries and
  // `bank_statement_lines` is a company's entire cash movement.
  //
  // Migration 009 also asserts the inverse and stronger property at deploy time: every table
  // in the schema either has a tenant-isolation policy or is on an explicit exempt list with a
  // stated reason. A new child table added without one now fails `migrate deploy` rather than
  // waiting to be noticed in a diff.
  'fiscal_periods',
  'zatca_invoices',
  'bank_statement_lines',
  'payroll_lines',
  'approval_steps',
  'approval_actions',
  // Added by migration 010, and the first tables written after migration 009's deploy
  // assertion existed — so they arrived with their policies rather than needing a later
  // migration to fix them, which is what that assertion is for.
  'stock_counts',
  'stock_count_lines',
  // Added by migration 011. Two of them — `payment_terms` and `price_lists` — are tenant-rooted
  // and carry no guard trigger, because there is no parent whose tenant theirs could disagree
  // with. The other five are children and do, using migration 009's generic guard.
  'payment_terms',
  'price_lists',
  'price_list_lines',
  'trade_documents',
  'trade_document_lines',
  'assembly_orders',
  'assembly_order_lines',
  // Added by migration 013. A child of `approval_policies`, so it carries the denormalised
  // tenant and migration 009's generic guard trigger — same arrangement as every other child
  // table in the schema.
  'approval_rule_conditions',
  // Added by migration 014. A child of `counterparties`, so it carries the denormalised tenant
  // and migration 009's generic guard trigger.
  'customer_credit_profiles',
  // Added by migration 016. Rooted directly at `tenants` and therefore carries no guard trigger:
  // there is no parent whose tenant its own could disagree with. It holds the taxpayer's ZATCA
  // signing key, so a missing policy here would let one tenant read the cryptographic identity
  // another signs its invoices with.
  'zatca_configs',
  // Added by migration 017. Rooted directly at `tenants`, so no guard trigger: there is no
  // parent whose tenant its own could disagree with.
  'tax_codes',
] as const;

interface PolicyRow {
  readonly tablename: string;
  readonly policyname: string;
  readonly qual: string | null;
  readonly with_check: string | null;
  readonly roles: string[];
}

interface SettingRow {
  readonly value: string | null;
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe('policy shape', () => {
  it('protects every tenant-scoped table', async () => {
    const rows = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT c.relname AS tablename
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relrowsecurity = true
    `;

    const enabled = new Set(rows.map((row) => row.tablename));
    const unprotected = TENANT_SCOPED_TABLES.filter((table) => !enabled.has(table));

    expect(unprotected).toEqual([]);
  });

  it('leaves no fail-open policy behind', async () => {
    const policies = await prisma.$queryRaw<PolicyRow[]>`
      SELECT tablename, policyname, qual, with_check, roles::text[] AS roles
      FROM pg_policies
      WHERE schemaname = 'public' AND policyname ~ 'tenant_isolation$'
    `;

    expect(policies.length).toBe(TENANT_SCOPED_TABLES.length);

    // `IS NULL` in the predicate is the exact regression: it is how a policy
    // says "and if nobody told me which tenant, show everything".
    const failOpen = policies.filter(
      (policy) =>
        (policy.qual ?? '').includes('IS NULL') || (policy.with_check ?? '').includes('IS NULL'),
    );

    expect(failOpen.map((policy) => policy.tablename)).toEqual([]);
  });

  it('compares tenantId against the session tenant on read and on write', async () => {
    const policies = await prisma.$queryRaw<PolicyRow[]>`
      SELECT tablename, policyname, qual, with_check, roles::text[] AS roles
      FROM pg_policies
      WHERE schemaname = 'public' AND policyname ~ 'tenant_isolation$'
    `;

    for (const policy of policies) {
      expect(policy.qual ?? '').toContain('erp_current_tenant()');
      // A USING clause without a WITH CHECK clause filters what a tenant can
      // read while letting it write a row stamped with someone else's id.
      expect(policy.with_check ?? '').toContain('erp_current_tenant()');
      expect(policy.roles).toContain('erp_app');
    }
  });

  it('gives the application role no ability to reshape the schema', async () => {
    const [row] = await prisma.$queryRaw<{ can_create: boolean }[]>`
      SELECT has_schema_privilege('erp_app', 'public', 'CREATE') AS can_create
    `;

    expect(row?.can_create).toBe(false);
  });
});

describe('tenant binding', () => {
  it('resolves to NULL when nothing has been bound', async () => {
    const [row] = await prisma.$queryRaw<SettingRow[]>`
      SELECT erp_current_tenant()::text AS value
    `;

    expect(row?.value ?? null).toBeNull();
  });

  it('binds an explicit tenant for the whole transaction', async () => {
    const tenantId = randomUUID();

    const seen = await withTransaction(
      async (tx) => {
        const [row] = await tx.$queryRaw<SettingRow[]>`
          SELECT erp_current_tenant()::text AS value
        `;
        return row?.value ?? null;
      },
      { tenantId },
    );

    expect(seen).toBe(tenantId);
  });

  it('binds the ambient scope without being told', async () => {
    const tenantId = randomUUID();

    const seen = await runInTenantScope({ tenantId }, () =>
      withTransaction(async (tx) => {
        const [row] = await tx.$queryRaw<SettingRow[]>`
          SELECT erp_current_tenant()::text AS value
        `;
        return row?.value ?? null;
      }),
    );

    expect(seen).toBe(tenantId);
  });

  it('binds read transactions too', async () => {
    const tenantId = randomUUID();

    const seen = await runInTenantScope({ tenantId }, () =>
      withTenantRead(async (tx) => {
        const [row] = await tx.$queryRaw<SettingRow[]>`
          SELECT erp_current_tenant()::text AS value
        `;
        return row?.value ?? null;
      }),
    );

    expect(seen).toBe(tenantId);
  });

  it('releases the binding when the transaction ends', async () => {
    const tenantId = randomUUID();

    await withTransaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1`;
      },
      { tenantId },
    );

    // `set_config(..., true)` is transaction-local, so a pooled connection
    // cannot carry one request's tenant into the next request that borrows it.
    const [row] = await prisma.$queryRaw<SettingRow[]>`
      SELECT erp_current_tenant()::text AS value
    `;

    expect(row?.value ?? null).toBeNull();
  });

  it('keeps two concurrent scopes from seeing each other', async () => {
    const first = randomUUID();
    const second = randomUUID();

    const read = async (): Promise<string | null> =>
      withTransaction(async (tx) => {
        // A pause inside the transaction, so the two overlap in wall-clock time
        // rather than merely being started together.
        await new Promise((resolve) => setTimeout(resolve, 25));
        const [row] = await tx.$queryRaw<SettingRow[]>`
          SELECT erp_current_tenant()::text AS value
        `;
        return row?.value ?? null;
      });

    const [a, b] = await Promise.all([
      runInTenantScope({ tenantId: first }, read),
      runInTenantScope({ tenantId: second }, read),
    ]);

    expect(a).toBe(first);
    expect(b).toBe(second);
  });
});
