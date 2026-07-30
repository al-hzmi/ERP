-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 009 — Close the row-level security gap on the remaining child tables.
--
-- Migration 004 protects every table carrying a `tenantId`. It selects them *by that column*,
-- which is fine for the thirty-seven that have one and silently wrong for the ones that do
-- not: six tables were reachable only through a tenant-scoped parent, carried no `tenantId`
-- of their own, and so were passed over entirely. Under `erp_app` they were readable and
-- writable across every tenant in the cluster.
--
--   fiscal_periods        ← fiscal_years        who has closed which month
--   zatca_invoices        ← documents           invoice hashes, QR payloads, buyer VAT numbers
--   bank_statement_lines  ← bank_statements     every line of every bank statement
--   payroll_lines         ← payroll_runs        individual salaries
--   approval_steps        ← approval_policies   who may approve what
--   approval_actions      ← approval_requests   who approved what, and their comments
--
-- Two of those are as sensitive as anything in the schema. `payroll_lines` is salaries;
-- `bank_statement_lines` is a company's entire cash movement. One missing `WHERE` in one
-- query over either was a cross-tenant leak with nothing at all behind it — which is the
-- precise failure mode migration 004 exists to remove, left in place by the mechanism it
-- used to find its targets.
--
-- Migration 008 fixed the seventh, `depreciation_schedules`. This applies the same pattern to
-- the rest, and it is a separate migration on purpose: a security control belongs in a change
-- that is about the control, with its own assertions and its own tests, not folded into a
-- feature commit where it would be reviewed as a footnote.
--
-- ## The pattern, and why the tenant is denormalised rather than joined
--
-- A policy *could* be written as `EXISTS (SELECT 1 FROM parent WHERE ...)`. That was rejected:
-- the subquery runs per row on every read of the table, and on `bank_statement_lines` — which
-- the reconciliation screen scans by the hundred — it turns a policy that costs nothing into
-- one that dominates the query. Denormalising costs 16 bytes per row and makes the policy an
-- index-backed equality.
--
-- The risk denormalising introduces is a second, disagreeing source of truth. A CHECK
-- constraint cannot read another table, so each table gets a trigger that refuses any row
-- whose tenant differs from its parent's. It *raises* rather than silently correcting: a
-- mismatch means calling code has a bug, and quietly rewriting the value would hide it.
--
-- One generic trigger function serves all six, parameterised by parent table and foreign key
-- through `TG_ARGV`. Six near-identical functions would be six places for one of them to drift.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. The guard, once ───────────────────────────────────────────────────────
--
-- `format(..., %I)` quotes the identifiers from `TG_ARGV`, so the dynamic SQL cannot be
-- injected through a trigger definition. The values themselves are passed as parameters.

CREATE OR REPLACE FUNCTION erp_child_tenant_matches_parent()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_parent_table TEXT := TG_ARGV[0];
    v_fk_column    TEXT := TG_ARGV[1];
    v_fk_value     UUID;
    v_parent_tenant UUID;
BEGIN
    EXECUTE format('SELECT ($1).%I', v_fk_column) INTO v_fk_value USING NEW;

    IF v_fk_value IS NULL THEN
        -- A nullable parent reference cannot be checked against anything. None of the six
        -- have one today; this keeps the function honest if one ever does.
        RETURN NEW;
    END IF;

    EXECUTE format('SELECT "tenantId" FROM %I WHERE "id" = $1', v_parent_table)
       INTO v_parent_tenant USING v_fk_value;

    IF v_parent_tenant IS NULL THEN
        RAISE EXCEPTION '% % does not exist', v_parent_table, v_fk_value
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF NEW."tenantId" <> v_parent_tenant THEN
        RAISE EXCEPTION
            '%.tenantId (%) does not match %.tenantId (%)',
            TG_TABLE_NAME, NEW."tenantId", v_parent_table, v_parent_tenant
            USING ERRCODE = 'raise_exception';
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION erp_child_tenant_matches_parent() IS
    'Refuses a child row whose denormalised tenant disagrees with its parent''s. '
    'Args: parent table name, foreign key column name.';

-- ── 2. Column, backfill, constraint, policy, index — per table ───────────────
--
-- Driven from one mapping so the six cannot diverge, and so adding a seventh is one row.
-- Added nullable, backfilled from the parent, then made NOT NULL: an existing row has no
-- value to default to, and defaulting one would be inventing an owner for real data.

DO $$
DECLARE
    spec        TEXT[];
    v_child     TEXT;
    v_parent    TEXT;
    v_fk        TEXT;
    v_orphans   BIGINT;
    mapping     TEXT[][] := ARRAY[
        ARRAY['fiscal_periods',       'fiscal_years',       'fiscalYearId'],
        ARRAY['zatca_invoices',       'documents',          'documentId'],
        ARRAY['bank_statement_lines', 'bank_statements',    'bankStatementId'],
        ARRAY['payroll_lines',        'payroll_runs',       'payrollRunId'],
        ARRAY['approval_steps',       'approval_policies',  'policyId'],
        ARRAY['approval_actions',     'approval_requests',  'requestId']
    ];
BEGIN
    FOREACH spec SLICE 1 IN ARRAY mapping LOOP
        v_child  := spec[1];
        v_parent := spec[2];
        v_fk     := spec[3];

        EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS "tenantId" UUID', v_child);

        EXECUTE format(
            'UPDATE %I c SET "tenantId" = p."tenantId" FROM %I p WHERE p."id" = c.%I AND c."tenantId" IS NULL',
            v_child, v_parent, v_fk);

        -- Every one of these has a NOT NULL foreign key to its parent, so nothing can be left
        -- unattributed. Anything still NULL means the backfill itself failed, and deploying a
        -- NOT NULL over it would fail with a message that says nothing about why.
        EXECUTE format('SELECT count(*) FROM %I WHERE "tenantId" IS NULL', v_child)
           INTO v_orphans;

        IF v_orphans > 0 THEN
            RAISE EXCEPTION
                '% row(s) in % could not be attributed to a tenant', v_orphans, v_child;
        END IF;

        EXECUTE format('ALTER TABLE %I ALTER COLUMN "tenantId" SET NOT NULL', v_child);

        EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I',
                       v_child, v_child || '_tenantId_fkey');
        EXECUTE format(
            'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE',
            v_child, v_child || '_tenantId_fkey');

        -- The policy's predicate is `"tenantId" = ...`, so an index leading with that column
        -- is what keeps it from being a filter over the whole table.
        EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I ("tenantId")',
                       v_child || '_tenantId_idx', v_child);

        EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I',
                       'trg_' || v_child || '_tenant', v_child);
        EXECUTE format(
            'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF "tenantId", %I ON %I FOR EACH ROW EXECUTE FUNCTION erp_child_tenant_matches_parent(%L, %L)',
            'trg_' || v_child || '_tenant', v_fk, v_child, v_parent, v_fk);

        -- Same fail-closed shape as migration 004: `erp_current_tenant()` is NULL when
        -- unbound, and `"tenantId" = NULL` is not TRUE, so an unscoped session sees nothing.
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', v_child);
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I',
                       v_child || '_tenant_isolation', v_child);
        EXECUTE format($p$
            CREATE POLICY %I ON %I
            FOR ALL
            TO erp_app
            USING ("tenantId" = erp_current_tenant())
            WITH CHECK ("tenantId" = erp_current_tenant())
        $p$, v_child || '_tenant_isolation', v_child);

        EXECUTE format(
            'COMMENT ON COLUMN %I."tenantId" IS %L',
            v_child,
            format('Denormalised from %s so this table can carry its own RLS policy. Kept honest by trg_%s_tenant, not by convention.', v_parent, v_child));
    END LOOP;
END;
$$;

-- ── 3. Proof, per table ──────────────────────────────────────────────────────
--
-- A policy that failed to apply does not break anything visibly — it simply stops refusing
-- what it was added to refuse. Asserting on the catalogue is the only moment anyone would
-- notice, and this is the migration where noticing matters most.

DO $$
DECLARE
    t         TEXT;
    v_missing TEXT[] := ARRAY[]::TEXT[];
    tables    TEXT[] := ARRAY[
        'fiscal_periods', 'zatca_invoices', 'bank_statement_lines',
        'payroll_lines', 'approval_steps', 'approval_actions'
    ];
BEGIN
    FOREACH t IN ARRAY tables LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relname = t AND c.relrowsecurity
        ) THEN
            v_missing := v_missing || (t || ': RLS disabled');
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM pg_policies
             WHERE schemaname = 'public' AND tablename = t
               AND policyname = t || '_tenant_isolation'
               AND qual LIKE '%erp_current_tenant%'
               AND with_check LIKE '%erp_current_tenant%'
        ) THEN
            v_missing := v_missing || (t || ': policy absent or incomplete');
        END IF;

        -- A USING clause with no WITH CHECK filters what a tenant can read while letting it
        -- write a row stamped with someone else's id, which is the half-applied version of
        -- this control and the easiest one to ship by accident.
        IF EXISTS (
            SELECT 1 FROM pg_policies
             WHERE schemaname = 'public' AND tablename = t
               AND (qual LIKE '%IS NULL%' OR with_check LIKE '%IS NULL%')
        ) THEN
            v_missing := v_missing || (t || ': policy is fail-open');
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM pg_trigger
             WHERE tgname = 'trg_' || t || '_tenant' AND NOT tgisinternal
        ) THEN
            v_missing := v_missing || (t || ': tenant guard trigger absent');
        END IF;
    END LOOP;

    IF array_length(v_missing, 1) > 0 THEN
        RAISE EXCEPTION 'Child-table isolation incomplete — %', array_to_string(v_missing, '; ');
    END IF;
END;
$$;

-- ── 4. The gap cannot silently reopen ────────────────────────────────────────
--
-- The reason this migration was needed is that migration 004 found its targets by looking for
-- a `tenantId` column, so a table without one was invisible to it. This asserts the inverse
-- and stronger property: *every* table in the schema either has a tenant-isolation policy or
-- is on a short list of tables that deliberately do not need one. A new child table added
-- without a policy now fails the next `migrate deploy` instead of being discovered by
-- whoever reads a diff carefully enough.

DO $$
DECLARE
    v_unprotected TEXT[];
    -- Each exemption is a decision, not an oversight:
    --   _prisma_migrations   the migrator's ledger; erp_app has no grant on it at all
    --   tenants              the tenant list itself; a policy keyed on the row's own id would
    --                        be circular, and this is how a session resolves its tenant
    --   permissions          the static permission catalogue, identical for every tenant
    --   rate_limit_counters  consulted before authentication, when no tenant is known yet
    --   refresh_tokens       looked up by token hash before a tenant is established
    --   role_permissions     keyed to roles, which are already tenant-scoped
    --   user_roles           keyed to users, which are already tenant-scoped
    exempt TEXT[] := ARRAY[
        '_prisma_migrations', 'tenants', 'permissions', 'rate_limit_counters',
        'refresh_tokens', 'role_permissions', 'user_roles'
    ];
BEGIN
    SELECT array_agg(c.relname ORDER BY c.relname) INTO v_unprotected
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       -- Ordinary tables and partitioned parents. Partitions inherit their parent's policy,
       -- so listing them would demand a policy they cannot own.
       AND c.relkind IN ('r', 'p')
       AND c.relispartition = false
       AND NOT (c.relname = ANY (exempt))
       AND NOT EXISTS (
             SELECT 1 FROM pg_policies p
              WHERE p.schemaname = 'public'
                AND p.tablename = c.relname
                AND p.policyname = c.relname || '_tenant_isolation'
           );

    IF v_unprotected IS NOT NULL THEN
        RAISE EXCEPTION
            'Table(s) with no tenant-isolation policy and no exemption: %. Add a policy, or add the table to the exempt list in this migration with the reason.',
            array_to_string(v_unprotected, ', ');
    END IF;
END;
$$;
