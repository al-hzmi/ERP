/**
 * Domain events — the integration seam between bounded contexts.
 *
 * A context never reaches into another context's tables. It records that
 * something happened, and whoever cares subscribes. That is what keeps this a
 * modular monolith that could be split into services rather than a distributed
 * ball of mud that already has been.
 *
 * Events are persisted to `outbox_events` inside the same transaction as the
 * state change that produced them, then dispatched asynchronously. No dual write,
 * no lost event, no event for a transaction that rolled back.
 */

export type EventPayload = Record<string, unknown>;

export interface DomainEventMetadata {
  /** Ties every event and audit row produced by one use-case execution together. */
  readonly correlationId: string;
  /** The event that caused this one, when it was produced by a handler. */
  readonly causationId?: string;
  readonly userId?: string;
  readonly tenantId: string;
}

export interface DomainEvent<TPayload extends EventPayload = EventPayload> {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly occurredAt: Date;
  readonly payload: TPayload;
  readonly metadata: DomainEventMetadata;
}

/**
 * The catalogue of every event this system publishes.
 *
 * Declared as a single map so that a subscriber's payload type is checked at
 * compile time: `on('sales.invoice.posted', e => e.payload.total)` cannot
 * mistype `total`, and renaming a field breaks every stale handler immediately.
 */
export interface DomainEventMap {
  // ── Sales ────────────────────────────────────────────────────────────────
  'sales.invoice.created': {
    documentId: string;
    documentNumber: string;
    counterpartyId: string;
    total: string;
    currency: string;
  };
  'sales.invoice.posted': {
    documentId: string;
    documentNumber: string;
    counterpartyId: string;
    branchId: string;
    warehouseId: string | null;
    issueDate: string;
    subtotal: string;
    discountTotal: string;
    taxTotal: string;
    total: string;
    currency: string;
    exchangeRate: string;
    lines: {
      productId: string;
      quantity: string;
      unitPrice: string;
      discount: string;
      taxRate: string;
      taxAmount: string;
      lineTotal: string;
    }[];
  };
  'sales.invoice.voided': { documentId: string; documentNumber: string; reason: string };
  'sales.creditNote.posted': {
    documentId: string;
    documentNumber: string;
    originalDocumentId: string;
    total: string;
  };

  // ── Procurement ──────────────────────────────────────────────────────────
  'procurement.invoice.posted': {
    documentId: string;
    documentNumber: string;
    counterpartyId: string;
    branchId: string;
    warehouseId: string | null;
    issueDate: string;
    subtotal: string;
    discountTotal: string;
    taxTotal: string;
    total: string;
    currency: string;
    exchangeRate: string;
    lines: {
      productId: string;
      quantity: string;
      unitPrice: string;
      discount: string;
      taxRate: string;
      taxAmount: string;
      lineTotal: string;
    }[];
  };

  // ── Inventory ────────────────────────────────────────────────────────────
  'inventory.movement.recorded': {
    movementId: string;
    movementNumber: string;
    type: string;
    productId: string;
    warehouseId: string;
    quantity: string;
    unitCost: string;
    totalCost: string;
    balanceAfter: string;
  };
  'inventory.stock.depleted': {
    productId: string;
    warehouseId: string;
    quantityOnHand: string;
  };
  'inventory.reorderPoint.reached': {
    productId: string;
    warehouseId: string;
    quantityOnHand: string;
    reorderPoint: string;
  };
  'inventory.transfer.completed': {
    transferGroupId: string;
    productId: string;
    fromWarehouseId: string;
    toWarehouseId: string;
    quantity: string;
  };

  // ── Financials ───────────────────────────────────────────────────────────
  'finance.journal.posted': {
    journalId: string;
    entryNumber: string;
    date: string;
    type: string;
    totalDebit: string;
    totalCredit: string;
    referenceType: string | null;
    referenceId: string | null;
  };
  'finance.journal.reversed': {
    journalId: string;
    entryNumber: string;
    reversalJournalId: string;
    reversalEntryNumber: string;
  };
  'finance.period.closed': { fiscalPeriodId: string; periodNumber: number; year: number };

  // ── Treasury ─────────────────────────────────────────────────────────────
  'treasury.payment.posted': {
    paymentId: string;
    voucherNumber: string;
    type: string;
    counterpartyId: string;
    amount: string;
    currency: string;
    method: string;
  };
  'treasury.payment.allocated': {
    paymentId: string;
    documentId: string;
    amount: string;
    documentStatus: string;
  };
  'treasury.payment.voided': { paymentId: string; voucherNumber: string };

  // ── Counterparty ─────────────────────────────────────────────────────────
  'counterparty.balance.changed': {
    counterpartyId: string;
    previousBalance: string;
    newBalance: string;
    reason: string;
  };
  'counterparty.creditLimit.exceeded': {
    counterpartyId: string;
    creditLimit: string;
    balance: string;
  };

  // ── Governance ───────────────────────────────────────────────────────────
  'governance.approval.requested': {
    requestId: string;
    entityType: string;
    entityId: string;
    stepNumber: number;
  };
  'governance.approval.granted': {
    requestId: string;
    entityType: string;
    entityId: string;
    stepNumber: number;
    userId: string;
  };
  'governance.approval.rejected': {
    requestId: string;
    entityType: string;
    entityId: string;
    userId: string;
    comment: string | null;
  };

  // ── HR ───────────────────────────────────────────────────────────────────
  'hr.payroll.posted': {
    payrollRunId: string;
    runNumber: string;
    year: number;
    month: number;
    totalNet: string;
  };

  // ── Platform ─────────────────────────────────────────────────────────────
  'platform.user.loggedIn': { userId: string; ipAddress: string | null };
  'platform.user.loginFailed': { username: string; ipAddress: string | null; attempts: number };
}

export type DomainEventType = keyof DomainEventMap;

export type TypedDomainEvent<T extends DomainEventType = DomainEventType> = DomainEvent<
  DomainEventMap[T] & EventPayload
> & { readonly eventType: T };

/** Which aggregate each event belongs to — used to route and to index the outbox. */
const AGGREGATE_BY_PREFIX: Record<string, string> = {
  sales: 'Document',
  procurement: 'Document',
  inventory: 'InventoryMovement',
  finance: 'Journal',
  treasury: 'Payment',
  counterparty: 'Counterparty',
  governance: 'ApprovalRequest',
  hr: 'PayrollRun',
  platform: 'User',
};

/**
 * Builds a well-formed event. Callers supply only what varies; identity,
 * timestamp and aggregate classification are derived so they cannot be forgotten.
 */
export function createDomainEvent<T extends DomainEventType>(
  eventType: T,
  aggregateId: string,
  payload: DomainEventMap[T],
  metadata: DomainEventMetadata,
): TypedDomainEvent<T> {
  const prefix = eventType.split('.')[0] ?? 'platform';
  return {
    eventId: crypto.randomUUID(),
    eventType,
    aggregateType: AGGREGATE_BY_PREFIX[prefix] ?? 'Unknown',
    aggregateId,
    occurredAt: new Date(),
    payload: payload as DomainEventMap[T] & EventPayload,
    metadata,
  };
}

/** A handler may be async; the dispatcher awaits it and retries on failure. */
export type DomainEventHandler<T extends DomainEventType> = (
  event: TypedDomainEvent<T>,
) => Promise<void> | void;

/**
 * Mixin for aggregates that raise events.
 *
 * Events accumulate on the aggregate during a use case and are drained by the
 * unit of work at commit time — so an aggregate never talks to infrastructure
 * and a rolled-back transaction publishes nothing.
 */
export abstract class EventEmittingAggregate {
  private pendingEvents: DomainEvent[] = [];

  protected raise(event: DomainEvent): void {
    this.pendingEvents.push(event);
  }

  /** Returns and clears the queued events. Called once, by the unit of work. */
  releaseEvents(): DomainEvent[] {
    const events = this.pendingEvents;
    this.pendingEvents = [];
    return events;
  }

  get hasPendingEvents(): boolean {
    return this.pendingEvents.length > 0;
  }
}
