-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 005 — A schedulable outbox and a rate limit that spans instances.
--
-- Two of the limitations the README stated plainly, now closed.
--
--   1. `drainOutbox()` claimed rows with `FOR UPDATE SKIP LOCKED` in a
--      standalone query. A row lock lives exactly as long as the transaction
--      that took it, and a standalone statement commits the instant it returns —
--      so the lock was released before the first handler ran. Two dispatchers
--      polling the same table would both "claim" the same event and both deliver
--      it. The comment promised concurrency safety the code did not have.
--
--      Holding the transaction open across dispatch would fix the race and
--      introduce a worse problem: handlers do I/O, and a transaction parked on a
--      network call holds its snapshot, its locks and a connection from a pool of
--      twenty. The fix is a claim that outlives the transaction — two columns —
--      so claiming is atomic and short while dispatch is neither.
--
--   2. The rate limiter counted in process memory, so behind N instances the
--      effective limit was N times the configured one. The counter moves into a
--      table, and the sliding-window arithmetic into a function, so every
--      instance decrements the same allowance.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Outbox claims ─────────────────────────────────────────────────────────
--
-- `claimedBy` is diagnostic rather than functional: when a batch is stuck, the
-- question is always *which* worker took it, and a claim that cannot answer that
-- sends an operator to the logs of every instance in turn.

ALTER TABLE "outbox_events"
    ADD COLUMN "claimedAt" TIMESTAMPTZ(6),
    ADD COLUMN "claimedBy" VARCHAR(128);

COMMENT ON COLUMN "outbox_events"."claimedAt" IS
    'When a dispatcher took this row. Non-NULL and recent means in flight; '
    'non-NULL and older than the reclaim horizon means the worker died holding it.';

-- The claim query reads one tenant's pending, *unclaimed* rows in arrival order.
--
-- Leading with `tenantId` because the dispatcher polls per tenant: `outbox_events`
-- is under a fail-closed policy, so a cross-tenant sweep only works while the
-- application still connects as the table owner — a state migration 004 exists to
-- end. The previous partial index led with `occurredAt` and did not know about
-- claims at all, so a worker re-scanned every row already in flight on each poll:
-- at a thousand pending events and a five-second tick, a scan every five seconds,
-- forever.
DROP INDEX IF EXISTS "outbox_events_pending_idx";

CREATE INDEX "outbox_events_claimable_idx"
    ON "outbox_events" ("tenantId", "occurredAt")
    WHERE "processedAt" IS NULL AND NOT "deadLettered" AND "claimedAt" IS NULL;

-- Reclaiming abandoned work scans by claim age within a tenant, and only among
-- rows still in flight. Without this the recovery sweep is the one query that gets
-- slower as the processed history grows.
CREATE INDEX "outbox_events_stale_claim_idx"
    ON "outbox_events" ("tenantId", "claimedAt")
    WHERE "processedAt" IS NULL AND NOT "deadLettered" AND "claimedAt" IS NOT NULL;

-- ── 2. Shared rate-limit counters ────────────────────────────────────────────
--
-- Deliberately NOT tenant-scoped, and therefore deliberately absent from the RLS
-- table list in migration 004. The limiter's whole job is to refuse traffic
-- *before* anyone knows which tenant is asking: the auth bucket is keyed by
-- username and IP at a point in the request where no tenant is bound. A policy
-- requiring `erp.tenant_id` here would make the pre-auth limiter fail closed
-- against itself and turn every sign-in attempt into a refusal.
--
-- There is no tenant identifier to leak in this table. A key is a scope plus an
-- IP or a user id, and a counter is an integer.

CREATE TABLE "rate_limit_counters" (
    -- `scope:identifier`, built by the application. Bounded so a hostile
    -- identifier cannot be used to write unbounded rows.
    "key" VARCHAR(256) NOT NULL,
    "windowStart" TIMESTAMPTZ(6) NOT NULL,
    "hits" INTEGER NOT NULL DEFAULT 0,
    -- Hits in the window immediately before this one, weighted by how much of it
    -- is still in view. This is what makes the window slide: see the function.
    "prevHits" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_limit_counters_pkey" PRIMARY KEY ("key")
);

COMMENT ON TABLE "rate_limit_counters" IS
    'Sliding-window request counters shared by every application instance. '
    'Not tenant-scoped: the limiter runs before authentication.';

-- The sweeper deletes by age.
CREATE INDEX "rate_limit_counters_updatedAt_idx"
    ON "rate_limit_counters" ("updatedAt");

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "rate_limit_counters" TO erp_app;

-- ── 3. The sliding window, in one round trip ─────────────────────────────────
--
-- Two counters per key rather than a timestamp per request. A precise sliding
-- window needs every hit's arrival time, which at the API bucket's 100/minute is
-- a hundred rows per key per minute to insert, scan and delete; the counter form
-- is two integers and one row version.
--
-- The approximation: hits in the previous window are counted in proportion to how
-- much of it still falls inside the trailing window. Ten hits in the previous
-- minute, thirty seconds elapsed in this one, contribute five. It never permits
-- the burst a fixed window does — 2x the limit either side of a boundary, which
-- is the failure this replaces — and it is stateless between calls, so two
-- instances hitting the same key disagree about nothing.
--
-- Why a function and not application SQL: the read, the decision and the
-- increment have to be one atomic unit. Expressed as separate statements from
-- Node, two instances interleave between the check and the increment and both are
-- told they may proceed. `FOR UPDATE` on the key's row is what serialises them,
-- and it only serialises callers contending for the *same* key.

CREATE OR REPLACE FUNCTION erp_rate_limit_hit(
    p_key TEXT,
    p_limit INT,
    p_window_seconds INT
)
RETURNS TABLE (
    allowed BOOLEAN,
    remaining INT,
    retry_after_seconds INT,
    reset_at TIMESTAMPTZ
)
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
    -- `clock_timestamp()`, not `now()`: the latter is the transaction's start
    -- time, and the client extension may batch this call into a transaction
    -- alongside a `set_config`. Wall-clock is what a window is measured in.
    v_now         TIMESTAMPTZ := clock_timestamp();
    v_row         "rate_limit_counters";
    v_elapsed     DOUBLE PRECISION;
    v_window_start TIMESTAMPTZ;
    v_windows_elapsed INT;
    v_hits        INT;
    v_prev        INT;
    v_weighted    DOUBLE PRECISION;
    v_headroom    DOUBLE PRECISION;
    v_wait        DOUBLE PRECISION;
BEGIN
    IF p_limit <= 0 OR p_window_seconds <= 0 THEN
        RAISE EXCEPTION 'erp_rate_limit_hit: limit and window must be positive (got %, %)',
            p_limit, p_window_seconds;
    END IF;

    SELECT * INTO v_row
      FROM "rate_limit_counters"
     WHERE "key" = p_key
       FOR UPDATE;

    IF NOT FOUND THEN
        -- First hit for this key. `ON CONFLICT` rather than a bare INSERT because
        -- two instances can both miss the SELECT and race to create the row; the
        -- loser increments instead of raising a unique violation.
        INSERT INTO "rate_limit_counters" ("key", "windowStart", "hits", "prevHits", "updatedAt")
        VALUES (p_key, v_now, 1, 0, v_now)
        ON CONFLICT ("key") DO UPDATE
            SET "hits" = "rate_limit_counters"."hits" + 1,
                "updatedAt" = v_now
        RETURNING * INTO v_row;

        RETURN QUERY SELECT
            v_row."hits" <= p_limit,
            GREATEST(0, p_limit - v_row."hits"),
            CASE WHEN v_row."hits" <= p_limit THEN 0 ELSE p_window_seconds END,
            v_row."windowStart" + make_interval(secs => p_window_seconds);
        RETURN;
    END IF;

    v_elapsed := extract(epoch FROM v_now - v_row."windowStart");

    IF v_elapsed >= p_window_seconds THEN
        -- The window has expired. Roll it forward by whole windows rather than
        -- re-anchoring it to now.
        --
        -- Anchoring to the arrival time would restart the decay clock: a caller
        -- who waited out a full window would find the previous window's hits
        -- counted at *full* weight again, because the new window's elapsed time
        -- would be zero. That makes the limiter stricter than configured, and — the
        -- reason it matters most — makes `retry_after_seconds` unpredictable, since
        -- the decay would depend on when the next request happened to arrive.
        v_windows_elapsed := floor(v_elapsed / p_window_seconds);

        -- One window on, the count that just ended becomes the previous count. Two
        -- or more on, nothing from before is still in view.
        v_prev := CASE WHEN v_windows_elapsed >= 2 THEN 0 ELSE v_row."hits" END;
        v_hits := 0;
        v_window_start :=
            v_row."windowStart" + make_interval(secs => p_window_seconds * v_windows_elapsed);
        v_elapsed := v_elapsed - p_window_seconds * v_windows_elapsed;
    ELSE
        v_prev := v_row."prevHits";
        v_hits := v_row."hits";
        v_window_start := v_row."windowStart";
    END IF;

    v_weighted := v_prev * (1 - v_elapsed / p_window_seconds) + v_hits;

    IF v_weighted + 1 > p_limit THEN
        -- Refused. The row is still written: the window may have rolled, and
        -- discarding that would re-derive the same expired state on the next call.
        UPDATE "rate_limit_counters"
           SET "windowStart" = v_window_start,
               "hits" = v_hits,
               "prevHits" = v_prev,
               "updatedAt" = v_now
         WHERE "key" = p_key;

        -- When does one more request become admissible?
        --
        -- The estimate has one decaying term — the previous window's contribution —
        -- so this solves for the moment it has decayed far enough. `v_headroom` is
        -- what that term is still allowed to contribute once this window's own hits
        -- are accounted for.
        --
        -- Two horizons, and answering with the nearer one is the bug worth naming:
        -- waiting for the window to roll is *not* sufficient, because at the roll
        -- this window's hits become the previous count and are then weighted in at
        -- full strength. A client that honoured an advice of "wait until the roll"
        -- would be refused a second time, which turns a back-off into a loop.
        v_headroom := p_limit - 1 - v_hits;

        IF v_prev > 0 AND v_headroom >= 0
           AND p_window_seconds * (1 - v_headroom::DOUBLE PRECISION / v_prev) < p_window_seconds
        THEN
            -- Admissible before the roll, once the previous window has decayed.
            v_wait := p_window_seconds * (1 - v_headroom::DOUBLE PRECISION / v_prev) - v_elapsed;
        ELSE
            -- Not admissible in this window at all. After the roll the state becomes
            -- (prev := v_hits, hits := 0), so solve the same inequality again against
            -- that, and add the time to get there.
            IF v_hits <= p_limit - 1 THEN
                v_wait := p_window_seconds - v_elapsed;
            ELSE
                v_wait := (p_window_seconds - v_elapsed)
                        + p_window_seconds * (1 - (p_limit - 1)::DOUBLE PRECISION / v_hits);
            END IF;
        END IF;

        RETURN QUERY SELECT
            FALSE,
            0,
            GREATEST(1, ceil(v_wait)::INT),
            v_window_start + make_interval(secs => p_window_seconds);
        RETURN;
    END IF;

    v_hits := v_hits + 1;

    UPDATE "rate_limit_counters"
       SET "windowStart" = v_window_start,
           "hits" = v_hits,
           "prevHits" = v_prev,
           "updatedAt" = v_now
     WHERE "key" = p_key;

    RETURN QUERY SELECT
        TRUE,
        GREATEST(0, floor(p_limit - (v_prev * (1 - v_elapsed / p_window_seconds) + v_hits))::INT),
        0,
        v_window_start + make_interval(secs => p_window_seconds);
END;
$$;

COMMENT ON FUNCTION erp_rate_limit_hit(TEXT, INT, INT) IS
    'Records one request against a key and reports whether it is within the '
    'sliding-window allowance. Atomic per key.';

-- ── 4. Clearing a key ────────────────────────────────────────────────────────
--
-- A successful sign-in forgets the failed attempts that preceded it, so one
-- mistyped password does not count against a legitimate user for the rest of the
-- minute. Deleting the row is the whole operation; it exists as a function only so
-- the application never issues a DELETE against this table directly.
--
-- Returns the row count rather than VOID. A driver that has to deserialise a
-- result set cannot represent `void` — Prisma raises rather than returning nothing
-- — and a reset that throws inside a settled promise is a counter that silently
-- keeps counting a user who has just proved who they are.

CREATE OR REPLACE FUNCTION erp_rate_limit_reset(p_key TEXT)
RETURNS INT
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
    v_deleted INT;
BEGIN
    DELETE FROM "rate_limit_counters" WHERE "key" = p_key;

    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$;

-- ── 5. Sweeping ──────────────────────────────────────────────────────────────
--
-- One row per distinct key, and a key contains a client IP: left alone this table
-- grows for as long as the deployment has visitors. The in-memory limiter swept
-- on a timer inside the process; the shared one is swept by the outbox worker,
-- which is the scheduled process this migration exists to enable.
--
-- A row is only removable once it can no longer influence a decision, which is
-- two windows after its last hit — one for the current window, one for the
-- previous-window term. The caller passes the horizon so the longest configured
-- window governs, not this function's guess about it.

CREATE OR REPLACE FUNCTION erp_rate_limit_sweep(p_older_than_seconds INT)
RETURNS INT
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
    v_deleted INT;
BEGIN
    DELETE FROM "rate_limit_counters"
     WHERE "updatedAt" < clock_timestamp() - make_interval(secs => p_older_than_seconds);

    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$;

-- ── 6. Proof that the claim columns are usable ───────────────────────────────
--
-- The index the dispatcher depends on is the one thing here that fails silently:
-- a missing partial index does not break a query, it just makes the poll scan the
-- table. Asserting on the catalogue costs nothing at deploy time and is the only
-- moment anyone would notice.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
         WHERE schemaname = 'public'
           AND indexname = 'outbox_events_claimable_idx'
    ) THEN
        RAISE EXCEPTION 'outbox_events_claimable_idx is missing; the dispatcher would scan the table on every poll';
    END IF;
END;
$$;
