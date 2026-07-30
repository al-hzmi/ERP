# Architectural Blueprint — Executive Summary

This document is the design record: what was chosen, what was rejected, and why.
It is written for the engineer who inherits this system, not for a brochure.

---

## 1. The shape of the problem

An ERP is not a CRUD application with more tables. Three properties make it a
different kind of system:

1. **The ledger is history, not state.** A posted entry is a statement about
   something that happened. It cannot be edited, only compensated. Any design
   that permits an `UPDATE` on posted financial data has already failed, however
   carefully the application layer avoids it.
2. **Correctness is arithmetic, not intent.** Debits must equal credits to the
   halala. Stock on hand must equal the sum of its movements. These are not
   assertions to be tested occasionally; they are invariants that must be
   impossible to violate.
3. **Concurrency is the norm.** Two salespeople sell the last unit at the same
   instant. Two clerks allocate the same payment. A system that reads a balance
   and then writes based on it, without serialisation, will be wrong — not
   often, but reliably, and silently.

Everything below follows from those three.

---

## 2. Architectural style

**Modular monolith, Clean Architecture, event-driven internally.**

Rejected: microservices. A distributed transaction across a "sales service" and
an "inventory service" cannot atomically post an invoice and issue the stock, so
the two-phase commit would be reimplemented badly, or the system would be
eventually consistent in exactly the place where it must not be. The bounded
contexts here are real — they simply share a database and a transaction.

The split into services later is prepared for: contexts communicate through a
typed domain-event catalogue and a transactional outbox, never by reaching into
each other's tables.

```
  Presentation      Next.js App Router — server components, route handlers
        │  depends on
  Application       use cases · services · orchestration
        │  depends on
  Domain            entities · value objects · rules   ← depends on NOTHING
        ↑  implemented by
  Infrastructure    Prisma · auth · crypto · events · logging
```

`domain/` imports nothing from the outer layers. That is not architectural
purity for its own sake: it is why 344 tests covering the whole of the system's
accounting behaviour run in under a second with no database.

### Bounded contexts

| Context | Owns |
|---|---|
| Platform | Tenancy, identity, RBAC, audit, outbox, numbering |
| Organisation | Branches, warehouses, cost centres, projects |
| Financials | Chart of accounts, fiscal calendar, the general ledger |
| Master Data | Products, categories, units, counterparties |
| Sales & Procurement | Commercial documents, ZATCA e-invoicing |
| Inventory | Movements, stock levels, cost layers |
| Treasury | Payments, allocations, bank reconciliation |
| Human Resources | Departments, employees, payroll |
| Governance | Approval policies, fixed assets, depreciation |

---

## 3. The money decision

**Every monetary value is an integer count of 1/10,000 units, held in `bigint`.**

`0.1 + 0.2 !== 0.3` is the reason. A `DECIMAL(19,4)` column protects the value at
rest and does nothing once it is loaded into a JavaScript `number`. So the value
never becomes a `number`:

- The database stores `DECIMAL(19,4)`; rates use `DECIMAL(19,6)`.
- Prisma returns a `Decimal`, which is converted to `Money` **through a string**.
- `Money` wraps a `bigint`. It is immutable and carries its currency, so adding
  SAR to USD is a compile-time-adjacent error rather than a silent one.
- API responses serialise amounts as **strings**. A client that parses
  `1234.5600` into a double has undone the guarantee.

Three consequences worth stating:

- **Rounding is always explicit.** `divideRounded` takes a mode. There is no
  implicit truncation anywhere, because truncation-by-accident is how a ledger
  drifts.
- **Splitting uses largest-remainder allocation.** Rounding each share
  independently loses or invents halalas; `allocate` guarantees the parts sum
  exactly to the whole. This is what keeps a distributed header discount from
  putting an invoice one halala out.
- **A fifth decimal place is rejected, not truncated.** Silently discarding
  precision at the boundary is how a rounding discrepancy gets blamed on the
  ledger three months later.

Exchange rates get their own scale-6 parse and apply path. Squeezing them
through the scale-4 code would reject a legitimate rate like `0.025431` — a bug
this design shipped with until a test caught it.

---

## 4. Invariants live in the database

The application enforces business rules. The **database** enforces the
invariants, because application code can be bypassed by a migration script, a
back-office tool, or a developer with `psql` at 2 a.m.

Migration 002 installs:

| Guard | What it makes impossible |
|---|---|
| `journals_immutability` | Editing or deleting a posted journal; inserting one already posted |
| `journal_lines_immutability` | Changing the lines of a posted journal |
| `erp_apply_journal_to_balances` | A posted journal that does not balance; a cached account balance that drifts from its lines |
| `audit_logs_append_only` | Any `UPDATE` or `DELETE` on the audit trail |
| `inventory_movements_append_only` | Rewriting stock history |
| `erp_negative_stock_guard` | Driving stock below zero (honouring the tenant policy flag) |
| `erp_allocation_within_outstanding` | Settling more than a document owes |
| `erp_fiscal_period_open_guard` | Posting into a closed period |
| 153 CHECK constraints | Single-sided journal lines, negative quantities, discounts exceeding their line, tax rates outside 0–100, salvage value above cost |

Each raises a stable `ERRCODE` (`ERP01`–`ERP11`) which the application layer
translates into a bilingual message. The user never sees a constraint name.

The integration suite proves these hold by attacking them with **raw SQL that
bypasses the application entirely**. A test suite that only exercises TypeScript
would pass just as happily if every trigger had been dropped.

### Physical design

- **Partitioning.** `journals`, `journal_lines` and `inventory_movements` are
  RANGE-partitioned yearly; `audit_logs` monthly. Done now, while the tables are
  empty, because converting a billion-row table later is a maintenance window
  nobody wants.
- **Numbering.** `erp_next_document_number` locks the counter row, so concurrent
  callers serialise. Numbers are consumed, never returned — a deleted draft
  leaves a permanent gap, which is exactly what an auditor expects to see.
- **Search.** `pg_trgm` GIN indexes plus generated `tsvector` columns. The
  trigram index is what lets `ILIKE '%1001%'` find `BTC-1001` without the
  sequential scan a leading wildcard would normally force.
- **RLS.** Tenant-isolation policies are installed, enabled and fail closed: with
  `erp.tenant_id` unset a session under `erp_app` sees no rows at all. Every read
  path now runs inside a tenant scope, so the application can connect as the
  non-owner role — which is the step that makes the policies do anything, since
  PostgreSQL exempts a table's owner from its own.

  The mechanism is `AsyncLocalStorage` rather than a threaded parameter: a parameter
  that must be passed everywhere is one that is eventually forgotten somewhere. The
  request wrapper (`apiHandler`) and the server-component wrapper (`withPageScope`)
  open the scope; the Prisma client extension binds it to the transaction. In
  development the extension also warns when a model carrying `tenantId` is queried
  with nothing bound, because the failure mode is an empty result rather than an
  error — the one kind of bug that reaches production looking like a quiet day.

---

## 5. Concurrency

Financial writes run at `SERIALIZABLE`. Stock issues and payment allocations
read a balance and then write based on it — precisely the read-modify-write that
weaker isolation levels let two sessions perform simultaneously.

Serialisation failures are expected under contention, so `withTransaction`
retries five times with full-jitter exponential backoff. Full jitter rather than
a fixed delay: it is what actually decorrelates a thundering herd. (Three
retries was the original number; 20-way contention on a single counter row
exhausted it, which the test suite caught.)

Within a transaction, `lockStockPosition` takes `SELECT ... FOR UPDATE` **before**
reading the quantity the decision depends on. Without that ordering, two
concurrent sales of the last unit both read "1 available" and both succeed.

---

## 6. The posting engine

Business events become journal entries through **pure functions**: facts in, a
balanced entry out. No database, no clock, no ambient state.

The invariant every rule upholds:

> The functional-currency total is converted **once**, and its components are
> derived from that single figure by subtraction and allocation.

Converting revenue, VAT and the receivable independently and hoping they add up
is the classic way to produce an entry that is one halala out of balance on
roughly one invoice in three hundred. Deriving components from the whole makes
that arithmetically impossible — and a test asserts it across 100 randomised
invoices, mixed tax rates, and six-decimal exchange rates.

Accounts are referred to by **intent**, never by code. `AccountMappingKey` names
what the event hits (`AR_CONTROL`, `VAT_OUTPUT`, `COGS`); the tenant maps each to
an account, optionally scoped by branch or category. A tenant can renumber their
entire chart without touching a line of posting logic.

Rules implemented: sales invoice, purchase invoice, sales credit note, receipts
and payments (with realised FX on both sides), inventory adjustment, payroll,
depreciation.

---

## 7. Governance

**Segregation of duties** answers a different question from RBAC. RBAC asks "may
this user post an invoice?"; SoD asks "may this user post *this* invoice, given
that they raised it?". The second is what actually stops one employee inventing
a supplier, approving the bill and paying themselves.

The conflict matrix is deliberately asymmetric. Create-and-approve is always
blocked. Create-and-post is blocked. Approve-and-post is **allowed**: both are
supervisory acts, and forbidding it would make a two-person finance department
unable to operate — a control that cannot be followed is a control that gets
bypassed rather than followed.

`findToxicCombinations` runs at role-assignment time, so an organisation learns
about a dangerous capability pair during setup rather than during an audit. It
reports rather than blocks: a small company may consciously accept a combination
with a compensating control, and that is their decision to document.

**Field-level permissions** are real, not decorative. A field listed in
`FIELD_LEVEL_PROTECTED` requires an explicit grant; a resource-level
`inventory.product:read` does **not** cover `costPrice`. The usual implementation
lets the resource grant satisfy the field question, which is why field-level
permissions usually protect nothing.

**Audit** is written inside the same transaction as the change it describes, so a
committed change always has its row and a rolled-back one leaves no trace of an
event that never happened. `UPDATE` writes one row per changed field, which makes
"who changed this credit limit, and from what" a single indexed query.

---

## 8. Events

A transactional outbox, not an in-memory emitter.

`emitter.emit()` inside a use case fires whether or not the transaction commits.
Post an invoice, publish `invoice.posted`, then hit a constraint on the way out:
the sale is rolled back but a subscriber has already decremented inventory.
Here, events are `INSERT`ed into `outbox_events` in the same transaction as the
state change and dispatched after commit. A rolled-back transaction takes its
events down with it.

The dispatcher claims rows by *writing* a claim — `claimedAt` and `claimedBy`, set
by an `UPDATE` whose subquery takes `FOR UPDATE SKIP LOCKED`. The distinction
matters and was originally got wrong: the claim used to be a standalone
`SELECT ... FOR UPDATE SKIP LOCKED`, and a row lock lives exactly as long as the
transaction holding it. A standalone statement commits when it returns, so the lock
was released before the first handler ran and two dispatchers both delivered the
same event. A written claim survives the transaction that took it; a lock cannot.

Dispatch then happens *outside* any transaction, which is the reason the claim has
to survive one at all. Handlers do I/O, and a transaction parked on a network call
holds its snapshot, its locks and a connection from a pool of twenty for as long as
the slowest subscriber takes.

Draining is per tenant rather than one pass over the table, because `outbox_events`
is under a fail-closed RLS policy: a session with no tenant bound sees nothing. The
tenant predicate is also written explicitly in the claim, because the seed generator
and back-office tooling still run as the owner, which PostgreSQL exempts from its own
policies — so the predicate is the control and the policy is the backstop.

Handlers are isolated; one failing does not prevent the others. Five failed attempts
dead-letters the event for a human rather than retrying forever against a bug. A
worker killed mid-dispatch leaves a claim behind, which `reclaimStaleClaims` releases
after a horizon — charging an attempt, so an event that keeps killing its worker
eventually dead-letters instead of cycling forever.

`OutboxRunner` is the scheduler: `setTimeout` re-armed after each tick rather than
`setInterval`, so a slow tick is never overlapped by the next one, plus jitter so
replicas do not poll in lockstep. Run it as its own process
(`npm run outbox:worker`), or call `outboxRunner.tick()` from a scheduled request
where no long-lived process is available.

The event catalogue is a typed map, so `on('sales.invoice.posted', e => e.payload.total)`
cannot mistype `total`, and renaming a field breaks every stale handler at
compile time.

---

## 9. Arabic-first interface

RTL is the default, not a translation layer.

- `dir="rtl"` and `lang="ar"` are on the document element, server-rendered. Applying
  direction in a client effect produces a left-to-right flash on every load.
- Layout uses **logical properties** throughout (`ps-`, `me-`, `text-start`,
  `border-e`). Switching to English moves the sidebar without a single override.
- Every numeric column uses **tabular figures** and `direction: ltr`. In a
  proportional font the digit `1` is narrower than `8`, so a column of amounts
  visibly jitters and decimal points do not align.
- Latin fragments inside Arabic text are **bidi-isolated**. Without
  `unicode-bidi: isolate`, `INV-2026-00001` renders as `00001-2026-INV`.
- Numerals are a **user preference** — Arabic-Indic (١٢٣) and Western (123) are
  both correct Arabic.
- Dates render Hijri (Umm al-Qura via ICU, not an arithmetic approximation),
  Gregorian, or both.
- Amounts are formatted from **strings** with manual thousands grouping.
  `Intl.NumberFormat` takes a `number` and would round a twelve-digit balance.

### Data entry

The screens that write follow three rules, and each exists because of a way the
alternative goes wrong.

**The domain computes; the component displays.** Invoice totals come from
`calculateInvoice` and the journal balance from scale-4 `bigint`, both of them the
same code the API posts through. A second implementation in the component would agree
with the first until the day it did not, and the figure the user read before deciding
to save is the one they would believe.

**A half-typed value is excluded, not coerced.** `Money.of` throws on `"12."`, which a
field holds for as long as it takes to type `"12.5"`. So `invoice-draft.ts` and
`journal-draft.ts` screen every value first and leave an unfinished line out of the
running total — out rather than at zero, because those read differently: a line being
typed contributes nothing, a line worth zero is one the calculator should refuse.

**A draft is offered, never applied.** Form state auto-saves to IndexedDB, and on return
the screen asks rather than filling itself in — silently restoring means someone who came
to raise a new invoice starts editing an old one and learns of it from a customer name
they did not type.

**Saving is not posting.** Every entry screen creates a DRAFT. Posting is a separate
action behind a separate permission, because it is what puts a document in the ledger,
in the ZATCA hash chain and beyond editing — a save button that did that quietly would
be the single most expensive control in the system to get wrong.

The picker choice follows the same reasoning as the rest: a native `<select>` for the
eight branches a company has, and a debounced search against `/api/search` for the
five thousand products. The search picker discards stale responses, without which
typing `ورق` then `ورقة` renders whichever answer arrives last.

---

## 10. Non-functional posture

**Performance.** Server-side pagination with a hard page-size cap — an unbounded
page size is a denial-of-service vector dressed as a feature request. Reports
aggregate in SQL and return decimal strings; nothing is summed in JavaScript.
The dashboard's eleven metrics are gathered in one parallel round rather than
eleven sequential ones. Covering and partial indexes back the hot list screens.

**Security.** Detailed in the README. The load-bearing choice: the login response
never distinguishes an unknown user from a wrong password, and a failed attempt
still costs a bcrypt verification, so the timing does not leak what the response
refuses to.

**Graceful degradation.** Errors return a stable bilingual envelope with a
correlation reference; the detail goes to the log. `DomainError` is returned as a
value inside a `Result`, so `throw` is reserved for genuine defects and a `catch`
block always signals a bug.

---

## 11. Assumptions

Stated because they are decisions, not facts:

1. **One functional currency per tenant.** Transactions may be in any currency;
   the ledger is stated in one. Multi-book reporting would need a second
   dimension on every journal line.
2. **Weighted average is the default costing policy.** FIFO is fully implemented
   and per-product selectable. Cost layers are written for every receipt
   regardless of the active method, so switching policy later does not require a
   history rebuild the data cannot support.
3. **Tax is computed at line level, then summed.** Required by ZATCA: the XML's
   line totals must add up to its header.
4. **Quantities carry no sign.** Direction lives in the movement type. A negative
   quantity is a data error, not an outbound movement.
5. **A journal must pass through DRAFT.** Enforced by trigger, so a posted entry
   provably had its lines checked before posting.
6. **The demo tenant disables SoD** so one system account can generate the whole
   dataset. Enforcement is exercised by the integration suite instead, where a
   second user proves the rule actually bites.

---

## 12. Roadmap

Ordered by what a real deployment would need next:

1. ~~Wire `drainOutbox()` to a scheduled worker.~~ Done — `OutboxRunner` and
   `scripts/outbox-worker.ts`, with the claim made genuinely concurrency-safe.
2. ~~Move rate limiting to Redis for multi-instance deployments.~~ Done, in
   PostgreSQL rather than Redis. The counter is shared, which was the requirement;
   the store it lives in was a means. Redis would have added an operational
   dependency to a stack that has none, for a table that sees one small upsert per
   request — and `RateLimitStore` is a two-method interface, so a Redis
   implementation remains a drop-in if the write volume ever justifies one.
3. ~~Put every read path inside a tenant scope so the application can connect as
   `erp_app`.~~ Done — `withPageScope` for server components, tenant resolution
   before the user lookup in sign-in, and a development-time warning when a
   tenant-scoped model is queried unbound. Verified from a non-owner role rather
   than from the catalogue.
4. ~~Complete the UI: invoice entry form, journal entry screen, approval inbox,
   stock card.~~ Done. Two conventions run through all four: saving creates a draft
   and posting stays a separate permissioned action, and every figure on screen is
   computed by the domain rather than a second time in the component —
   `calculateInvoice` for invoice totals, scale-4 `bigint` for the journal balance.
   The approval workflow itself was schema-only until now; `approval-service.ts`
   drives it. Remaining screens: procurement, treasury, payroll, master-data
   maintenance and the rest of the reports.
5. ~~ZATCA onboarding: CSID acquisition, ECDSA signing (QR tags 7–9), clearance and
   reporting API integration.~~ **Dropped from scope** by the project owner: this is a
   reference implementation rather than a system that will invoice a real taxpayer, so
   there is nothing to onboard and no Cryptographic Stamp Identifier to obtain.

   What that changes and what it does not. The remaining work was always the part that
   *cannot* be built without ZATCA issuing a CSID to a specific taxpayer — the ECDSA
   signature and the clearance call. Dropping it drops exactly that. The envelope
   already built stays: `zatca-service.ts` still produces the UUID, the UBL 2.1 XML, the
   SHA-256 hash chained to its predecessor and the Base64 TLV QR payload, all of it
   tested, and the seed still generates two hundred hash-chained e-invoices. Removing
   working, tested code because the last mile is out of scope would trade a demonstrable
   design for a smaller diff.

   So the honest description of this system's ZATCA position is now: Phase 2 envelope,
   deliberately unsigned, and not a certified integration. Anyone taking this toward a
   real deployment picks the item back up here — the signing step was designed as an
   addition rather than a rewrite, and that is still true.
6. ~~PWA offline mode — IndexedDB draft persistence and background sync.~~ Done, and the
   background-sync half needed a schema change to be safe rather than dangerous.

   Replaying a submission whose response was never seen is the entire feature, and from
   the client "never arrived" is indistinguishable from "arrived, and the reply was lost".
   A queue without idempotency is therefore a mechanism for duplicating invoices that
   fails hardest when the network is worst. So migration 006 records the first outcome of
   each client-keyed mutation and returns it verbatim for repeats — and refuses a key
   reused with a different body, because answering that with the first document's number
   would be the quietest possible way to lose an invoice.

   Scope is deliberately narrow: entry works offline, reading does not. The service worker
   never serves an API response from a cache and never mediates a non-GET request.
7. ~~Bank reconciliation matching UI over the existing schema.~~ Done, and the schema
   needed guards before a screen could safely write to it.

   The exercise produces one number — the difference between what the bank says and what
   the ledger says — and every part of it must be attributable. So the arithmetic is stated
   as a partition: matched, statement-only, books-only, giving
   `bank closing − statement-only = matched = book balance − books-only`. Sign-off is
   refused unless the difference is exactly zero, because a button that let someone assert
   agreement that does not exist would make `isReconciled` mean "somebody clicked".

   The matcher treats amount, direction and bank account as absolute rather than scored: a
   50-halala difference is a bank charge or a partial settlement, not a 99% match, and
   offering it invites someone to reconcile a discrepancy away. The automatic pass declines
   anything ambiguous — two identical transfers on the same day is Tuesday, and picking the
   first would be a coin toss recorded as a reconciliation.

   Migration 007 adds the constraints these tables never had, including the partial unique
   index that stops one payment being reconciled twice — which would make the balances
   appear to agree while concealing a genuine unexplained difference.
8. ~~Fixed-asset depreciation run and posting schedule.~~ Done, and the largest thing it
   found had nothing to do with depreciation.

   `depreciation_schedules` had **no row-level security policy at all**. Migration 4
   protects every table carrying a `tenantId`; this one was reachable only through its
   asset, so it carried none and the sweep passed it over — leaving it readable and
   writable across every tenant in the cluster under `erp_app`. Migration 008
   denormalises the tenant onto the row so the standard fail-closed policy applies, with a
   trigger refusing any row whose tenant disagrees with its asset's, so the
   denormalisation cannot become a second source of truth. Six sibling tables are in the
   same position and deliberately left alone — that is a security migration in its own
   right, not a footnote to a feature, and it is recorded under known limitations.

   The arithmetic is isolated in `domain/assets/depreciation.ts` because two properties
   have to hold *exactly* and both are easy to lose: the schedule totals `cost − salvage`
   to the halala, and net book value never drops below salvage. `Money.split` gives the
   first for straight line. Declining balance switches to straight line once straight line
   charges more — without the switch a declining balance approaches salvage
   asymptotically and never arrives — and the switch allocates the whole remaining tail in
   one `split` rather than recomputing `remaining ÷ months left` each month. Those look
   equivalent and are not: each division rounds, the rounding feeds the next month's base,
   and a schedule that is flat by construction comes out jittering by fractions of a
   halala. That jitter is what the unit tests caught.

   Generating a schedule and running a period are separate operations, which is what makes
   the register auditable: the schedule is reviewable *before* anything reaches the ledger,
   and the run has no arithmetic of its own to get wrong — it posts figures computed and
   stored earlier. A design that computed the charge at posting time would answer
   differently if the asset's terms were edited mid-life, with nothing recording that they
   had been.

   One journal per run, compacted by account, `Dr depreciation expense / Cr accumulated
   depreciation`. The asset's cost is never touched: accumulated depreciation is a
   contra-asset (migration 3 made that expressible), and writing the cost down directly
   would destroy the one figure a fixed asset register exists to preserve. Line
   descriptions are deliberately *not* stamped with the asset number, because `compact()`
   groups by account and description together — a per-asset note would put one line per
   asset per month in the ledger and make the trial balance unreadable. The asset-level
   detail is not lost: every schedule row carries the journal's id.

   The run refuses three things. It will not touch a disposed asset. It will not post
   twice — the flip to `isPosted` shares the `SERIALIZABLE` transaction with the journal,
   so a concurrent second run fails on the write conflict, retries, and finds nothing due.
   And it skips any asset whose schedule is posted **out of order**, because the register's
   `accumulatedDepreciation` is read from the last posted period's cumulative column, which
   is only the true total when every period before it is posted. The first version of that
   check compared the earliest unposted period against the earliest *due* one, which is a
   tautology — due periods are a prefix of unposted ones — and could never fire. An
   integration test that reopened a period after later ones were charged is what exposed
   it. It now looks for a posted period later than an unposted one, which is the actual
   invariant.
9. ~~Close the row-level security gap on the remaining child tables.~~ Done — migration 009,
   and raised to the top of the list ahead of partition maintenance because it was a live
   cross-tenant exposure rather than an optimisation.

   Migration 004 selects the tables it protects *by looking for a `tenantId` column*. Six
   tables were reachable only through a tenant-scoped parent, carried no such column, and were
   therefore invisible to it: `fiscal_periods`, `zatca_invoices`, `bank_statement_lines`,
   `payroll_lines`, `approval_steps`, `approval_actions`. Under `erp_app` all six were
   readable and writable across every tenant in the cluster. Two are as sensitive as anything
   in the schema — `payroll_lines` is individual salaries and `bank_statement_lines` is a
   company's entire cash movement.

   The tenant is denormalised onto each row rather than the policy joining to the parent. An
   `EXISTS (SELECT 1 FROM parent ...)` policy runs per row on every read, and on
   `bank_statement_lines` — which the reconciliation screen scans by the hundred — that turns
   a policy costing nothing into one that dominates the query. Denormalising costs 16 bytes a
   row and makes the policy an index-backed equality.

   What denormalising risks is a second, disagreeing source of truth, so each table gets a
   trigger refusing any row whose tenant differs from its parent's — one generic function
   parameterised through `TG_ARGV`, because six near-identical ones would be six chances for
   one to drift. It raises rather than silently correcting: a mismatch means calling code has a
   bug, and rewriting the value would hide it. The trigger fires on UPDATE as well as INSERT,
   since an insert-only guard leaves the same hole one step later.

   The part worth keeping is the last assertion. Rather than restating the same list a third
   time, migration 009 asserts the *inverse* property at deploy time: every table in the schema
   either has a tenant-isolation policy or appears on an explicit exempt list with its reason
   written next to it. That converts "someone must remember" into "the deploy fails" — which is
   the only reason this gap existed for nine migrations. `child-table-isolation.test.ts`
   repeats it so it is checked on every run, not only when a migration is applied.
10. ~~Build the journal and voucher registers, and stop the navigation linking to screens
    that do not exist.~~ Done, and the second half is the part worth keeping.

    Eight sidebar entries pointed at routes that had never been written. Two of them —
    `/finance/journals` and `/treasury/payments` — had complete, tested APIs behind them and
    no page, so the first thing a user clicked returned 404 on a feature that was finished
    except for its screen. Global search was worse: six of its seven destinations were
    detail routes that did not exist, so pressing Enter on almost any hit was a 404 from a
    keystroke everyone has in their fingers.

    The registers are now built, along with voucher entry over `recordPayment` — which had
    been fully tested since the first commit with nothing calling it from outside. The
    voucher form is built around one figure, `unallocated`, computed in the same scale-4
    `Money` the API posts with, so what is read before submitting is what the server
    computes.

    The structural fix is that the navigation tree moved into `lib/navigation.ts`, away from
    the component that renders it, so a test can import it — and `tests/unit/navigation.test.ts`
    now asserts that every `href` in the tree resolves to a real `page.tsx` on disk. It is a
    filesystem check, deliberately crude: no route matcher, no build, no server, so it runs in
    a millisecond and cannot go stale against a framework upgrade.

    An unbuilt screen is listed with a *قريباً* badge and **no `href` at all**, which is the
    rule that keeps the test meaningful. A disabled link would have passed a naive version of
    the check and still 404'd: "disabled" on an anchor is styling, and `pointer-events-none`
    stops a mouse click while leaving middle-click, keyboard focus and the screen-reader link
    list all pointing at a dead URL. The renderer has no branch that produces an anchor
    without a page behind it.
11. ~~Stock transfers and adjustments, the chart of accounts and the general ledger.~~ Done.

    `transferStock`, `receiveStock` and `issueStock` had been tested since the first commit
    with nothing but the seed calling them. `stock-operations-service.ts` is the seam, and it
    adds exactly one thing they do not do: the journal an adjustment needs.

    A transfer posts no journal and an adjustment does, which is worth stating because the
    asymmetry looks like an omission. Both warehouses sit in the same inventory GL account, so
    a transfer's entry would be `Dr Inventory / Cr Inventory` — a journal that says nothing.
    An adjustment is different in kind: stock appears or disappears, the value has changed, and
    the counter-entry is a gain or a loss. Writing the movement without it would leave
    inventory on the balance sheet disagreeing with the sum of its movements, which
    `erp_stock_value_consistency` makes impossible — so it would fail late and confusingly
    rather than be quietly wrong. Movement and journal share one transaction for the same
    reason.

    The adjustment quantity is a single signed string rather than a magnitude plus a direction
    flag. Two fields that must agree are two fields that can disagree, and the one that would
    win is whichever the service happened to read.

    The general ledger computes its running balance with a window function rather than a loop.
    Accumulating in TypeScript would either go through `number` — reintroducing floating point
    on the one column a reader scans for a discrepancy — or pay a `Decimal` allocation per row
    to reach the same answer more slowly. The window's ordering matches the query's, or the
    running balance would belong to a different sequence of rows than the one displayed.
12. ~~Physical stock count.~~ Done — migration 010, and the first tables written *after*
    migration 009's deploy assertion existed. That is worth recording: adding them without
    their policies would have failed the next `migrate deploy` with both table names in the
    error, which is exactly what the assertion is for.

    The whole feature rests on one decision. `expectedQuantity` is written when the sheet is
    **opened** and never recomputed. The naive alternative — compare the typed count against
    `stock_levels` at save time — produces variances that are arithmetic artefacts: a line
    counted at 09:00 and saved at 16:00 is measured against a balance that absorbed a whole
    day of sales. The manager cannot tell those from real losses, and a count whose entire
    purpose is finding real losses becomes noise. `unitCostAtOpen` is frozen for the same
    reason: valuing a shortage at a cost that moved after counting began prices the loss at
    something the company never held.

    Freezing is enforced by a trigger, not by the service keeping its word. A repair script or
    a future refactor cannot quietly unfreeze it, and the integration test proves it by
    updating the row directly — the only version of that test worth having.

    `countedQuantity` is nullable and zero is not null. An empty shelf is a count of zero and
    usually the most important finding on the sheet; a line nobody reached is unknown.
    Collapsing them would turn an abandoned afternoon into a total write-down of everything
    untouched.

    Variances post through `applyAdjustment` — the same function the manual adjustment screen
    calls — inside one transaction, all-or-nothing. `recordAdjustment` was split into a
    transaction-owning wrapper and that in-transaction core precisely so this could reuse the
    path rather than reimplement it: a second implementation would be a second place for the
    journal's direction, the costing of an increase and the zero-value refusal to drift, and
    the drift would surface as a count whose adjustments differ from an identical manual one.
13. Partition maintenance job calling `erp_ensure_year_partition` ahead of time.
   Deliberately last: migration 2 pre-creates yearly partitions through 2032 and
   every parent has a DEFAULT partition, so an out-of-range insert is slower rather
   than rejected. This is an optimisation with a 2032 deadline, not a latent outage.
