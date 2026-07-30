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
npm run db:migrate          # applies all nine migrations
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
npm test           # 522 tests (344 unit + 178 integration)
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
├── migrations/               9 migrations (see below)
└── seed.ts + seed/           the data generator
tests/
├── unit/                     344 tests, no database required
└── integration/              178 tests against real PostgreSQL
```

Dependencies point inward. `domain/` imports nothing from `application/` or
`infrastructure/`, which is why the entire accounting behaviour of the system is
testable without a database.

### The nine migrations

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
6. **`20260731000000_request_idempotency`** — the first outcome of each client-keyed
   mutation, so the offline queue can replay a submission whose response was lost
   without creating a second invoice.
7. **`20260801000000_bank_reconciliation_guards`** — the constraints `bank_statement_lines`
   never had, and the partial unique index that stops one payment being reconciled twice.
8. **`20260802000000_fixed_asset_depreciation`** — `depreciation_schedules` had no
   row-level security policy at all: it carried no `tenantId`, so migration 4's sweep
   passed it over and it was readable across every tenant. This denormalises the tenant
   onto the row (with a trigger refusing one that disagrees with its asset's), adds the
   policy, ties `isPosted` to `journalId` as one fact, and stops an asset being
   depreciated past its salvage value.
9. **`20260803000000_close_child_table_rls_gap`** — the same gap on the six remaining child
   tables: `fiscal_periods`, `zatca_invoices`, `bank_statement_lines`, `payroll_lines`,
   `approval_steps`, `approval_actions`. Two of them are as sensitive as anything in the
   schema — `payroll_lines` is individual salaries, `bank_statement_lines` is a company's
   entire cash movement. It also asserts, at deploy time, that *every* table either has a
   tenant-isolation policy or is on an explicit exempt list with a stated reason, so a new
   child table added without one fails the deploy instead of waiting to be noticed.

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
| Live invoice totals | `utils/invoice-draft.ts` | The entry form totals through the *same* `calculateInvoice` the API posts through, so the figure read before saving is the figure saved — and a half-typed line is excluded rather than counted as zero |
| Approval workflow | `application/services/approval-service.ts` | Role-per-step, initiator excluded, one decision per step, and `SERIALIZABLE` so two approvers racing on a shared inbox cannot both advance it |
| The scope seam for pages | `api/page.ts` | What `apiHandler` is to a route: redirect, then bind the tenant, in one place a server component cannot forget |
| Idempotent replay | `api/idempotency.ts` | The first outcome of a keyed mutation, returned verbatim for repeats — and refused outright when a key is reused with a different body, because that would answer with the wrong document's number |
| The offline queue | `offline/queue.ts` | Oldest first, stop at the first undelivered submission, and one key per submission reused on every attempt: the three rules that keep a retry from becoming a second invoice |
| Bank matching | `domain/treasury/bank-matching.ts` | Amount, direction and account are absolute — a 50-halala difference is a bank charge, not a 99% match — and the automatic pass declines anything ambiguous rather than tossing a coin |
| Depreciation schedules | `domain/assets/depreciation.ts` | The schedule totals `cost − salvage` exactly and net book value never dips below salvage; declining balance switches to straight line and allocates the whole tail in one `split`, because recomputing it monthly makes a flat schedule jitter by fractions of a halala |

---

## The screens

| Screen | Path | What it is for |
|---|---|---|
| Dashboard | `/` | Revenue, receivables, stock value, the month's activity |
| Sales register | `/sales/invoices` | Server-paginated, filterable by status |
| **Invoice entry** | `/sales/invoices/new` | Line grid with live exact totals; saves a DRAFT |
| **Journal entry** | `/finance/journals/new` | Debit/credit grid, balance banner, submit blocked until it balances |
| Trial balance | `/finance/trial-balance` | Balanced/unbalanced answered at a glance |
| **Approval inbox** | `/approvals` | Only what is waiting on you, by the role its current step names |
| **Stock card** | `/inventory/stock-card` | One product in one warehouse, movement by movement, running balance |
| **Bank reconciliation** | `/treasury/reconciliation` | Statement lines against payment vouchers, with the difference answered at a glance |
| **Fixed asset depreciation** | `/finance/depreciation` | The charges due this period, what the run will skip and why, and each asset's schedule progress |
| **Journal register** | `/finance/journals` | The general ledger, filterable by status; `type` shows what posted each entry |
| **Voucher register** | `/treasury/payments` | Receipts and payments together, with the unallocated balance in its own column |
| **Voucher entry** | `/treasury/payments/new` | Allocation grid over open documents, oldest due first, with the unallocated figure computed in `Money` |
| **Products** | `/inventory/products` | Catalogue with search and category filter; `costPrice` withheld without the field grant |
| **Product card** | `/inventory/products/[id]` | Terms, stock per warehouse (never one number), and the last twenty movements |
| **Stock balances** | `/inventory/stock` | By warehouse, valued from `totalValue`, with totals aggregated over the whole filtered set |
| **Customers** | `/sales/customers` | Register with balance and credit standing |
| **Customer card** | `/sales/customers/[id]` | Five-bucket ageing by days past due, open documents, recent vouchers |
| **Suppliers** | `/procurement/suppliers` | The same table read the other way; `BOTH` appears in both registers |
| **Supplier card** | `/procurement/suppliers/[id]` | Payable ageing and open exposure |
| Sign-in | `/login` | |

The sidebar is an accordion of five modules, each split into **التهيئة / العمليات / التقارير**
— the division every large ERP settles on, because it maps to who uses a screen and how often.
Screens that are planned but unbuilt are listed with a *قريباً* badge and **no `href` at all**.
Not a disabled link: `pointer-events-none` stops a mouse click and leaves middle-click,
keyboard focus and the screen-reader link list all pointing at a dead URL.
`tests/unit/navigation.test.ts` asserts every `href` in the tree resolves to a real
`page.tsx` on disk, so a link to a screen that does not exist fails the suite.

Two conventions the entry screens share. Saving creates a **draft**; posting is a
separate, separately permissioned action, because posting is what puts a document in
the ledger and in the ZATCA hash chain. And the arithmetic on screen comes from the
domain — `calculateInvoice` for invoices, scale-4 `bigint` for the journal balance —
so no total is computed twice by two implementations that might disagree.

---

## Working offline

The two entry screens keep working with no connection. Three pieces make that true, and
each is narrower than it sounds:

**Drafts.** Form state auto-saves to IndexedDB as it is typed and is *offered back* on
return, never applied silently — a user who came to raise a new invoice should not find
themselves editing last Thursday's without being told. One draft per screen, kept for
seven days.

**A submission queue.** Submitting with no connection queues the request and replays it
on reconnect, oldest first, halting at the first one that cannot be delivered so the
order the user created is the order the ledger receives. A refusal — a closed period, an
inactive product — is not retried; it is kept with its reason attached so someone can see
what was rejected.

**An idempotency key per submission**, generated once and reused on every attempt. This
is the part that matters: from the client, "never arrived" and "arrived, and the reply was
lost" are indistinguishable, and guessing wrong in the second case creates a second
invoice with a second document number. The server records the first outcome against the
key and returns it verbatim for repeats, which makes the retry safe in all three cases.
It refuses a key reused with a different body rather than answering with the first
document's number.

What is deliberately *not* offline is everything that reads. The service worker never
serves an API response from a cache — a stale balance presented as a current one is worse
than an error — and never mediates a non-GET request at all.

```
Idempotency-Key: <uuid>      # on POST /api/sales/invoices, POST /api/finance/journals
IDEMPOTENCY_TTL_SECONDS      # how long a key is honoured; default 86400
```

The records are swept by the outbox worker, which is already the deployment's scheduled
process.

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
payload. What is *not* implemented is the ECDSA signature (QR tags 7–9) and the
clearance API call, and that is now a scope decision rather than a gap: both require a
Cryptographic Stamp Identifier issued by ZATCA to a specific taxpayer after onboarding,
and this is a reference implementation rather than a system that will invoice one.

So state it plainly: **Phase 2 envelope, deliberately unsigned, not a certified
integration.** Do not put this in front of a real taxpayer's invoices as it stands. The
envelope was built so that signing is an addition rather than a rewrite, which is still
true for anyone who picks the item up.

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
- **Every table is covered, and the deploy proves it** — migration 009 asserts that each
  table in the schema either carries a tenant-isolation policy or appears on an explicit
  exempt list with its reason stated. This exists because migration 004 selected its targets
  *by looking for a `tenantId` column*, so seven child tables reachable only through a parent
  were invisible to it and stayed cross-tenant readable for five migrations. Restating the
  list correctly would only have postponed the next omission; asserting the inverse property
  turns it into a failed deploy.
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
- **Approval requests are raised on request, not automatically.** The workflow now
  runs — `approval-service.ts` raises requests, enforces the role and
  segregation-of-duties rules, advances the steps and refuses a second decision, and
  the inbox actions them. What is deliberately *not* wired yet is the posting path
  calling `requestApproval` on its way through: making an invoice unpostable until
  approved changes when documents can post, which is a policy decision rather than a
  UI one. The seam is one function call.
- **Not every module has a screen.** The domain, application and API layers cover
  sales, procurement, inventory, treasury, financials and HR. The UI ships the
  dashboard, the sales register and invoice entry, the journal entry screen, the trial
  balance, the approval inbox, the stock card, bank reconciliation, the depreciation
  run, the journal and voucher registers, voucher entry, the product catalogue and card,
  stock balances, the customer and supplier registers and cards, and sign-in. Purchase
  documents, payroll, GRC and the remaining master-data maintenance screens are still
  API-only and appear in the sidebar as *قريباً* rather than as links.
- **Some detail pages still do not exist, and nothing pretends they do.** Product,
  customer and supplier cards now exist and global search links to them again. Invoice,
  account and employee detail screens do not: those identifiers render as plain text and a
  search hit with no screen behind it renders as a row labelled *لا توجد شاشة* rather than
  a link. Less convenient and honest.
- **Reorder points are per product, not per warehouse.** `/inventory/stock` flags a row
  whose balance is at or below the product's `reorderPoint`, which over-reports in a
  multi-warehouse company — the figure is company-wide and the balance is not. It is shown
  as a hint, never as a purchasing instruction. A real replenishment feature needs a
  per-warehouse reorder point, which is a schema change and not one made speculatively.
- **Offline mode covers data entry, not the whole application.** Drafts auto-save to
  IndexedDB and queued submissions replay under an idempotency key, so the two entry
  screens work with no connection. Everything that *reads* — the dashboard, the
  registers, the reports — needs the network, deliberately: the service worker will not
  serve an API response from a cache, because a stale balance presented as a current one
  is worse than an error.
- **The service worker caches only what cannot go stale.** Build output, whose URLs are
  content-hashed, and the offline fallback page. It never touches a non-GET request and
  never caches `/api/` — a cached tenant-scoped response could otherwise be served to the
  next person to sign in on the same device.
- **Document numbering contends heavily under serialisable isolation.**
  `erp_next_document_number` does an `INSERT … ON CONFLICT` on `number_sequences` inside
  the caller's `SERIALIZABLE` transaction, and PostgreSQL's snapshot isolation takes
  predicate locks on the unique index — so concurrent allocations conflict *across
  tenants*, on different rows sharing index pages. `withTransaction` retries five times and
  almost always wins; with six concurrent posting workloads the budget was exhausted about
  one run in three. Measured, not theorised: it is why `vitest.config.ts` runs test files
  serially. Fixing it properly means either allocating outside the serialisable snapshot or
  reshaping the function to a single conflict-updating statement, and it wants a contention
  benchmark rather than a guess — so the current state is stated here instead of patched
  quietly.

