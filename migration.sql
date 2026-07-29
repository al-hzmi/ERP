-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 004 — Enforce row-level tenant isolation.
--
-- Migration 002 installed the policies and enabled RLS, but two things left the
-- protection inert:
--
--   1. The policy read `erp_current_tenant() IS NULL OR "tenantId" = ...`, so a
--      session that never set `erp.tenant_id` saw *every* tenant's rows. That is
--      fail-open: the exact failure mode the policy exists to prevent.
--   2. The application connects as the table owner, and PostgreSQL exempts a
--      table's owner from its own policies unless RLS is FORCEd.
--
-- Together they meant tenant isolation rested entirely on every hand-written
-- `WHERE "tenantId" = ...` in application code. One forgotten clause in one
-- query is a cross-tenant data leak with nothing behind it.
--
-- This migration makes the policy fail-closed and creates the non-owner role the
-- application is meant to connect as. `erp_current_tenant()` returns NULL when
-- the GUC is unset, and `"tenantId" = NULL` evaluates to NULL — which is not
-- TRUE — so an unscoped session under `erp_app` now sees nothing at all. A bug
-- becomes an empty screen instead of another company's ledger.
--
-- Deliberately NOT done here: `FORCE ROW LEVEL SECURITY`. Migrations, the seed
-- generator and back-office tooling run as the owner and legitimately need to
-- cross tenants. Forcing RLS would break all three. The owner keeps its bypass;
-- the application stops using it.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. The application role ──────────────────────────────────────────────────
--
-- A NOLOGIN group role. It carries the privileges; a LOGIN role is granted
-- membership at deployment time (see the block at the foot of this file). Roles
-- are cluster-wide, so this is guarded rather than declared.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
        CREATE ROLE erp_app NOLOGIN;
    END IF;
END;
$$;

GRANT USAGE ON SCHEMA public TO erp_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO erp_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO erp_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO erp_app;

-- Tables created by later migrations inherit the same grants automatically,
-- so adding a model never silently produces a table the application cannot read.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO erp_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO erp_app;

-- The migration ledger is the migrator's business, not the application's.
REVOKE ALL ON TABLE "_prisma_migrations" FROM erp_app;

-- No DDL, ever. The application role can read and write rows; it cannot reshape
-- the schema, which is what turns an injection foothold into a catastrophe.
REVOKE CREATE ON SCHEMA public FROM erp_app;

-- ── 2. The tenant accessor ───────────────────────────────────────────────────
--
-- Redeclared with explicit volatility markers. STABLE lets the planner call it
-- once per statement rather than once per row — on a million-row scan that is
-- the difference between a policy that costs nothing and one that dominates the
-- query. PARALLEL SAFE keeps parallel plans available on the partitioned ledgers.

CREATE OR REPLACE FUNCTION erp_current_tenant()
RETURNS UUID
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
    SELECT NULLIF(current_setting('erp.tenant_id', true), '')::UUID;
$$;

COMMENT ON FUNCTION erp_current_tenant() IS
    'Tenant bound to the current transaction via set_config(''erp.tenant_id'', ...). '
    'NULL when unset, which makes every tenant-scoped policy reject every row.';

-- ── 3. Fail-closed policies ──────────────────────────────────────────────────
--
-- Same table list as migration 002. Each policy is dropped and recreated rather
-- than altered, because ALTER POLICY cannot change a USING clause from
-- permissive to restrictive in a way that is obvious when read six months later.

DO $$
DECLARE
    t TEXT;
    tenant_scoped TEXT[] := ARRAY[
        'users', 'roles', 'branches', 'warehouses', 'cost_centers', 'projects',
        'currencies', 'exchange_rates', 'accounts', 'account_mappings',
        'fiscal_years', 'journals', 'journal_lines', 'categories', 'brands',
        'units_of_measure', 'products', 'counterparties', 'documents',
        'document_lines', 'inventory_movements', 'stock_levels', 'cost_layers',
        'payments', 'payment_allocations', 'bank_statements', 'departments',
        'employees', 'payroll_runs', 'audit_logs', 'outbox_events',
        'number_sequences', 'notifications', 'approval_policies',
        'approval_requests', 'fixed_assets'
    ];
BEGIN
    FOREACH t IN ARRAY tenant_scoped LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
        EXECUTE format($p$
            CREATE POLICY %I ON %I
            FOR ALL
            TO erp_app
            USING ("tenantId" = erp_current_tenant())
            WITH CHECK ("tenantId" = erp_current_tenant())
        $p$, t || '_tenant_isolation', t);
    END LOOP;
END;
$$;

-- ── 4. Proof that it works ───────────────────────────────────────────────────
--
-- An assertion, not a comment. If the policy were still permissive this
-- migration would fail here rather than deploy a security control that does
-- nothing. The check runs as the owner, so it inspects the catalogue directly
-- instead of trying to read rows the owner is exempt from filtering.

DO $$
DECLARE
    permissive_count INT;
BEGIN
    SELECT count(*) INTO permissive_count
    FROM pg_policies
    WHERE schemaname = 'public'
      AND policyname LIKE '%\_tenant\_isolation'
      AND qual LIKE '%IS NULL%';

    IF permissive_count > 0 THEN
        RAISE EXCEPTION
            'Tenant isolation is still fail-open on % policy/policies', permissive_count;
    END IF;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- DEPLOYMENT — run once, in your database provider's SQL console.
--
-- This cannot live in a migration because it contains a password, and a
-- migration file belongs in version control.
--
--   CREATE ROLE erp_web LOGIN PASSWORD '<a long random password>';
--   GRANT erp_app TO erp_web;
--
-- Then point the application at it and leave the owner credentials for
-- migrations only:
--
--   DATABASE_URL=postgresql://erp_web:<password>@host:5432/erp   ← the app
--   DIRECT_URL=postgresql://erp:<password>@host:5432/erp         ← migrations
--
-- Verify the isolation actually bites, as erp_web:
--
--   SELECT count(*) FROM documents;                        -- expect 0
--   SELECT set_config('erp.tenant_id', '<a tenant uuid>', false);
--   SELECT count(*) FROM documents;                        -- expect that tenant's rows
--
-- ⚠️ Do not switch DATABASE_URL until every read path runs inside a tenant
-- scope. Until then the application still connects as the owner and this
-- migration is a loaded safety net rather than an active control.
-- ─────────────────────────────────────────────────────────────────────────────
