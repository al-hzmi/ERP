-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 006 — Idempotent request replay.
--
-- Offline mode queues a submission and replays it when the connection returns, which
-- introduces a failure mode this system cannot tolerate: a `POST /api/sales/invoices`
-- delivered twice creates two invoices, each consuming a document number and each
-- posting to the ledger. The request that was actually delivered and whose *response*
-- was lost is indistinguishable, from the client, from one that never arrived.
--
-- So a replayable request carries a client-generated key, and the first outcome under
-- that key is recorded here and returned verbatim for every repeat. That makes a retry
-- safe in all three cases: never arrived, arrived once, arrived twice.
--
-- Why a table rather than a natural uniqueness constraint on the documents themselves:
-- there is no field that distinguishes two legitimately identical invoices raised for
-- the same customer on the same day for the same amount from one invoice sent twice.
-- Only the client knows, and the key is how it says so.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE "request_idempotency" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    -- Client-generated. Scoped per tenant, not globally: two tenants generating the
    -- same uuid is not a collision worth coupling them over.
    "key" VARCHAR(64) NOT NULL,
    "userId" UUID NOT NULL,
    -- The route the key was first used against. A key replayed against a *different*
    -- endpoint is a client bug, and answering it with the stored response would be
    -- worse than refusing it.
    "endpoint" VARCHAR(128) NOT NULL,
    -- SHA-256 of the canonical request body. A key reused with different content is
    -- the same class of bug, and it is the one that would silently return the wrong
    -- document's number.
    "requestHash" CHAR(64) NOT NULL,
    "httpStatus" INTEGER NOT NULL,
    "responseBody" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "request_idempotency_pkey" PRIMARY KEY ("id")
);

COMMENT ON TABLE "request_idempotency" IS
    'First outcome of each client-keyed mutation, replayed verbatim for repeats so an '
    'offline queue cannot duplicate a financial record.';

-- The constraint that does the work. A second insert under the same key fails here
-- rather than being decided by application code that raced with itself.
CREATE UNIQUE INDEX "request_idempotency_tenant_key_idx"
    ON "request_idempotency" ("tenantId", "key");

-- Sweeping is by age.
CREATE INDEX "request_idempotency_createdAt_idx"
    ON "request_idempotency" ("createdAt");

CREATE INDEX "request_idempotency_tenantId_userId_idx"
    ON "request_idempotency" ("tenantId", "userId");

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "request_idempotency" TO erp_app;

-- ── Row-level security ───────────────────────────────────────────────────────
--
-- This table carries a `tenantId`, so it joins the fail-closed policy set rather than
-- sitting outside it like `rate_limit_counters` does. The distinction is when each is
-- consulted: the rate limiter runs before authentication, with no tenant bound; an
-- idempotency check runs inside a request that has already resolved its tenant.
--
-- The client extension derives which models to warn about from the presence of a
-- `tenantId` column, and `tenant-isolation-as-app-role.test.ts` asserts that every such
-- model has a policy — so omitting this would fail that test, by design.

ALTER TABLE "request_idempotency" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "request_idempotency_tenant_isolation" ON "request_idempotency";

CREATE POLICY "request_idempotency_tenant_isolation" ON "request_idempotency"
    FOR ALL
    TO erp_app
    USING ("tenantId" = erp_current_tenant())
    WITH CHECK ("tenantId" = erp_current_tenant());

ALTER TABLE "request_idempotency"
    ADD CONSTRAINT "request_idempotency_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Sweeping ─────────────────────────────────────────────────────────────────
--
-- A key only needs to outlive the window in which a client might retry under it. Days,
-- not years — and the table would otherwise grow by one row per mutation forever.
--
-- Swept by the outbox worker, which is already the deployment's scheduled process.

CREATE OR REPLACE FUNCTION erp_idempotency_sweep(p_older_than_seconds INT)
RETURNS INT
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
    v_deleted INT;
BEGIN
    DELETE FROM "request_idempotency"
     WHERE "createdAt" < clock_timestamp() - make_interval(secs => p_older_than_seconds);

    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$;

COMMENT ON FUNCTION erp_idempotency_sweep(INT) IS
    'Discards idempotency records older than the retry window.';

-- ── Proof the policy is in place ─────────────────────────────────────────────
--
-- The one thing here that would fail silently: a table with a `tenantId` and no policy
-- reads across tenants under `erp_app` and nothing complains at deploy time.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname = 'public'
           AND tablename = 'request_idempotency'
           AND policyname = 'request_idempotency_tenant_isolation'
    ) THEN
        RAISE EXCEPTION 'request_idempotency has a tenantId and no isolation policy';
    END IF;
END;
$$;
