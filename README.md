# نظام تخطيط موارد المؤسسة — Enterprise ERP

A financial and operational ERP built as a **modular monolith** with Clean
Architecture and DDD boundaries. Arabic-first (RTL native), IFRS-aligned, and
built to the ZATCA Phase 2 e-invoicing envelope.

Every monetary value is exact decimal arithmetic on `bigint`. There is no
floating point anywhere on the money path, and the ledger's invariants are
enforced by PostgreSQL triggers and constraints — not only by application code.

---

## Quick start

```bash
# 1. Dependencies
npm install

# 2. Configuration
cp .env.example .env        # then set AUTH_SECRET and ENCRYPTION_KEY
#    openssl rand -base64 48   -> AUTH_SECRET
#    openssl rand -hex 32      -> ENCRYPTION_KEY

# 3. Database (PostgreSQL 15+)
npm run db:migrate          # applies all five migrations
npm run db:seed             # generates and verifies a full demo company

# 4. Run
npm run dev                 # http://localhost:3000

# 5. Dispatch domain events (a second process)
npm run outbox:worker       # without this, asynchronous subscribers never fire
```

Sign in with any of `admin`, `controller`, `accountant`, `sales`, `warehouse`,
`cashier`, `hr`, `auditor` — password `Erp@Demo2026!`. The roles differ
meaningfully: `sales` can raise an invoice but not post it, `auditor` can read
everything and change nothing.

```bash
npm test           # 278 tests (202 unit + 76 integration)
npm run typecheck  # strict TypeScript, no `any`, no `@ts-ignore`
npm run build      # production build
```

The integration tests need `DATABASE_URL` pointing at a migrated database, and
`tenant-isolation-as-app-role` additionally needs `APP_DATABASE_URL` for the
non-owner role. Those three skip themselves when their variable is unset;
`database-guards` and `tenant-isolation` predate that convention and fail instead,
so `npm test` is red on a machine with no PostgreSQL. Run `npm run test:unit`
there, or point both variables at a scratch database and run the lot.

---

## What the data generator produces

`npm run db:seed` builds a complete trading company and then **verifies it**,
exiting non-zero if any assertion fails:

| | |
|---|---|
| 500 products across 7 categories | 200 customers, 100 suppliers |
| 5 branches, 10 warehouses | 50 employees across 7 departments |
| 78 GL accounts, 23 posting mappings | 8 users across 8 roles |
| 200 sales invoices, 100 purchase invoices | 123 payment vouchers |
| 500 posted journal entries | 1,000 inventory movements |
| 200 ZATCA e-invoices, hash-chained | ~920 audit entries |

```
✓ Ledger balances (debit = credit)           344555211.38 = 344555211.38
✓ Every individual entry balances            0 unbalanced entries
✓ Stock levels reconcile to movements        0 discrepancies
✓ No negative stock positions                0 negative positions
✓ Inventory value = quantity x avg cost      0 drifting rows
✓ Paid amounts match allocations             0 mismatches
```

Documents are created as drafts and posted **through the real application use
cases** — nothing writes a journal line or stock movement by hand. That is
slower than bulk-inserting rows, and it is the point: the dataset cannot contain
a state the application would refuse to produce, and running the generator is
itself an end-to-end exercise of the posting engine.

Randomness is seeded (`SEED_RANDOM_SEED`), so a given seed reproduces the
dataset byte for byte.

---

## Architecture

```
src/
├── app/                      Next.js 14 App Router
│   ├── (app)/                authenticated pages — server components
│   ├── api/                  route handlers
│   └── login/
├── components/               ui atoms · layout · providers
├── lib/
│   ├── domain/               ← pure. no database, no clock, no framework
│   │   ├── shared/           Money, Quantity, Result, DomainError, events
│   │   ├── accounting/       journal aggregate, posting rules
│   │   ├── inventory/        FIFO + weighted-average costing
│   │   └── sales/            invoice calculator
│   ├── application/          use cases and services — orchestration only
│   ├── infrastructure/       Prisma, auth, audit, crypto, events, logging
│   ├── api/                  the shared route handler and page scope
│   └── utils/                formatting (Arabic numerals, Hijri, BiDi)
├── store/                    Zustand — client UI state only
└── styles/
prisma/
├── schema.prisma             7 bounded contexts
├── migrations/               5 migrations (see below)
└── seed.ts + seed/           the data generator
tests/
├── unit/                     202 tests, no database required
└── integration/              76 tests against real PostgreSQL
```

Dependencies point inward. `domain/` imports nothing from `application/` or
`infrastructure/`, which is why the entire accounting behaviour of the system is
testable without a database.

### The five migrations

1. **`20260101000000_init`** — the schema Prisma generates.
2. **`20260101000001_partitioning_constraints_triggers`** — everything Prisma
   *cannot* declare: RANGE partitioning for the four append-only ledgers, 153
   CHECK constraints, immutability triggers, the account-balance trigger,
   the negative-stock guard, trigram/tsvector search indexes, NULL-aware partial
   unique indexes, gap-free sequence allocation, and row-level security policies.
3. **`20260101000002_contra_accounts`** — migration 2 asserted that an account's
   nature follows its type. That is false for accumulated depreciation and sales
   returns, so the exception is named rather than the rule removed.
4. **`20260729120000_enforce_tenant_isolation`** — migration 2's policies read
   `erp_current_tenant() IS NULL OR ...`, which meant an unscoped session saw every
   tenant's rows, and nothing set the scope. This makes them fail closed and creates
   the non-owner role the application is meant to connect as.
5. **`20260730000000_outbox_runner_and_shared_rate_limits`** — claim columns on
   `outbox_events`, so a claim can outlive the transaction that took it; and the
   shared rate-limit counters with their sliding-window function.

Migration 4 installed the policies; making them *apply* took no further migration,
only the application change that put every read path inside a tenant scope. See
`.env.example` for the role switch that activates them.

> Migration 2 adds two generated `tsvector` columns that are deliberately absent
> from `schema.prisma` (Prisma cannot express `GENERATED ALWAYS AS ... STORED`).
> `migrate deploy` is unaffected; use `migrate dev --create-only` when editing
> the schema so the shadow database does not propose dropping them.

---

## The parts worth reading first

| Concern | Where | Why it is interesting |
|---|---|---|
| Exact money | `domain/shared/scaled-decimal.ts` | `bigint` at scale 4, explicit rounding modes, largest-remainder allocation so split amounts always sum back to the whole |
| Automatic posting | `domain/accounting/posting-rules.ts` | Pure functions. Each derives its components from a **single** currency conversion, so entries balance by construction rather than by luck |
| Ledger integrity | `migrations/…_triggers/migration.sql` | Posted journals and documents are immutable, audit rows and stock movements are append-only — enforced against `psql`, not just against well-behaved code |
| Costing | `domain/inventory/costing.ts` | FIFO layer consumption and weighted average, with expiry enforcement, as pure functions over immutable snapshots |
| Concurrency | `application/services/inventory-service.ts` | Row locks taken *before* the read a decision depends on, so two concurrent sales of the last unit cannot both succeed |
| Segregation of duties | `infrastructure/auth/segregation-of-duties.ts` | A conflict matrix over lifecycle steps, plus toxic-combination detection at role-assignment time |
| Search | `application/services/search-service.ts` | Exact/prefix/substring/trigram combined into one SQL-side relevance score — typing `1001` finds `BTC-1001` |
| ZATCA | `application/services/zatca-service.ts` | UBL 2.1 XML, chained SHA-256 invoice hash, byte-correct Base64 TLV QR payload |
| Outbox claiming | `infrastructure/events/event-bus.ts` | A claim written by the statement that takes the lock, so it outlives the transaction — dispatch then happens outside one, because handlers do I/O |
| The dispatch loop | `infrastructure/events/outbox-runner.ts` | `setTimeout` re-armed after each tick rather than `setInterval`, so a slow tick is never overlapped; jitter so replicas do not poll in lockstep |
| Shared rate limits | `migrations/…_shared_rate_limits/migration.sql` | Read, decide and increment as one atomic unit per key, because expressed as separate statements two instances both get admitted |

---

## Running the dispatcher

Domain events are committed to `outbox_events` inside the business transaction and
delivered afterwards, so **something has to deliver them**. Nothing does by default:

```bash
npm run outbox:worker
```

Run one or several — claims are safe under concurrency, which is what migration
005's claim columns establish. In a container invoke `tsx scripts/outbox-worker.ts`
directly rather than through npm, because npm does not forward `SIGTERM` and the
graceful stop is what settles the batch in flight instead of orphaning it.

On a platform with no long-lived processes, call `outboxRunner.tick()` from a
scheduled request instead. It is the same pass the loop makes.

The worker is also what sweeps the shared rate-limit counters — one row per client
IP, otherwise growing for as long as the deployment has visitors.

| Variable | Default | |
|---|---|---|
| `OUTBOX_POLL_INTERVAL_MS` | `5000` | gap between ticks, not tick starts |
| `OUTBOX_BATCH_SIZE` | `100` | per tenant, per tick |
| `OUTBOX_RECLAIM_AFTER_SECONDS` | `300` | must exceed the slowest realistic dispatch |
| `OUTBOX_RECLAIM_EVERY_TICKS` | `12` | recovery pass, not the hot path |
| `OUTBOX_SWEEP_EVERY_TICKS` | `60` | rate-limit counter sweep |
| `OUTBOX_JITTER_MS` | `1000` | decorrelates replicas polling in lockstep |

A dead-lettered event (`deadLettered = true`) has failed five times and is waiting
for a human; `lastError` and `claimedBy` are there to say what and where.

---

## Compliance notes

**IFRS 15** — revenue is recognised at posting, when control transfers, not at
order entry. **IAS 2** — purchases are capitalised net of trade discount and
excluding recoverable VAT; both FIFO and weighted average are supported.
**IAS 21** — realised FX differences on settlement go to profit or loss
immediately.

**ZATCA Phase 2** — every posted sales invoice produces a UUID, a UBL 2.1 XML
document, a SHA-256 hash chained to its predecessor, and a Base64 TLV QR
payload. What is deliberately *not* implemented is the ECDSA signature (QR tags
7–9) and the clearance API call: both require a Cryptographic Stamp Identifier
issued by ZATCA to a specific taxpayer after onboarding, which cannot be
fabricated. The envelope is built so signing is an addition rather than a
rewrite.

---

## Security

- **Passwords** — bcrypt cost 12, length-and-variety policy, escalating lockout.
- **Sessions** — 15-minute HS256 access tokens; opaque refresh tokens stored only
  as SHA-256 hashes, in revocable rotation families.
- **PII at rest** — AES-256-GCM with a per-value IV and a versioned payload;
  national IDs and IBANs are never stored in plaintext.
- **Authorisation** — RBAC with wildcards and genuine field-level protection: a
  resource-level grant does **not** satisfy a field-scoped question, so
  `costPrice` is actually withheld.
- **Injection** — every query is parameterised through Prisma or tagged-template
  raw SQL. No string-concatenated SQL exists in the codebase.
- **Errors** — a stack trace never reaches a response body. Failures return a
  stable bilingual envelope and a correlation reference.
- **Multi-tenancy** — RLS policies are installed, fail closed, and now actually
  apply: every read path runs inside a tenant scope, so `DATABASE_URL` can point at
  the non-owner `erp_web` role. Until that switch the policies were inert, because
  PostgreSQL exempts a table's owner from its own policies — the control existed and
  did nothing. `tenant-isolation-as-app-role.test.ts` asserts on rows from a role the
  policies apply to, which is the only way to demonstrate the difference.
- **A forgotten scope is loud** — the client extension warns, in development, when a
  model carrying `tenantId` is queried with nothing bound. The models are derived
  from the schema rather than listed, so adding one cannot quietly escape the check.
  This matters because the failure mode is silence: an unscoped read under `erp_app`
  returns no rows, so a page renders an empty table instead of an error.

---

## Known limitations

Stated plainly rather than discovered later:

- **Rate limiting is only shared where a database is configured.** The counter
  moved into `rate_limit_counters` and the sliding-window arithmetic into
  `erp_rate_limit_hit()`, so every instance now decrements the same allowance.
  Production defaults to that store; everything else defaults to process memory,
  where the limit is still per-instance. If the shared store is unreachable the
  limiter degrades to a per-instance limit rather than refusing everything —
  failing closed would make a database blip into the outage it exists to prevent.
- **The shared limiter approximates rather than records.** Two counters per key,
  with the previous window weighted by how much of it is still in view. Exact to
  within one window's decay, and specifically incapable of the 2x-limit burst a
  fixed window permits across a boundary. A precise implementation would need one
  row per request, which at the API bucket is a hundred inserts per key per minute.
- **Approval workflows are modelled, not yet driven.** The schema, the policy
  engine and the SoD checks are in place; the UI to walk a document through
  multi-step approval is not.
- **Not every module has a screen.** The domain, application and API layers cover
  sales, procurement, inventory, treasury, financials and HR. The UI currently
  ships the dashboard, the sales register, the trial balance and sign-in.
- **PWA offline mode is not implemented.** Auto-save drafts to IndexedDB and
  background sync are designed for but not built.
