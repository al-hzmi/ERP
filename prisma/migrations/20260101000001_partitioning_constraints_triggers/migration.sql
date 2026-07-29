-- ═════════════════════════════════════════════════════════════════════════════
--  Migration 002 — Physical hardening layer
--
--  Prisma's declarative schema cannot express declarative partitioning, CHECK
--  constraints, triggers, trigram indexes or row-level security. Everything the
--  ORM cannot say is said here, so that the invariants hold even against a
--  direct `psql` session — not merely against well-behaved application code.
--
--  Sections:
--    1. Append-only / immutable tables converted to RANGE partitioned
--    2. Partition provisioning (historic + forward-looking) and helper function
--    3. CHECK constraints — the arithmetic invariants
--    4. Trigger functions — immutability, balance maintenance, stock guards
--    5. Search infrastructure — pg_trgm + tsvector + GIN
--    6. Partial unique indexes (NULL-aware uniqueness Prisma cannot express)
--    7. Gap-free sequence allocation
--    8. Row Level Security scaffolding for multi-tenancy
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 1 — Convert append-only ledgers to declaratively partitioned tables.
--
-- These tables are empty at this point in a fresh installation, so a drop and
-- recreate is lossless. PostgreSQL cannot convert an existing ordinary table to
-- a partitioned one in place, and doing this now (rather than at the first
-- billion rows) is precisely the point.
-- ─────────────────────────────────────────────────────────────────────────────

DROP TABLE "journal_lines";
DROP TABLE "journals";
DROP TABLE "audit_logs";
DROP TABLE "inventory_movements";

-- ── journals ────────────────────────────────────────────────────────────────
CREATE TABLE "journals" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "tenantId" UUID NOT NULL,
    "entryNumber" VARCHAR(32) NOT NULL,
    "type" "JournalType" NOT NULL,
    "status" "JournalStatus" NOT NULL DEFAULT 'DRAFT',
    "date" DATE NOT NULL,
    "branchId" UUID,
    "fiscalPeriodId" UUID,
    "descriptionAr" VARCHAR(512) NOT NULL,
    "descriptionEn" VARCHAR(512),
    "referenceType" VARCHAR(32),
    "referenceId" VARCHAR(64),
    "currency" CHAR(3) NOT NULL DEFAULT 'SAR',
    "exchangeRate" DECIMAL(19,6) NOT NULL DEFAULT 1,
    "totalDebit" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "totalCredit" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "reversesJournalId" UUID,
    "isReversed" BOOLEAN NOT NULL DEFAULT false,
    "createdById" UUID NOT NULL,
    "postedById" UUID,
    "postedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "journals_pkey" PRIMARY KEY ("id","date")
) PARTITION BY RANGE ("date");

CREATE INDEX "journals_tenantId_date_idx" ON "journals"("tenantId", "date");
CREATE INDEX "journals_tenantId_status_date_idx" ON "journals"("tenantId", "status", "date");
CREATE INDEX "journals_tenantId_referenceType_referenceId_idx" ON "journals"("tenantId", "referenceType", "referenceId");
CREATE INDEX "journals_tenantId_type_date_idx" ON "journals"("tenantId", "type", "date");
CREATE UNIQUE INDEX "journals_tenantId_entryNumber_date_key" ON "journals"("tenantId", "entryNumber", "date");

ALTER TABLE "journals" ADD CONSTRAINT "journals_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "journals" ADD CONSTRAINT "journals_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "journals" ADD CONSTRAINT "journals_fiscalPeriodId_fkey" FOREIGN KEY ("fiscalPeriodId") REFERENCES "fiscal_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "journals" ADD CONSTRAINT "journals_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "journals" ADD CONSTRAINT "journals_postedById_fkey" FOREIGN KEY ("postedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── journal_lines ───────────────────────────────────────────────────────────
CREATE TABLE "journal_lines" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "tenantId" UUID NOT NULL,
    "journalId" UUID NOT NULL,
    "journalDate" DATE NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "accountId" UUID NOT NULL,
    "debit" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "credit" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "foreignDebit" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "foreignCredit" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "description" VARCHAR(512),
    "costCenterId" UUID,
    "projectId" UUID,
    "counterpartyId" UUID,

    CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id","journalDate")
) PARTITION BY RANGE ("journalDate");

CREATE INDEX "journal_lines_journalId_idx" ON "journal_lines"("journalId");
CREATE INDEX "journal_lines_tenantId_accountId_journalDate_idx" ON "journal_lines"("tenantId", "accountId", "journalDate");
CREATE INDEX "journal_lines_tenantId_counterpartyId_journalDate_idx" ON "journal_lines"("tenantId", "counterpartyId", "journalDate");

ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_journalId_journalDate_fkey" FOREIGN KEY ("journalId", "journalDate") REFERENCES "journals"("id", "date") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_costCenterId_fkey" FOREIGN KEY ("costCenterId") REFERENCES "cost_centers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "counterparties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── audit_logs ──────────────────────────────────────────────────────────────
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "tenantId" UUID NOT NULL,
    "userId" UUID,
    "action" "AuditAction" NOT NULL,
    "entityType" VARCHAR(64) NOT NULL,
    "entityId" VARCHAR(64) NOT NULL,
    "fieldName" VARCHAR(64),
    "oldValue" TEXT,
    "newValue" TEXT,
    "metadata" JSONB,
    "ipAddress" VARCHAR(64),
    "userAgent" VARCHAR(512),
    "sessionId" VARCHAR(64),
    "correlationId" UUID,
    "timestamp" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id","timestamp")
) PARTITION BY RANGE ("timestamp");

CREATE INDEX "audit_logs_tenantId_entityType_entityId_idx" ON "audit_logs"("tenantId", "entityType", "entityId");
CREATE INDEX "audit_logs_tenantId_userId_timestamp_idx" ON "audit_logs"("tenantId", "userId", "timestamp");
CREATE INDEX "audit_logs_tenantId_timestamp_idx" ON "audit_logs"("tenantId", "timestamp");
CREATE INDEX "audit_logs_correlationId_idx" ON "audit_logs"("correlationId");

ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── inventory_movements ─────────────────────────────────────────────────────
CREATE TABLE "inventory_movements" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "tenantId" UUID NOT NULL,
    "movementNumber" VARCHAR(32) NOT NULL,
    "type" "MovementType" NOT NULL,
    "movementDate" DATE NOT NULL,
    "productId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "quantity" DECIMAL(19,4) NOT NULL,
    "unitCost" DECIMAL(19,4) NOT NULL,
    "totalCost" DECIMAL(19,4) NOT NULL,
    "balanceAfter" DECIMAL(19,4) NOT NULL,
    "referenceType" VARCHAR(32),
    "referenceId" VARCHAR(64),
    "batchNumber" VARCHAR(64),
    "serialNumber" VARCHAR(64),
    "expiryDate" DATE,
    "fromWarehouseId" UUID,
    "toWarehouseId" UUID,
    "transferGroupId" UUID,
    "notes" VARCHAR(512),
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id","movementDate")
) PARTITION BY RANGE ("movementDate");

CREATE INDEX "inventory_movements_tenantId_productId_warehouseId_movement_idx" ON "inventory_movements"("tenantId", "productId", "warehouseId", "movementDate");
CREATE INDEX "inventory_movements_tenantId_referenceType_referenceId_idx" ON "inventory_movements"("tenantId", "referenceType", "referenceId");
CREATE INDEX "inventory_movements_tenantId_movementDate_idx" ON "inventory_movements"("tenantId", "movementDate");
CREATE INDEX "inventory_movements_transferGroupId_idx" ON "inventory_movements"("transferGroupId");
CREATE UNIQUE INDEX "inventory_movements_tenantId_movementNumber_movementDate_key" ON "inventory_movements"("tenantId", "movementNumber", "movementDate");

ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_fromWarehouseId_fkey" FOREIGN KEY ("fromWarehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_toWarehouseId_fkey" FOREIGN KEY ("toWarehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 2 — Partition provisioning
--
-- `erp_ensure_year_partition` / `erp_ensure_month_partition` are idempotent and
-- are called both here (to backfill) and by a scheduled job (to look ahead).
-- Every parent also gets a DEFAULT partition so an out-of-range insert degrades
-- to "slower" rather than "failed" — availability beats tidiness in a ledger.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION erp_ensure_year_partition(parent TEXT, yr INT)
RETURNS VOID AS $$
DECLARE
    part_name TEXT := format('%s_y%s', parent, yr);
BEGIN
    IF to_regclass(quote_ident(part_name)) IS NULL THEN
        EXECUTE format(
            'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
            part_name, parent,
            make_date(yr, 1, 1), make_date(yr + 1, 1, 1)
        );
    END IF;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION erp_ensure_year_partition(TEXT, INT) IS
    'Idempotently creates a yearly range partition for a date-partitioned ledger table.';

CREATE OR REPLACE FUNCTION erp_ensure_month_partition(parent TEXT, yr INT, mo INT)
RETURNS VOID AS $$
DECLARE
    part_name  TEXT := format('%s_y%sm%s', parent, yr, lpad(mo::TEXT, 2, '0'));
    range_from TIMESTAMPTZ := make_timestamptz(yr, mo, 1, 0, 0, 0, 'UTC');
    range_to   TIMESTAMPTZ := make_timestamptz(yr, mo, 1, 0, 0, 0, 'UTC') + INTERVAL '1 month';
BEGIN
    IF to_regclass(quote_ident(part_name)) IS NULL THEN
        EXECUTE format(
            'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
            part_name, parent, range_from, range_to
        );
    END IF;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION erp_ensure_month_partition(TEXT, INT, INT) IS
    'Idempotently creates a monthly range partition for a timestamptz-partitioned table.';

DO $$
DECLARE
    yr INT;
    mo INT;
BEGIN
    -- Yearly ledgers: 2023 (opening balances) through 2032.
    FOR yr IN 2023..2032 LOOP
        PERFORM erp_ensure_year_partition('journals', yr);
        PERFORM erp_ensure_year_partition('journal_lines', yr);
        PERFORM erp_ensure_year_partition('inventory_movements', yr);
    END LOOP;

    -- Audit logs churn far faster; monthly granularity keeps pruning cheap.
    FOR yr IN 2023..2032 LOOP
        FOR mo IN 1..12 LOOP
            PERFORM erp_ensure_month_partition('audit_logs', yr, mo);
        END LOOP;
    END LOOP;
END;
$$;

CREATE TABLE "journals_default"            PARTITION OF "journals"            DEFAULT;
CREATE TABLE "journal_lines_default"       PARTITION OF "journal_lines"       DEFAULT;
CREATE TABLE "inventory_movements_default" PARTITION OF "inventory_movements" DEFAULT;
CREATE TABLE "audit_logs_default"          PARTITION OF "audit_logs"          DEFAULT;

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 3 — CHECK constraints: the arithmetic that must never be violated.
-- ─────────────────────────────────────────────────────────────────────────────

-- A journal line is single-sided, non-negative, and never zero-valued.
ALTER TABLE "journal_lines"
    ADD CONSTRAINT "journal_lines_debit_non_negative"  CHECK ("debit"  >= 0),
    ADD CONSTRAINT "journal_lines_credit_non_negative" CHECK ("credit" >= 0),
    ADD CONSTRAINT "journal_lines_single_sided"        CHECK ("debit" = 0 OR "credit" = 0),
    ADD CONSTRAINT "journal_lines_non_zero"            CHECK ("debit" + "credit" > 0);

-- A journal's own header totals must agree with each other to the halala.
-- Draft journals are exempt while the user is still building them.
ALTER TABLE "journals"
    ADD CONSTRAINT "journals_totals_non_negative" CHECK ("totalDebit" >= 0 AND "totalCredit" >= 0),
    ADD CONSTRAINT "journals_balanced_when_posted"
        CHECK ("status" = 'DRAFT' OR "totalDebit" = "totalCredit"),
    ADD CONSTRAINT "journals_exchange_rate_positive" CHECK ("exchangeRate" > 0);

-- Quantities carry no sign: direction lives in `type`, never in the number.
ALTER TABLE "inventory_movements"
    ADD CONSTRAINT "inventory_movements_quantity_positive" CHECK ("quantity" > 0),
    ADD CONSTRAINT "inventory_movements_unit_cost_non_negative" CHECK ("unitCost" >= 0),
    ADD CONSTRAINT "inventory_movements_transfer_distinct"
        CHECK ("fromWarehouseId" IS NULL OR "toWarehouseId" IS NULL OR "fromWarehouseId" <> "toWarehouseId");

ALTER TABLE "stock_levels"
    ADD CONSTRAINT "stock_levels_reserved_non_negative" CHECK ("quantityReserved" >= 0),
    ADD CONSTRAINT "stock_levels_average_cost_non_negative" CHECK ("averageCost" >= 0);

ALTER TABLE "cost_layers"
    ADD CONSTRAINT "cost_layers_quantities_valid"
        CHECK ("originalQuantity" > 0 AND "remainingQuantity" >= 0 AND "remainingQuantity" <= "originalQuantity"),
    ADD CONSTRAINT "cost_layers_unit_cost_non_negative" CHECK ("unitCost" >= 0);

ALTER TABLE "document_lines"
    ADD CONSTRAINT "document_lines_quantity_positive"     CHECK ("quantity" > 0),
    ADD CONSTRAINT "document_lines_unit_price_non_negative" CHECK ("unitPrice" >= 0),
    ADD CONSTRAINT "document_lines_discount_valid"
        CHECK ("discount" >= 0 AND "discount" <= "quantity" * "unitPrice"),
    ADD CONSTRAINT "document_lines_tax_rate_valid"       CHECK ("taxRate" >= 0 AND "taxRate" <= 100);

ALTER TABLE "documents"
    ADD CONSTRAINT "documents_totals_non_negative"
        CHECK ("subtotal" >= 0 AND "discountTotal" >= 0 AND "taxTotal" >= 0 AND "total" >= 0),
    ADD CONSTRAINT "documents_paid_non_negative"    CHECK ("paidAmount" >= 0),
    ADD CONSTRAINT "documents_exchange_rate_positive" CHECK ("exchangeRate" > 0),
    ADD CONSTRAINT "documents_due_after_issue"      CHECK ("dueDate" >= "issueDate");

ALTER TABLE "payments"
    ADD CONSTRAINT "payments_amount_positive"       CHECK ("amount" > 0),
    ADD CONSTRAINT "payments_unallocated_valid"     CHECK ("unallocatedAmount" >= 0 AND "unallocatedAmount" <= "amount"),
    ADD CONSTRAINT "payments_exchange_rate_positive" CHECK ("exchangeRate" > 0),
    ADD CONSTRAINT "payments_check_fields_present"
        CHECK ("method" <> 'CHECK' OR ("checkNumber" IS NOT NULL AND "checkDate" IS NOT NULL));

ALTER TABLE "payment_allocations"
    ADD CONSTRAINT "payment_allocations_amount_positive" CHECK ("amount" > 0);

ALTER TABLE "exchange_rates"
    ADD CONSTRAINT "exchange_rates_rate_positive" CHECK ("rate" > 0),
    ADD CONSTRAINT "exchange_rates_distinct_currencies" CHECK ("fromCurrency" <> "toCurrency");

ALTER TABLE "counterparties"
    ADD CONSTRAINT "counterparties_credit_limit_non_negative" CHECK ("creditLimit" >= 0),
    ADD CONSTRAINT "counterparties_payment_terms_valid" CHECK ("paymentTerms" >= 0 AND "paymentTerms" <= 365);

-- The natural side of an account is dictated by its type. A revenue account with
-- a DEBIT nature is not an opinion — it is a data error.
ALTER TABLE "accounts"
    ADD CONSTRAINT "accounts_nature_matches_type" CHECK (
        ("type" IN ('ASSET', 'EXPENSE') AND "nature" = 'DEBIT') OR
        ("type" IN ('LIABILITY', 'EQUITY', 'REVENUE') AND "nature" = 'CREDIT')
    ),
    ADD CONSTRAINT "accounts_control_is_not_free_posting" CHECK (NOT ("isControl" AND NOT "isPostable"));

ALTER TABLE "products"
    ADD CONSTRAINT "products_prices_non_negative" CHECK ("salePrice" >= 0 AND "costPrice" >= 0),
    ADD CONSTRAINT "products_tax_rate_valid" CHECK ("taxRate" >= 0 AND "taxRate" <= 100);

ALTER TABLE "employees"
    ADD CONSTRAINT "employees_salary_non_negative" CHECK ("basicSalary" >= 0),
    ADD CONSTRAINT "employees_termination_after_hire"
        CHECK ("terminationDate" IS NULL OR "terminationDate" >= "hireDate");

ALTER TABLE "fixed_assets"
    ADD CONSTRAINT "fixed_assets_cost_positive" CHECK ("acquisitionCost" > 0),
    ADD CONSTRAINT "fixed_assets_salvage_valid" CHECK ("salvageValue" >= 0 AND "salvageValue" < "acquisitionCost"),
    ADD CONSTRAINT "fixed_assets_useful_life_positive" CHECK ("usefulLifeMonths" > 0);

ALTER TABLE "fiscal_periods"
    ADD CONSTRAINT "fiscal_periods_range_valid" CHECK ("endDate" >= "startDate"),
    ADD CONSTRAINT "fiscal_periods_number_valid" CHECK ("periodNumber" BETWEEN 1 AND 13);

ALTER TABLE "fiscal_years"
    ADD CONSTRAINT "fiscal_years_range_valid" CHECK ("endDate" > "startDate");

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 4 — Triggers: immutability, ledger maintenance, stock guards.
--
-- Error messages are raised with a stable ERRCODE so the application layer can
-- translate them into localised, user-facing text without string matching.
-- ─────────────────────────────────────────────────────────────────────────────

-- 4.1 Generic append-only guard ----------------------------------------------
CREATE OR REPLACE FUNCTION erp_append_only_guard()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        USING ERRCODE = 'ERP01',
              MESSAGE = format('Table %I is append-only; %s is not permitted.', TG_TABLE_NAME, TG_OP),
              HINT    = 'Correct the record with a compensating entry instead.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_logs_append_only"
    BEFORE UPDATE OR DELETE ON "audit_logs"
    FOR EACH ROW EXECUTE FUNCTION erp_append_only_guard();

CREATE TRIGGER "inventory_movements_append_only"
    BEFORE UPDATE OR DELETE ON "inventory_movements"
    FOR EACH ROW EXECUTE FUNCTION erp_append_only_guard();

-- 4.2 Posted journals are frozen ---------------------------------------------
-- A posted journal may only ever be marked as reversed. Everything else about
-- it — date, amounts, accounts, description — is history.
CREATE OR REPLACE FUNCTION erp_journal_immutability()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD."status" <> 'DRAFT' THEN
            RAISE EXCEPTION
                USING ERRCODE = 'ERP02',
                      MESSAGE = format('Journal %s is posted and cannot be deleted.', OLD."entryNumber"),
                      HINT    = 'Create a reversing journal entry instead.';
        END IF;
        RETURN OLD;
    END IF;

    -- A journal may never be born posted: it must pass through DRAFT so that its
    -- lines exist and are balanced before the posting trigger fires.
    IF TG_OP = 'INSERT' AND NEW."status" <> 'DRAFT' THEN
        RAISE EXCEPTION
            USING ERRCODE = 'ERP03',
                  MESSAGE = 'A journal must be created in DRAFT status and posted explicitly.';
    END IF;

    IF TG_OP = 'UPDATE' AND OLD."status" = 'POSTED' THEN
        IF NEW."status" NOT IN ('POSTED', 'REVERSED')
           OR NEW."date"        IS DISTINCT FROM OLD."date"
           OR NEW."entryNumber" IS DISTINCT FROM OLD."entryNumber"
           OR NEW."totalDebit"  IS DISTINCT FROM OLD."totalDebit"
           OR NEW."totalCredit" IS DISTINCT FROM OLD."totalCredit"
           OR NEW."type"        IS DISTINCT FROM OLD."type"
           OR NEW."currency"    IS DISTINCT FROM OLD."currency"
           OR NEW."exchangeRate" IS DISTINCT FROM OLD."exchangeRate"
        THEN
            RAISE EXCEPTION
                USING ERRCODE = 'ERP02',
                      MESSAGE = format('Journal %s is posted and cannot be modified.', OLD."entryNumber"),
                      HINT    = 'Create a reversing journal entry instead.';
        END IF;
    END IF;

    IF TG_OP = 'UPDATE' AND OLD."status" = 'REVERSED' AND NEW."status" <> 'REVERSED' THEN
        RAISE EXCEPTION
            USING ERRCODE = 'ERP02',
                  MESSAGE = format('Journal %s is already reversed.', OLD."entryNumber");
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "journals_immutability"
    BEFORE INSERT OR UPDATE OR DELETE ON "journals"
    FOR EACH ROW EXECUTE FUNCTION erp_journal_immutability();

-- 4.3 Lines of a posted journal are frozen -----------------------------------
CREATE OR REPLACE FUNCTION erp_journal_line_immutability()
RETURNS TRIGGER AS $$
DECLARE
    parent_status "JournalStatus";
    parent_number TEXT;
    ref_id   UUID;
    ref_date DATE;
BEGIN
    IF TG_OP = 'DELETE' THEN
        ref_id := OLD."journalId"; ref_date := OLD."journalDate";
    ELSE
        ref_id := NEW."journalId"; ref_date := NEW."journalDate";
    END IF;

    SELECT j."status", j."entryNumber" INTO parent_status, parent_number
    FROM "journals" j WHERE j."id" = ref_id AND j."date" = ref_date;

    -- On DELETE the parent may already be gone (ON DELETE CASCADE of a draft).
    IF parent_status IS NULL THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;

    IF parent_status <> 'DRAFT' THEN
        RAISE EXCEPTION
            USING ERRCODE = 'ERP02',
                  MESSAGE = format('Journal %s is posted; its lines cannot be changed.', parent_number),
                  HINT    = 'Create a reversing journal entry instead.';
    END IF;

    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "journal_lines_immutability"
    BEFORE INSERT OR UPDATE OR DELETE ON "journal_lines"
    FOR EACH ROW EXECUTE FUNCTION erp_journal_line_immutability();

-- 4.4 Posting a journal must balance, and it moves account balances ----------
-- This is the single place where `accounts.balance` changes. Because it runs in
-- the same transaction as the status flip, the cached balance can never drift
-- from the sum of its posted lines.
CREATE OR REPLACE FUNCTION erp_apply_journal_to_balances()
RETURNS TRIGGER AS $$
DECLARE
    sum_debit  DECIMAL(19,4);
    sum_credit DECIMAL(19,4);
    line_count INT;
BEGIN
    IF NEW."status" <> 'POSTED' OR OLD."status" = 'POSTED' THEN
        RETURN NEW;
    END IF;

    SELECT COALESCE(SUM(l."debit"), 0), COALESCE(SUM(l."credit"), 0), COUNT(*)
      INTO sum_debit, sum_credit, line_count
      FROM "journal_lines" l
     WHERE l."journalId" = NEW."id" AND l."journalDate" = NEW."date";

    IF line_count < 2 THEN
        RAISE EXCEPTION
            USING ERRCODE = 'ERP04',
                  MESSAGE = format('Journal %s must have at least two lines to be posted.', NEW."entryNumber");
    END IF;

    IF sum_debit <> sum_credit THEN
        RAISE EXCEPTION
            USING ERRCODE = 'ERP05',
                  MESSAGE = format(
                      'Journal %s is out of balance: debit %s <> credit %s.',
                      NEW."entryNumber", sum_debit, sum_credit);
    END IF;

    IF sum_debit <> NEW."totalDebit" OR sum_credit <> NEW."totalCredit" THEN
        RAISE EXCEPTION
            USING ERRCODE = 'ERP05',
                  MESSAGE = format(
                      'Journal %s header totals disagree with its lines.', NEW."entryNumber");
    END IF;

    -- Debit increases an asset/expense and decreases a liability/equity/revenue.
    UPDATE "accounts" a
       SET "balance" = a."balance" + agg.delta
      FROM (
            SELECT l."accountId" AS account_id,
                   SUM(CASE WHEN acc."nature" = 'DEBIT'
                            THEN l."debit" - l."credit"
                            ELSE l."credit" - l."debit"
                       END) AS delta
              FROM "journal_lines" l
              JOIN "accounts" acc ON acc."id" = l."accountId"
             WHERE l."journalId" = NEW."id" AND l."journalDate" = NEW."date"
             GROUP BY l."accountId"
           ) agg
     WHERE a."id" = agg.account_id;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "journals_apply_balances"
    AFTER UPDATE OF "status" ON "journals"
    FOR EACH ROW EXECUTE FUNCTION erp_apply_journal_to_balances();

-- 4.5 Only leaf, active accounts may receive a posting ------------------------
CREATE OR REPLACE FUNCTION erp_validate_journal_line_account()
RETURNS TRIGGER AS $$
DECLARE
    acc RECORD;
BEGIN
    SELECT "isPostable", "isActive", "code", "nameAr" INTO acc
      FROM "accounts" WHERE "id" = NEW."accountId";

    IF NOT acc."isPostable" THEN
        RAISE EXCEPTION
            USING ERRCODE = 'ERP06',
                  MESSAGE = format('Account %s (%s) is a summary account and cannot be posted to.',
                                   acc."code", acc."nameAr");
    END IF;

    IF NOT acc."isActive" THEN
        RAISE EXCEPTION
            USING ERRCODE = 'ERP06',
                  MESSAGE = format('Account %s (%s) is inactive.', acc."code", acc."nameAr");
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "journal_lines_validate_account"
    BEFORE INSERT ON "journal_lines"
    FOR EACH ROW EXECUTE FUNCTION erp_validate_journal_line_account();

-- 4.6 Account code is immutable ----------------------------------------------
CREATE OR REPLACE FUNCTION erp_account_code_immutable()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."code" IS DISTINCT FROM OLD."code" THEN
        RAISE EXCEPTION
            USING ERRCODE = 'ERP07',
                  MESSAGE = format('Account code %s is immutable once created.', OLD."code");
    END IF;
    IF NEW."type" IS DISTINCT FROM OLD."type" AND OLD."balance" <> 0 THEN
        RAISE EXCEPTION
            USING ERRCODE = 'ERP07',
                  MESSAGE = format('Account %s has a non-zero balance; its type cannot change.', OLD."code");
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "accounts_code_immutable"
    BEFORE UPDATE ON "accounts"
    FOR EACH ROW EXECUTE FUNCTION erp_account_code_immutable();

-- 4.7 Posted documents are frozen --------------------------------------------
-- Settlement columns stay mutable: paying an invoice does not amend it.
CREATE OR REPLACE FUNCTION erp_document_immutability()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD."isPosted" THEN
            RAISE EXCEPTION
                USING ERRCODE = 'ERP08',
                      MESSAGE = format('Document %s is posted and cannot be deleted.', OLD."documentNumber"),
                      HINT    = 'Issue a credit note to reverse it.';
        END IF;
        RETURN OLD;
    END IF;

    IF OLD."isPosted" THEN
        IF NEW."documentNumber" IS DISTINCT FROM OLD."documentNumber"
           OR NEW."type"           IS DISTINCT FROM OLD."type"
           OR NEW."counterpartyId" IS DISTINCT FROM OLD."counterpartyId"
           OR NEW."issueDate"      IS DISTINCT FROM OLD."issueDate"
           OR NEW."subtotal"       IS DISTINCT FROM OLD."subtotal"
           OR NEW."discountTotal"  IS DISTINCT FROM OLD."discountTotal"
           OR NEW."taxTotal"       IS DISTINCT FROM OLD."taxTotal"
           OR NEW."total"          IS DISTINCT FROM OLD."total"
           OR NEW."currency"       IS DISTINCT FROM OLD."currency"
           OR NEW."exchangeRate"   IS DISTINCT FROM OLD."exchangeRate"
           OR NEW."branchId"       IS DISTINCT FROM OLD."branchId"
           OR NEW."warehouseId"    IS DISTINCT FROM OLD."warehouseId"
        THEN
            RAISE EXCEPTION
                USING ERRCODE = 'ERP08',
                      MESSAGE = format('Document %s is posted and cannot be modified.', OLD."documentNumber"),
                      HINT    = 'Issue a credit note to correct it.';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "documents_immutability"
    BEFORE UPDATE OR DELETE ON "documents"
    FOR EACH ROW EXECUTE FUNCTION erp_document_immutability();

CREATE OR REPLACE FUNCTION erp_document_line_immutability()
RETURNS TRIGGER AS $$
DECLARE
    parent RECORD;
    ref_id UUID;
BEGIN
    ref_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."documentId" ELSE NEW."documentId" END;
    SELECT "isPosted", "documentNumber" INTO parent FROM "documents" WHERE "id" = ref_id;

    IF parent IS NULL THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;

    IF parent."isPosted" THEN
        RAISE EXCEPTION
            USING ERRCODE = 'ERP08',
                  MESSAGE = format('Document %s is posted; its lines cannot be changed.', parent."documentNumber"),
                  HINT    = 'Issue a credit note to correct it.';
    END IF;

    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "document_lines_immutability"
    BEFORE INSERT OR UPDATE OR DELETE ON "document_lines"
    FOR EACH ROW EXECUTE FUNCTION erp_document_line_immutability();

-- 4.8 Negative stock guard, honouring the tenant policy flag ------------------
CREATE OR REPLACE FUNCTION erp_negative_stock_guard()
RETURNS TRIGGER AS $$
DECLARE
    allow_negative BOOLEAN;
    product_name   TEXT;
    warehouse_name TEXT;
BEGIN
    IF NEW."quantityOnHand" >= 0 THEN
        RETURN NEW;
    END IF;

    SELECT "allowNegativeStock" INTO allow_negative FROM "tenants" WHERE "id" = NEW."tenantId";

    IF COALESCE(allow_negative, FALSE) THEN
        RETURN NEW;
    END IF;

    SELECT p."nameAr" INTO product_name   FROM "products"   p WHERE p."id" = NEW."productId";
    SELECT w."nameAr" INTO warehouse_name FROM "warehouses" w WHERE w."id" = NEW."warehouseId";

    RAISE EXCEPTION
        USING ERRCODE = 'ERP09',
              MESSAGE = format('Stock for %s in %s would fall to %s; negative stock is not permitted.',
                               product_name, warehouse_name, NEW."quantityOnHand");
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "stock_levels_negative_guard"
    BEFORE INSERT OR UPDATE ON "stock_levels"
    FOR EACH ROW EXECUTE FUNCTION erp_negative_stock_guard();

-- 4.9 A payment allocation may never exceed the document's outstanding balance -
CREATE OR REPLACE FUNCTION erp_allocation_within_outstanding()
RETURNS TRIGGER AS $$
DECLARE
    doc_total  DECIMAL(19,4);
    doc_number TEXT;
    allocated  DECIMAL(19,4);
    allow_over BOOLEAN;
BEGIN
    SELECT d."total", d."documentNumber", t."allowOverpayment"
      INTO doc_total, doc_number, allow_over
      FROM "documents" d
      JOIN "tenants" t ON t."id" = d."tenantId"
     WHERE d."id" = NEW."documentId";

    SELECT COALESCE(SUM(a."amount"), 0) INTO allocated
      FROM "payment_allocations" a
     WHERE a."documentId" = NEW."documentId"
       AND a."id" <> NEW."id";

    IF NOT COALESCE(allow_over, FALSE) AND allocated + NEW."amount" > doc_total THEN
        RAISE EXCEPTION
            USING ERRCODE = 'ERP10',
                  MESSAGE = format(
                      'Allocating %s to document %s would exceed its outstanding balance of %s.',
                      NEW."amount", doc_number, doc_total - allocated);
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "payment_allocations_within_outstanding"
    BEFORE INSERT OR UPDATE ON "payment_allocations"
    FOR EACH ROW EXECUTE FUNCTION erp_allocation_within_outstanding();

-- 4.10 Posting into a closed fiscal period is refused ------------------------
CREATE OR REPLACE FUNCTION erp_fiscal_period_open_guard()
RETURNS TRIGGER AS $$
DECLARE
    period_status "FiscalStatus";
BEGIN
    IF NEW."status" <> 'POSTED' OR NEW."fiscalPeriodId" IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT "status" INTO period_status FROM "fiscal_periods" WHERE "id" = NEW."fiscalPeriodId";

    IF period_status = 'CLOSED' THEN
        RAISE EXCEPTION
            USING ERRCODE = 'ERP11',
                  MESSAGE = format('The fiscal period for %s is closed; no entries may be posted to it.', NEW."date");
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "journals_fiscal_period_guard"
    BEFORE UPDATE OF "status" ON "journals"
    FOR EACH ROW EXECUTE FUNCTION erp_fiscal_period_open_guard();

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 5 — Search infrastructure.
--
-- Two complementary strategies:
--   * pg_trgm GIN indexes power fuzzy / substring / typo-tolerant matching, so
--     that typing `1001` finds `BTC-1001` without a leading-wildcard scan.
--   * tsvector generated columns power ranked full-text search over names.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE INDEX "products_sku_trgm_idx"     ON "products"     USING GIN ("sku" gin_trgm_ops);
CREATE INDEX "products_name_ar_trgm_idx" ON "products"     USING GIN ("nameAr" gin_trgm_ops);
CREATE INDEX "products_name_en_trgm_idx" ON "products"     USING GIN ("nameEn" gin_trgm_ops);
CREATE INDEX "products_barcode_trgm_idx" ON "products"     USING GIN ("barcode" gin_trgm_ops);

CREATE INDEX "counterparties_code_trgm_idx"    ON "counterparties" USING GIN ("code" gin_trgm_ops);
CREATE INDEX "counterparties_name_ar_trgm_idx" ON "counterparties" USING GIN ("nameAr" gin_trgm_ops);
CREATE INDEX "counterparties_name_en_trgm_idx" ON "counterparties" USING GIN ("nameEn" gin_trgm_ops);
CREATE INDEX "counterparties_phone_trgm_idx"   ON "counterparties" USING GIN ("phone" gin_trgm_ops);
CREATE INDEX "counterparties_email_trgm_idx"   ON "counterparties" USING GIN ("email" gin_trgm_ops);
CREATE INDEX "counterparties_tax_trgm_idx"     ON "counterparties" USING GIN ("taxNumber" gin_trgm_ops);

CREATE INDEX "accounts_code_trgm_idx"    ON "accounts" USING GIN ("code" gin_trgm_ops);
CREATE INDEX "accounts_name_ar_trgm_idx" ON "accounts" USING GIN ("nameAr" gin_trgm_ops);
CREATE INDEX "accounts_name_en_trgm_idx" ON "accounts" USING GIN ("nameEn" gin_trgm_ops);

CREATE INDEX "documents_number_trgm_idx" ON "documents" USING GIN ("documentNumber" gin_trgm_ops);
CREATE INDEX "employees_number_trgm_idx" ON "employees" USING GIN ("employeeNumber" gin_trgm_ops);
CREATE INDEX "employees_name_ar_trgm_idx" ON "employees" USING GIN ("fullNameAr" gin_trgm_ops);
CREATE INDEX "employees_name_en_trgm_idx" ON "employees" USING GIN ("fullNameEn" gin_trgm_ops);

-- Ranked full-text search. `simple` is deliberate: Arabic has no bundled stemmer
-- in stock PostgreSQL, and stemming English-only would skew bilingual ranking.
ALTER TABLE "products" ADD COLUMN "searchVector" tsvector
    GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', coalesce("sku", '')),    'A') ||
        setweight(to_tsvector('simple', coalesce("nameAr", '')), 'B') ||
        setweight(to_tsvector('simple', coalesce("nameEn", '')), 'B') ||
        setweight(to_tsvector('simple', coalesce("description", '')), 'D')
    ) STORED;

CREATE INDEX "products_search_vector_idx" ON "products" USING GIN ("searchVector");

ALTER TABLE "counterparties" ADD COLUMN "searchVector" tsvector
    GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', coalesce("code", '')),   'A') ||
        setweight(to_tsvector('simple', coalesce("nameAr", '')), 'B') ||
        setweight(to_tsvector('simple', coalesce("nameEn", '')), 'B') ||
        setweight(to_tsvector('simple', coalesce("email", '')),  'C') ||
        setweight(to_tsvector('simple', coalesce("phone", '')),  'C') ||
        setweight(to_tsvector('simple', coalesce("taxNumber", '')), 'C')
    ) STORED;

CREATE INDEX "counterparties_search_vector_idx" ON "counterparties" USING GIN ("searchVector");

-- Covering indexes for the hot list screens (server-side pagination + sort).
CREATE INDEX "documents_list_covering_idx"
    ON "documents" ("tenantId", "type", "issueDate" DESC)
    INCLUDE ("documentNumber", "status", "total", "paidAmount", "counterpartyId");

CREATE INDEX "stock_levels_low_stock_idx"
    ON "stock_levels" ("tenantId", "productId")
    WHERE "quantityOnHand" <= 0;

CREATE INDEX "documents_outstanding_idx"
    ON "documents" ("tenantId", "counterpartyId", "dueDate")
    WHERE "status" IN ('POSTED', 'PARTIAL_PAID');

-- Expired / expiring batches feed the quarantine report without a table scan.
CREATE INDEX "cost_layers_expiring_idx"
    ON "cost_layers" ("tenantId", "expiryDate")
    WHERE "remainingQuantity" > 0 AND "expiryDate" IS NOT NULL;

-- The outbox dispatcher only ever looks at unprocessed, live events.
CREATE INDEX "outbox_events_pending_idx"
    ON "outbox_events" ("occurredAt")
    WHERE "processedAt" IS NULL AND NOT "deadLettered";

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 6 — NULL-aware uniqueness.
--
-- PostgreSQL treats NULLs as distinct, so Prisma's `@@unique` on nullable
-- columns does not actually prevent duplicates. These partial indexes close
-- the gap for every combination of NULL scoping columns.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX "account_mappings_tenant_key_global_key"
    ON "account_mappings" ("tenantId", "key")
    WHERE "branchId" IS NULL AND "categoryId" IS NULL;

CREATE UNIQUE INDEX "account_mappings_tenant_key_branch_key"
    ON "account_mappings" ("tenantId", "key", "branchId")
    WHERE "branchId" IS NOT NULL AND "categoryId" IS NULL;

CREATE UNIQUE INDEX "account_mappings_tenant_key_category_key"
    ON "account_mappings" ("tenantId", "key", "categoryId")
    WHERE "branchId" IS NULL AND "categoryId" IS NOT NULL;

-- A serial number can only be on hand in one place at one time.
CREATE UNIQUE INDEX "cost_layers_serial_unique_idx"
    ON "cost_layers" ("tenantId", "productId", "batchNumber")
    WHERE "remainingQuantity" > 0 AND "batchNumber" IS NOT NULL;

-- Only one open approval request per entity.
CREATE UNIQUE INDEX "approval_requests_open_unique_idx"
    ON "approval_requests" ("tenantId", "entityType", "entityId")
    WHERE "status" = 'PENDING';

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 7 — Gap-free sequential numbering.
--
-- The counter row is locked FOR UPDATE, so concurrent callers serialise and no
-- two documents can ever receive the same number. Numbers are consumed, never
-- returned: deleting a draft leaves a permanent gap, which is exactly what an
-- auditor expects to see.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION erp_next_document_number(
    p_tenant_id UUID,
    p_key       TEXT,
    p_year      INT,
    p_prefix    TEXT DEFAULT NULL,
    p_padding   INT  DEFAULT 5
)
RETURNS TEXT AS $$
DECLARE
    v_next    BIGINT;
    v_prefix  TEXT;
    v_padding INT;
BEGIN
    INSERT INTO "number_sequences" ("id", "tenantId", "key", "year", "prefix", "padding", "nextValue", "updatedAt")
    VALUES (uuid_generate_v4(), p_tenant_id, p_key, p_year, COALESCE(p_prefix, p_key), p_padding, 1, now())
    ON CONFLICT ("tenantId", "key", "year") DO NOTHING;

    UPDATE "number_sequences"
       SET "nextValue" = "nextValue" + 1,
           "updatedAt" = now()
     WHERE "tenantId" = p_tenant_id AND "key" = p_key AND "year" = p_year
    RETURNING "nextValue" - 1, "prefix", "padding" INTO v_next, v_prefix, v_padding;

    RETURN format('%s-%s-%s', v_prefix, p_year, lpad(v_next::TEXT, v_padding, '0'));
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION erp_next_document_number(UUID, TEXT, INT, TEXT, INT) IS
    'Atomically allocates the next number in a per-tenant, per-year series. Never reuses a number.';

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 8 — Row Level Security scaffolding.
--
-- Policies are installed and RLS is enabled now, so that pointing the
-- application at a non-owner role is a one-line deployment change rather than a
-- migration. While `erp.tenant_id` is unset the policy is permissive, which
-- keeps migrations, seeding and back-office tooling working unchanged.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION erp_current_tenant()
RETURNS UUID AS $$
    SELECT NULLIF(current_setting('erp.tenant_id', true), '')::UUID;
$$ LANGUAGE sql STABLE;

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
        EXECUTE format($p$
            CREATE POLICY %I ON %I
            USING (erp_current_tenant() IS NULL OR "tenantId" = erp_current_tenant())
            WITH CHECK (erp_current_tenant() IS NULL OR "tenantId" = erp_current_tenant())
        $p$, t || '_tenant_isolation', t);
    END LOOP;
END;
$$;
