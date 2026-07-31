-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 011 — Commercial documents, price lists, payment terms, assembly orders.
--
-- Four groups of tables for the screens that had no storage behind them at all. Everything
-- else in this release — the fiscal calendar, currencies and rates, posting rules, and six
-- reports — reads tables that already existed and needs no migration.
--
-- ## Why `trade_documents` and not four more values on `DocumentType`
--
-- Quotations, sales orders, purchase orders and sales returns are commercial paperwork. They
-- are not accounting documents: none of them moves the ledger, and a quotation that expires
-- unaccepted leaves no trace in the books because nothing happened.
--
-- `documents` is the accounting table. It carries the ZATCA hash chain, the posting trigger,
-- the paid/allocated invariants and the partition scheme, and every row in it is expected to
-- become a journal. Adding `QUOTATION` to `DocumentType` would put rows in that table that
-- must never post, and every one of those invariants would then need a "unless it is a
-- quotation" clause. That is how a well-constrained table becomes an unconstrained one.
--
-- So these live apart, in a table whose rules are their own: a status, a counterparty, some
-- lines, and totals that are a convenience rather than a control.
--
-- ## What these tables deliberately do not do
--
-- **They do not post.** Confirming a sales order does not reserve stock, raise a receivable,
-- or touch a journal. Completing an assembly order does not consume its components or produce
-- its output. The conversion paths (quotation → order → invoice, assembly → stock movements)
-- are not built, and nothing here pretends they are: the screens record and track documents.
--
-- **Price lists are not consulted at invoicing.** The invoice screen reads the product's
-- `salePrice`, exactly as it did before this migration. A price list here is a maintained
-- catalogue, not a pricing engine — wiring it into invoicing changes what an invoice costs,
-- which is a decision about the business rather than about the schema.
--
-- **Payment terms do not compute due dates.** `documents.dueDate` is still whatever the
-- invoice screen sets. Attaching a term to a counterparty and deriving the date from it is a
-- one-line change in the invoice path, and it is not made here because it silently alters
-- ageing for every existing customer.
--
-- Each of those is a seam, not a gap that was overlooked. Saying so in the schema is cheaper
-- than someone discovering it from a report that does not add up.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Enum types ───────────────────────────────────────────────────────────────
--
-- Native PostgreSQL enums, not TEXT with a CHECK. Prisma maps a schema enum to a type and its
-- client casts to it by name, so a TEXT column type-checks in the schema and then fails at
-- runtime with `type "public"."X" does not exist`. Migration 010 learned this the hard way.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TradeDocumentType') THEN
        CREATE TYPE "TradeDocumentType" AS ENUM (
            'QUOTATION', 'SALES_ORDER', 'PURCHASE_ORDER', 'SALES_RETURN'
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TradeDocumentStatus') THEN
        CREATE TYPE "TradeDocumentStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'COMPLETED', 'CANCELLED');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AssemblyStatus') THEN
        CREATE TYPE "AssemblyStatus" AS ENUM ('DRAFT', 'COMPLETED', 'CANCELLED');
    END IF;
END;
$$;

-- ── Payment terms ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "payment_terms" (
    "id"              UUID NOT NULL DEFAULT uuid_generate_v4(),
    "tenantId"        UUID NOT NULL,
    "code"            VARCHAR(32) NOT NULL,
    "nameAr"          VARCHAR(128) NOT NULL,
    "nameEn"          VARCHAR(128) NOT NULL,
    -- Days from invoice date to the due date. Zero is cash on delivery, which is a term.
    "netDays"         INTEGER NOT NULL DEFAULT 0,
    -- The early-settlement offer: pay within `discountDays` and take `discountPercent` off.
    -- Both or neither — a discount with no deadline is a permanent price cut by another name.
    "discountDays"    INTEGER,
    "discountPercent" DECIMAL(9,4),
    "isActive"        BOOLEAN NOT NULL DEFAULT true,
    "createdAt"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "payment_terms_pkey" PRIMARY KEY ("id")
);

-- ── Price lists ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "price_lists" (
    "id"          UUID NOT NULL DEFAULT uuid_generate_v4(),
    "tenantId"    UUID NOT NULL,
    "code"        VARCHAR(32) NOT NULL,
    "nameAr"      VARCHAR(128) NOT NULL,
    "nameEn"      VARCHAR(128) NOT NULL,
    "currency"    CHAR(3) NOT NULL,
    "validFrom"   DATE NOT NULL,
    -- NULL means open-ended, which is the common case for a standard list.
    "validTo"     DATE,
    "isActive"    BOOLEAN NOT NULL DEFAULT true,
    "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "price_lists_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "price_list_lines" (
    "id"          UUID NOT NULL DEFAULT uuid_generate_v4(),
    "tenantId"    UUID NOT NULL,
    "priceListId" UUID NOT NULL,
    "productId"   UUID NOT NULL,
    "unitPrice"   DECIMAL(19,4) NOT NULL,
    -- A quantity break: this price applies from this quantity upward. 1 is the base tier.
    "minQuantity" DECIMAL(19,4) NOT NULL DEFAULT 1,

    CONSTRAINT "price_list_lines_pkey" PRIMARY KEY ("id")
);

-- ── Commercial documents ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "trade_documents" (
    "id"             UUID NOT NULL DEFAULT uuid_generate_v4(),
    "tenantId"       UUID NOT NULL,
    "type"           "TradeDocumentType" NOT NULL,
    "status"         "TradeDocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "documentNumber" VARCHAR(32) NOT NULL,
    "counterpartyId" UUID NOT NULL,
    "branchId"       UUID NOT NULL,
    "documentDate"   DATE NOT NULL,
    -- A quotation's validity, an order's promised delivery. One column because it is the same
    -- question — "by when" — and two would be null in each other's rows.
    "expectedDate"   DATE,
    "currency"       CHAR(3) NOT NULL,
    -- Totals are derived from the lines and stored for the register, which would otherwise
    -- aggregate every line of every document to draw one page. A trigger keeps them honest.
    "subtotal"       DECIMAL(19,4) NOT NULL DEFAULT 0,
    "taxAmount"      DECIMAL(19,4) NOT NULL DEFAULT 0,
    "totalAmount"    DECIMAL(19,4) NOT NULL DEFAULT 0,
    "notes"          VARCHAR(1024),
    "createdById"    UUID NOT NULL,
    "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updatedAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "trade_documents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "trade_document_lines" (
    "id"          UUID NOT NULL DEFAULT uuid_generate_v4(),
    "tenantId"    UUID NOT NULL,
    "documentId"  UUID NOT NULL,
    "lineNumber"  INTEGER NOT NULL,
    "productId"   UUID NOT NULL,
    "description" VARCHAR(512),
    "quantity"    DECIMAL(19,4) NOT NULL,
    "unitPrice"   DECIMAL(19,4) NOT NULL,
    "discountPercent" DECIMAL(9,4) NOT NULL DEFAULT 0,
    "taxRate"     DECIMAL(9,4) NOT NULL DEFAULT 0,
    "lineTotal"   DECIMAL(19,4) NOT NULL DEFAULT 0,

    CONSTRAINT "trade_document_lines_pkey" PRIMARY KEY ("id")
);

-- ── Assembly orders ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "assembly_orders" (
    "id"            UUID NOT NULL DEFAULT uuid_generate_v4(),
    "tenantId"      UUID NOT NULL,
    "orderNumber"   VARCHAR(32) NOT NULL,
    "status"        "AssemblyStatus" NOT NULL DEFAULT 'DRAFT',
    -- What is being built, and how many of it.
    "productId"     UUID NOT NULL,
    "quantity"      DECIMAL(19,4) NOT NULL,
    "warehouseId"   UUID NOT NULL,
    "branchId"      UUID NOT NULL,
    "orderDate"     DATE NOT NULL,
    "notes"         VARCHAR(1024),
    "createdById"   UUID NOT NULL,
    "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "completedAt"   TIMESTAMPTZ(6),

    CONSTRAINT "assembly_orders_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "assembly_order_lines" (
    "id"                UUID NOT NULL DEFAULT uuid_generate_v4(),
    "tenantId"          UUID NOT NULL,
    "assemblyOrderId"   UUID NOT NULL,
    "productId"         UUID NOT NULL,
    -- How many of this component go into ONE of the output product. The total consumed is
    -- this times the order quantity, computed where it is read rather than stored twice.
    "quantityPerUnit"   DECIMAL(19,4) NOT NULL,

    CONSTRAINT "assembly_order_lines_pkey" PRIMARY KEY ("id")
);

-- ── Keys and indexes ─────────────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS "payment_terms_tenantId_code_key"
    ON "payment_terms" ("tenantId", "code");

CREATE UNIQUE INDEX IF NOT EXISTS "price_lists_tenantId_code_key"
    ON "price_lists" ("tenantId", "code");

-- One price per product per quantity tier. Two rows for the same tier is an ambiguity the
-- reader has to resolve by guessing.
CREATE UNIQUE INDEX IF NOT EXISTS "price_list_lines_listId_productId_minQuantity_key"
    ON "price_list_lines" ("priceListId", "productId", "minQuantity");

CREATE UNIQUE INDEX IF NOT EXISTS "trade_documents_tenantId_documentNumber_key"
    ON "trade_documents" ("tenantId", "documentNumber");

-- The register's query: one type, newest first.
CREATE INDEX IF NOT EXISTS "trade_documents_tenantId_type_documentDate_idx"
    ON "trade_documents" ("tenantId", "type", "documentDate" DESC);

CREATE INDEX IF NOT EXISTS "trade_documents_tenantId_counterpartyId_idx"
    ON "trade_documents" ("tenantId", "counterpartyId");

CREATE UNIQUE INDEX IF NOT EXISTS "trade_document_lines_documentId_lineNumber_key"
    ON "trade_document_lines" ("documentId", "lineNumber");

CREATE UNIQUE INDEX IF NOT EXISTS "assembly_orders_tenantId_orderNumber_key"
    ON "assembly_orders" ("tenantId", "orderNumber");

CREATE INDEX IF NOT EXISTS "assembly_orders_tenantId_status_idx"
    ON "assembly_orders" ("tenantId", "status");

-- A component appears once per order. Twice would double what the order says it consumes.
CREATE UNIQUE INDEX IF NOT EXISTS "assembly_order_lines_orderId_productId_key"
    ON "assembly_order_lines" ("assemblyOrderId", "productId");

-- Leading with the policy's own predicate, as migration 009 established: the isolation
-- predicate is the one every query carries, so it belongs at the front of an index.
CREATE INDEX IF NOT EXISTS "payment_terms_tenantId_idx"        ON "payment_terms" ("tenantId");
CREATE INDEX IF NOT EXISTS "price_lists_tenantId_idx"          ON "price_lists" ("tenantId");
CREATE INDEX IF NOT EXISTS "price_list_lines_tenantId_idx"     ON "price_list_lines" ("tenantId");
CREATE INDEX IF NOT EXISTS "trade_documents_tenantId_idx"      ON "trade_documents" ("tenantId");
CREATE INDEX IF NOT EXISTS "trade_document_lines_tenantId_idx" ON "trade_document_lines" ("tenantId");
CREATE INDEX IF NOT EXISTS "assembly_orders_tenantId_idx"      ON "assembly_orders" ("tenantId");
CREATE INDEX IF NOT EXISTS "assembly_order_lines_tenantId_idx" ON "assembly_order_lines" ("tenantId");

CREATE INDEX IF NOT EXISTS "price_list_lines_tenantId_priceListId_idx"
    ON "price_list_lines" ("tenantId", "priceListId");
CREATE INDEX IF NOT EXISTS "trade_document_lines_tenantId_documentId_idx"
    ON "trade_document_lines" ("tenantId", "documentId");
CREATE INDEX IF NOT EXISTS "assembly_order_lines_tenantId_orderId_idx"
    ON "assembly_order_lines" ("tenantId", "assemblyOrderId");

-- ── Foreign keys ─────────────────────────────────────────────────────────────

ALTER TABLE "payment_terms"
    DROP CONSTRAINT IF EXISTS "payment_terms_tenantId_fkey";
ALTER TABLE "payment_terms"
    ADD CONSTRAINT "payment_terms_tenantId_fkey" FOREIGN KEY ("tenantId")
        REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "price_lists"
    DROP CONSTRAINT IF EXISTS "price_lists_tenantId_fkey";
ALTER TABLE "price_lists"
    ADD CONSTRAINT "price_lists_tenantId_fkey" FOREIGN KEY ("tenantId")
        REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "price_list_lines"
    DROP CONSTRAINT IF EXISTS "price_list_lines_tenantId_fkey",
    DROP CONSTRAINT IF EXISTS "price_list_lines_priceListId_fkey",
    DROP CONSTRAINT IF EXISTS "price_list_lines_productId_fkey";
ALTER TABLE "price_list_lines"
    ADD CONSTRAINT "price_list_lines_tenantId_fkey" FOREIGN KEY ("tenantId")
        REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Cascade: a list's lines are the list. Deleting the header and orphaning the prices
    -- would leave rows nothing can reach and nothing will ever clean up.
    ADD CONSTRAINT "price_list_lines_priceListId_fkey" FOREIGN KEY ("priceListId")
        REFERENCES "price_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "price_list_lines_productId_fkey" FOREIGN KEY ("productId")
        REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "trade_documents"
    DROP CONSTRAINT IF EXISTS "trade_documents_tenantId_fkey",
    DROP CONSTRAINT IF EXISTS "trade_documents_counterpartyId_fkey",
    DROP CONSTRAINT IF EXISTS "trade_documents_branchId_fkey";
ALTER TABLE "trade_documents"
    ADD CONSTRAINT "trade_documents_tenantId_fkey" FOREIGN KEY ("tenantId")
        REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "trade_documents_counterpartyId_fkey" FOREIGN KEY ("counterpartyId")
        REFERENCES "counterparties"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "trade_documents_branchId_fkey" FOREIGN KEY ("branchId")
        REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "trade_document_lines"
    DROP CONSTRAINT IF EXISTS "trade_document_lines_tenantId_fkey",
    DROP CONSTRAINT IF EXISTS "trade_document_lines_documentId_fkey",
    DROP CONSTRAINT IF EXISTS "trade_document_lines_productId_fkey";
ALTER TABLE "trade_document_lines"
    ADD CONSTRAINT "trade_document_lines_tenantId_fkey" FOREIGN KEY ("tenantId")
        REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "trade_document_lines_documentId_fkey" FOREIGN KEY ("documentId")
        REFERENCES "trade_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "trade_document_lines_productId_fkey" FOREIGN KEY ("productId")
        REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "assembly_orders"
    DROP CONSTRAINT IF EXISTS "assembly_orders_tenantId_fkey",
    DROP CONSTRAINT IF EXISTS "assembly_orders_productId_fkey",
    DROP CONSTRAINT IF EXISTS "assembly_orders_warehouseId_fkey",
    DROP CONSTRAINT IF EXISTS "assembly_orders_branchId_fkey";
ALTER TABLE "assembly_orders"
    ADD CONSTRAINT "assembly_orders_tenantId_fkey" FOREIGN KEY ("tenantId")
        REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "assembly_orders_productId_fkey" FOREIGN KEY ("productId")
        REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "assembly_orders_warehouseId_fkey" FOREIGN KEY ("warehouseId")
        REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "assembly_orders_branchId_fkey" FOREIGN KEY ("branchId")
        REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "assembly_order_lines"
    DROP CONSTRAINT IF EXISTS "assembly_order_lines_tenantId_fkey",
    DROP CONSTRAINT IF EXISTS "assembly_order_lines_assemblyOrderId_fkey",
    DROP CONSTRAINT IF EXISTS "assembly_order_lines_productId_fkey";
ALTER TABLE "assembly_order_lines"
    ADD CONSTRAINT "assembly_order_lines_tenantId_fkey" FOREIGN KEY ("tenantId")
        REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "assembly_order_lines_assemblyOrderId_fkey" FOREIGN KEY ("assemblyOrderId")
        REFERENCES "assembly_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "assembly_order_lines_productId_fkey" FOREIGN KEY ("productId")
        REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── CHECK constraints ────────────────────────────────────────────────────────

ALTER TABLE "payment_terms"
    DROP CONSTRAINT IF EXISTS "payment_terms_days_sane",
    DROP CONSTRAINT IF EXISTS "payment_terms_discount_paired";

ALTER TABLE "payment_terms"
    ADD CONSTRAINT "payment_terms_days_sane"
        CHECK ("netDays" >= 0 AND "netDays" <= 3650),
    -- Both columns or neither. A percentage with no deadline is not an early-settlement
    -- discount, it is a price reduction that will be applied to every invoice forever.
    ADD CONSTRAINT "payment_terms_discount_paired"
        CHECK (
            ("discountDays" IS NULL AND "discountPercent" IS NULL)
         OR ("discountDays" IS NOT NULL AND "discountPercent" IS NOT NULL
             AND "discountDays" >= 0 AND "discountDays" <= "netDays"
             AND "discountPercent" > 0 AND "discountPercent" < 100)
        );

ALTER TABLE "price_lists"
    DROP CONSTRAINT IF EXISTS "price_lists_validity_ordered";
ALTER TABLE "price_lists"
    ADD CONSTRAINT "price_lists_validity_ordered"
        CHECK ("validTo" IS NULL OR "validTo" >= "validFrom");

ALTER TABLE "price_list_lines"
    DROP CONSTRAINT IF EXISTS "price_list_lines_amounts_sane";
ALTER TABLE "price_list_lines"
    -- A price of zero is legitimate (a free item bundled with another), a negative one is not.
    ADD CONSTRAINT "price_list_lines_amounts_sane"
        CHECK ("unitPrice" >= 0 AND "minQuantity" > 0);

ALTER TABLE "trade_documents"
    DROP CONSTRAINT IF EXISTS "trade_documents_amounts_sane",
    DROP CONSTRAINT IF EXISTS "trade_documents_dates_ordered";
ALTER TABLE "trade_documents"
    ADD CONSTRAINT "trade_documents_amounts_sane"
        CHECK ("subtotal" >= 0 AND "taxAmount" >= 0 AND "totalAmount" >= 0),
    ADD CONSTRAINT "trade_documents_dates_ordered"
        CHECK ("expectedDate" IS NULL OR "expectedDate" >= "documentDate");

ALTER TABLE "trade_document_lines"
    DROP CONSTRAINT IF EXISTS "trade_document_lines_amounts_sane";
ALTER TABLE "trade_document_lines"
    ADD CONSTRAINT "trade_document_lines_amounts_sane"
        CHECK (
            "quantity" > 0
        AND "unitPrice" >= 0
        AND "discountPercent" >= 0 AND "discountPercent" <= 100
        AND "taxRate" >= 0 AND "taxRate" <= 100
        AND "lineNumber" > 0
        );

ALTER TABLE "assembly_orders"
    DROP CONSTRAINT IF EXISTS "assembly_orders_quantity_positive",
    DROP CONSTRAINT IF EXISTS "assembly_orders_completion_complete";
ALTER TABLE "assembly_orders"
    ADD CONSTRAINT "assembly_orders_quantity_positive"
        CHECK ("quantity" > 0),
    -- Completed is one fact. A COMPLETED order with no `completedAt` cannot be placed in time,
    -- which is the only thing anybody asks of a finished order afterwards.
    ADD CONSTRAINT "assembly_orders_completion_complete"
        CHECK (
            ("status" = 'DRAFT'     AND "completedAt" IS NULL)
         OR ("status" <> 'DRAFT'    AND "completedAt" IS NOT NULL)
        );

ALTER TABLE "assembly_order_lines"
    DROP CONSTRAINT IF EXISTS "assembly_order_lines_quantity_positive";
ALTER TABLE "assembly_order_lines"
    ADD CONSTRAINT "assembly_order_lines_quantity_positive"
        CHECK ("quantityPerUnit" > 0);

-- ── An assembly order cannot be made of itself ───────────────────────────────
--
-- A component list that includes the output product describes an order that consumes what it
-- produces. As a CHECK this is not expressible — it spans two tables — so it is a trigger.

CREATE OR REPLACE FUNCTION erp_assembly_component_not_output()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_output UUID;
BEGIN
    SELECT "productId" INTO v_output FROM "assembly_orders" WHERE "id" = NEW."assemblyOrderId";

    IF v_output = NEW."productId" THEN
        RAISE EXCEPTION 'An assembly order cannot list its own output product as a component'
            USING ERRCODE = 'ERP13';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "trg_assembly_component_not_output" ON "assembly_order_lines";
CREATE TRIGGER "trg_assembly_component_not_output"
    BEFORE INSERT OR UPDATE OF "productId", "assemblyOrderId" ON "assembly_order_lines"
    FOR EACH ROW
    EXECUTE FUNCTION erp_assembly_component_not_output();

-- ── A document that is no longer a draft cannot be re-priced ─────────────────
--
-- A confirmed order is what the customer agreed to. Editing its lines afterwards changes the
-- agreement without a trace, which is exactly the thing a document number exists to prevent.

CREATE OR REPLACE FUNCTION erp_trade_document_line_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_status TEXT;
    v_id     UUID;
BEGIN
    v_id := COALESCE(NEW."documentId", OLD."documentId");
    SELECT "status" INTO v_status FROM "trade_documents" WHERE "id" = v_id;

    -- A document already gone from the table (cascade delete) has no status to object with.
    IF v_status IS NULL THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    IF v_status <> 'DRAFT' THEN
        RAISE EXCEPTION 'Trade document % is % — its lines can no longer be changed', v_id, v_status
            USING ERRCODE = 'ERP13';
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS "trg_trade_document_lines_immutability" ON "trade_document_lines";
CREATE TRIGGER "trg_trade_document_lines_immutability"
    BEFORE INSERT OR UPDATE OR DELETE ON "trade_document_lines"
    FOR EACH ROW
    EXECUTE FUNCTION erp_trade_document_line_immutability();

-- ── The tenant cannot drift from the parent ──────────────────────────────────
--
-- Reusing migration 009's generic guard. Each child's `tenantId` must equal its parent's, so
-- the denormalisation that lets these tables carry a policy of their own cannot become a
-- second source of truth about who owns the row.

DROP TRIGGER IF EXISTS "trg_price_list_lines_tenant" ON "price_list_lines";
CREATE TRIGGER "trg_price_list_lines_tenant"
    BEFORE INSERT OR UPDATE OF "tenantId", "priceListId" ON "price_list_lines"
    FOR EACH ROW
    EXECUTE FUNCTION erp_child_tenant_matches_parent('price_lists', 'priceListId');

DROP TRIGGER IF EXISTS "trg_trade_documents_tenant" ON "trade_documents";
CREATE TRIGGER "trg_trade_documents_tenant"
    BEFORE INSERT OR UPDATE OF "tenantId", "counterpartyId" ON "trade_documents"
    FOR EACH ROW
    EXECUTE FUNCTION erp_child_tenant_matches_parent('counterparties', 'counterpartyId');

DROP TRIGGER IF EXISTS "trg_trade_document_lines_tenant" ON "trade_document_lines";
CREATE TRIGGER "trg_trade_document_lines_tenant"
    BEFORE INSERT OR UPDATE OF "tenantId", "documentId" ON "trade_document_lines"
    FOR EACH ROW
    EXECUTE FUNCTION erp_child_tenant_matches_parent('trade_documents', 'documentId');

DROP TRIGGER IF EXISTS "trg_assembly_orders_tenant" ON "assembly_orders";
CREATE TRIGGER "trg_assembly_orders_tenant"
    BEFORE INSERT OR UPDATE OF "tenantId", "warehouseId" ON "assembly_orders"
    FOR EACH ROW
    EXECUTE FUNCTION erp_child_tenant_matches_parent('warehouses', 'warehouseId');

DROP TRIGGER IF EXISTS "trg_assembly_order_lines_tenant" ON "assembly_order_lines";
CREATE TRIGGER "trg_assembly_order_lines_tenant"
    BEFORE INSERT OR UPDATE OF "tenantId", "assemblyOrderId" ON "assembly_order_lines"
    FOR EACH ROW
    EXECUTE FUNCTION erp_child_tenant_matches_parent('assembly_orders', 'assemblyOrderId');

-- `payment_terms` and `price_lists` are tenant-rooted: their `tenantId` references `tenants`
-- directly and there is no parent it could disagree with, so they need no guard trigger. The
-- proof block below therefore checks them for a policy but not for a trigger.

-- ── Row-level security ───────────────────────────────────────────────────────
--
-- The same fail-closed shape as every other table in the schema. Without these blocks the
-- assertion at the foot of migration 009 fails the next `migrate deploy` and names each table.

DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'payment_terms', 'price_lists', 'price_list_lines',
        'trade_documents', 'trade_document_lines',
        'assembly_orders', 'assembly_order_lines'
    ] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
        EXECUTE format(
            'CREATE POLICY %I ON %I FOR ALL TO erp_app '
            'USING ("tenantId" = erp_current_tenant()) '
            'WITH CHECK ("tenantId" = erp_current_tenant())',
            t || '_tenant_isolation', t
        );
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO erp_app', t);
    END LOOP;
END;
$$;

-- ── Proof ────────────────────────────────────────────────────────────────────

DO $$
DECLARE
    t         TEXT;
    v_missing TEXT[] := ARRAY[]::TEXT[];
    -- The two tenant-rooted tables, which have no parent to drift from.
    rooted    TEXT[] := ARRAY['payment_terms', 'price_lists'];
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'payment_terms', 'price_lists', 'price_list_lines',
        'trade_documents', 'trade_document_lines',
        'assembly_orders', 'assembly_order_lines'
    ] LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
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

        IF NOT (t = ANY (rooted)) AND NOT EXISTS (
            SELECT 1 FROM pg_trigger WHERE tgname = 'trg_' || t || '_tenant' AND NOT tgisinternal
        ) THEN
            v_missing := v_missing || (t || ': tenant guard trigger absent');
        END IF;
    END LOOP;

    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgname = 'trg_assembly_component_not_output' AND NOT tgisinternal
    ) THEN
        v_missing := v_missing || 'an assembly order could be made of itself';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgname = 'trg_trade_document_lines_immutability' AND NOT tgisinternal
    ) THEN
        v_missing := v_missing || 'a confirmed document could be re-priced';
    END IF;

    IF array_length(v_missing, 1) > 0 THEN
        RAISE EXCEPTION 'Migration 011 guards incomplete — %', array_to_string(v_missing, '; ');
    END IF;
END;
$$;
