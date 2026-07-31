-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 016 — ZATCA Phase 2: device credentials, invoice counter, submission state.
--
-- ## What already existed
--
-- `zatca_invoices` has produced UBL 2.1 XML, a SHA-256 invoice hash chained to the previous
-- invoice, and a Base64 TLV QR (tags 1–6) since migration 1. The seed generates 200 of them and
-- verifies the chain. None of that is rebuilt here.
--
-- What was missing is everything that makes those artefacts *submittable*: the cryptographic
-- stamp identity issued by ZATCA to a specific device, the invoice counter the signature
-- covers, and the state machine tracking what has actually been sent.
--
-- ## The private key is encrypted at rest, and that is not optional
--
-- `privateKeyEnc` holds an AES-256-GCM ciphertext produced by `encryptField`, the same
-- envelope the schema already uses for IBANs and national IDs. A CSID private key is the
-- taxpayer's cryptographic identity: anyone holding it can sign invoices that ZATCA will
-- attribute to them. Storing it as plaintext in a column that appears in every `SELECT *`,
-- every backup and every replica is not a risk worth taking for the convenience.
--
-- The column is named with the `Enc` suffix that the field-level protection list keys on, so
-- it inherits the existing rule rather than needing a new one.
--
-- ## ICV is per tenant and gap-free, like a document number
--
-- The Invoice Counter Value is a monotonic sequence the signature commits to. ZATCA uses it
-- to detect a suppressed invoice: a gap means one was issued and hidden. It therefore cannot
-- be `count(*) + 1` — a concurrent pair would both read the same count — so it is allocated
-- from `number_sequences` through `erp_next_document_number`, which already holds a row lock
-- for exactly this reason and is already gap-free.
--
-- ## Status is on `zatca_invoices`, not on `documents`
--
-- It was asked for on the invoice. It belongs on the e-invoice record: a document that is not
-- an e-invoice at all (a purchase invoice, a debit note to a supplier) would carry a
-- meaningless status column, and `documents` is the partitioned table every posting path
-- writes — widening it costs on the hot path for a field only the ZATCA screen reads.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ZatcaEnvironment') THEN
        -- ZATCA runs three tiers. `SIMULATION` is not a nicety: onboarding requires passing
        -- the compliance checks there before production credentials are issued, and a config
        -- that cannot express it forces the taxpayer to edit the database mid-onboarding.
        CREATE TYPE "ZatcaEnvironment" AS ENUM ('SANDBOX', 'SIMULATION', 'PRODUCTION');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ZatcaSubmissionStatus') THEN
        CREATE TYPE "ZatcaSubmissionStatus" AS ENUM (
            -- Generated and signed, not yet sent.
            'PENDING',
            -- Simplified (B2C): reported after issue. ZATCA accepted it.
            'REPORTED',
            -- Standard (B2B): cleared before issue. ZATCA returned the stamped invoice.
            'CLEARED',
            -- Accepted with warnings. Distinct from CLEARED because the warnings must be
            -- read and fixed, and folding them into success guarantees nobody ever will.
            'ACCEPTED_WITH_WARNINGS',
            'FAILED'
        );
    END IF;
END;
$$;

-- ── Device credentials ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "zatca_configs" (
    "id"               UUID NOT NULL DEFAULT uuid_generate_v4(),
    "tenantId"         UUID NOT NULL,
    "environment"      "ZatcaEnvironment" NOT NULL DEFAULT 'SANDBOX',
    -- The taxpayer's 15-digit VAT registration. Kept here rather than read from an env var so
    -- one deployment can serve several taxpayers, which is the whole point of the tenant.
    "sellerVatNumber"  VARCHAR(15) NOT NULL,
    "sellerNameAr"     VARCHAR(256) NOT NULL,
    "commercialRegNo"  VARCHAR(32),
    -- Address fields ZATCA requires on a STANDARD invoice. Nullable because a tenant can
    -- configure the identity before the address, and a half-filled config is more useful than
    -- a refused one.
    "streetName"       VARCHAR(128),
    "buildingNumber"   VARCHAR(8),
    "citySubdivision"  VARCHAR(128),
    "cityName"         VARCHAR(128),
    "postalZone"       VARCHAR(8),
    -- ── Cryptographic stamp identity ─────────────────────────────────────────
    -- The CSID returned by ZATCA onboarding: a Base64 X.509 certificate and the secret that
    -- authenticates subsequent API calls.
    "csidCertificate"  TEXT,
    "csidSecretEnc"    TEXT,
    -- The EC private key (P-256) whose public half is in the certificate. AES-256-GCM at rest
    -- via `encryptField` — the same envelope as IBANs and national IDs. Anyone holding this
    -- can sign invoices ZATCA will attribute to this taxpayer.
    "privateKeyEnc"    TEXT,
    -- The compliance CSID used during onboarding, before production credentials are issued.
    "complianceCertificate" TEXT,
    "complianceSecretEnc"   TEXT,
    "onboardedAt"      TIMESTAMPTZ(6),
    "isActive"         BOOLEAN NOT NULL DEFAULT false,
    "createdAt"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updatedAt"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "zatca_configs_pkey" PRIMARY KEY ("id")
);

-- One config per tenant. Two would be two cryptographic identities for one taxpayer, and
-- whichever the query returned first would sign the invoice.
CREATE UNIQUE INDEX IF NOT EXISTS "zatca_configs_tenantId_key" ON "zatca_configs" ("tenantId");

ALTER TABLE "zatca_configs"
    DROP CONSTRAINT IF EXISTS "zatca_configs_tenantId_fkey";
ALTER TABLE "zatca_configs"
    ADD CONSTRAINT "zatca_configs_tenantId_fkey" FOREIGN KEY ("tenantId")
        REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "zatca_configs"
    DROP CONSTRAINT IF EXISTS "zatca_configs_vat_number_shape",
    DROP CONSTRAINT IF EXISTS "zatca_configs_active_requires_credentials";

-- ZATCA's VAT number format: 15 digits, starting and ending with 3. A malformed one is
-- rejected by the API after the invoice is already in the customer's hands.
ALTER TABLE "zatca_configs"
    ADD CONSTRAINT "zatca_configs_vat_number_shape"
        CHECK ("sellerVatNumber" ~ '^3[0-9]{13}3$'),
    -- Activation is the switch that starts signing real invoices. Without a key and a
    -- certificate that produces unsigned XML that ZATCA rejects — after the invoice has been
    -- issued to the customer, which is the expensive moment to find out.
    ADD CONSTRAINT "zatca_configs_active_requires_credentials"
        CHECK (
            NOT "isActive"
         OR ("privateKeyEnc" IS NOT NULL AND "csidCertificate" IS NOT NULL)
        );

ALTER TABLE "zatca_configs" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "zatca_configs_tenant_isolation" ON "zatca_configs";
CREATE POLICY "zatca_configs_tenant_isolation" ON "zatca_configs"
    FOR ALL TO erp_app
    USING ("tenantId" = erp_current_tenant())
    WITH CHECK ("tenantId" = erp_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON "zatca_configs" TO erp_app;

-- ── Submission state on the e-invoice ────────────────────────────────────────

ALTER TABLE "zatca_invoices"
    ADD COLUMN IF NOT EXISTS "icv"            BIGINT,
    ADD COLUMN IF NOT EXISTS "status"         "ZatcaSubmissionStatus" NOT NULL DEFAULT 'PENDING',
    -- The ECDSA P-256 signature over the canonical XML digest, Base64. QR tag 7.
    ADD COLUMN IF NOT EXISTS "signature"      TEXT,
    -- The signing certificate's public key and its issuer signature. QR tags 8 and 9.
    ADD COLUMN IF NOT EXISTS "publicKey"      TEXT,
    ADD COLUMN IF NOT EXISTS "certSignature"  TEXT,
    -- What ZATCA said. Kept verbatim: a rejection lists the exact rule that failed, and
    -- paraphrasing it into a status code loses the only thing that helps fix it.
    ADD COLUMN IF NOT EXISTS "responseJson"   JSONB,
    ADD COLUMN IF NOT EXISTS "warningCount"   INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "lastAttemptAt"  TIMESTAMPTZ(6),
    ADD COLUMN IF NOT EXISTS "attemptCount"   INTEGER NOT NULL DEFAULT 0;

-- Backfill before the unique index: existing rows predate the counter. Ordered by issue time
-- so the counter reflects the order they were actually issued in, not the order the update
-- happened to visit them.
UPDATE "zatca_invoices" z
   SET "icv" = numbered.rn
  FROM (
    SELECT "id", row_number() OVER (PARTITION BY "tenantId" ORDER BY "issuedAtUtc", "id") AS rn
      FROM "zatca_invoices"
  ) numbered
 WHERE z."id" = numbered."id" AND z."icv" IS NULL;

ALTER TABLE "zatca_invoices" ALTER COLUMN "icv" SET NOT NULL;

-- The counter is what ZATCA uses to detect a suppressed invoice: a gap means one was issued
-- and hidden. Unique per tenant, so a duplicate is refused rather than silently accepted.
CREATE UNIQUE INDEX IF NOT EXISTS "zatca_invoices_tenantId_icv_key"
    ON "zatca_invoices" ("tenantId", "icv");

-- The submission worker's query: what still needs sending, oldest first.
CREATE INDEX IF NOT EXISTS "zatca_invoices_pending_idx"
    ON "zatca_invoices" ("tenantId", "issuedAtUtc")
    WHERE "status" IN ('PENDING', 'FAILED');

ALTER TABLE "zatca_invoices"
    DROP CONSTRAINT IF EXISTS "zatca_invoices_icv_positive",
    DROP CONSTRAINT IF EXISTS "zatca_invoices_terminal_has_response";

ALTER TABLE "zatca_invoices"
    ADD CONSTRAINT "zatca_invoices_icv_positive" CHECK ("icv" > 0),
    -- A submitted invoice has an answer. A status of CLEARED with no response body is a claim
    -- nobody can audit — and clearance is precisely the thing an auditor asks to see.
    ADD CONSTRAINT "zatca_invoices_terminal_has_response"
        CHECK (
            "status" = 'PENDING'
         OR ("responseJson" IS NOT NULL AND "lastAttemptAt" IS NOT NULL)
        );

-- ── Proof ────────────────────────────────────────────────────────────────────

DO $$
DECLARE
    v_missing TEXT[] := ARRAY[]::TEXT[];
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'zatca_configs' AND c.relrowsecurity
    ) THEN
        v_missing := v_missing || 'RLS disabled on zatca_configs';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'zatca_configs'
           AND policyname = 'zatca_configs_tenant_isolation'
           AND qual LIKE '%erp_current_tenant%' AND with_check LIKE '%erp_current_tenant%'
    ) THEN
        v_missing := v_missing || 'policy absent or incomplete on zatca_configs';
    END IF;

    -- The private key must never be a plain column somebody can widen later without noticing.
    -- The `Enc` suffix is what the field-protection list keys on.
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'zatca_configs' AND column_name = 'privateKeyEnc'
    ) THEN
        v_missing := v_missing || 'the private key column is not the encrypted one';
    END IF;

    IF EXISTS (SELECT 1 FROM "zatca_invoices" WHERE "icv" IS NULL) THEN
        v_missing := v_missing || 'an e-invoice has no counter value after backfill';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes WHERE indexname = 'zatca_invoices_tenantId_icv_key'
    ) THEN
        v_missing := v_missing || 'the counter is not unique per tenant';
    END IF;

    IF array_length(v_missing, 1) > 0 THEN
        RAISE EXCEPTION 'Migration 016 incomplete — %', array_to_string(v_missing, '; ');
    END IF;
END;
$$;
