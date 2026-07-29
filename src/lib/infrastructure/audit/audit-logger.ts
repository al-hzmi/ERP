import type { AuditAction, Prisma } from '@prisma/client';
import type { TransactionClient } from '../db/prisma';

/**
 * The audit trail.
 *
 * Written inside the same transaction as the change it describes, so a committed
 * change always has its audit row and a rolled-back one leaves no trace of an
 * event that never happened. The table itself is append-only at the database
 * level (migration 002), so nothing in this application — including this module
 * — can edit or delete what it has written.
 */

export interface AuditContext {
  readonly tenantId: string;
  readonly userId: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly sessionId: string | null;
  /** Ties every row written by one use-case execution together. */
  readonly correlationId: string;
}

export interface AuditTarget {
  readonly entityType: string;
  readonly entityId: string;
}

/** Values that are never written to the trail, even as a "changed" marker. */
const REDACTED_FIELDS = new Set([
  'passwordHash',
  'password',
  'nationalIdEnc',
  'ibanEnc',
  'tokenHash',
]);

/** Columns that change on every write and would drown the trail in noise. */
const IGNORED_FIELDS = new Set(['updatedAt', 'createdAt', 'searchVector']);

type FieldValue = string | number | boolean | Date | null | undefined | object;

/**
 * Records a single audit entry.
 *
 * `CREATE` and `DELETE` carry a whole-entity snapshot in `metadata`, because
 * per-field diffing against nothing is meaningless. `UPDATE` writes one row per
 * changed field, which is what makes "who changed this customer's credit limit,
 * and from what" answerable in one indexed query.
 */
export async function recordAudit(
  tx: TransactionClient,
  context: AuditContext,
  action: AuditAction,
  target: AuditTarget,
  options: {
    readonly before?: Record<string, FieldValue>;
    readonly after?: Record<string, FieldValue>;
    readonly metadata?: Prisma.InputJsonValue;
  } = {},
): Promise<void> {
  const base = {
    tenantId: context.tenantId,
    userId: context.userId,
    action,
    entityType: target.entityType,
    entityId: target.entityId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent?.slice(0, 512) ?? null,
    sessionId: context.sessionId,
    correlationId: context.correlationId,
  };

  if (action === 'UPDATE' && options.before !== undefined && options.after !== undefined) {
    const changes = diffEntities(options.before, options.after);

    if (changes.length === 0) return;

    await tx.auditLog.createMany({
      data: changes.map((change) => ({
        ...base,
        fieldName: change.field,
        oldValue: change.oldValue,
        newValue: change.newValue,
      })),
    });
    return;
  }

  await tx.auditLog.create({
    data: {
      ...base,
      metadata:
        options.metadata ??
        (options.after !== undefined
          ? (sanitiseSnapshot(options.after) as Prisma.InputJsonValue)
          : options.before !== undefined
            ? (sanitiseSnapshot(options.before) as Prisma.InputJsonValue)
            : undefined),
    },
  });
}

export interface FieldChange {
  readonly field: string;
  readonly oldValue: string | null;
  readonly newValue: string | null;
}

/**
 * Computes the field-level difference between two snapshots.
 *
 * Comparison is on the *rendered* value, so a `Decimal(1200.00)` replaced by a
 * `Decimal(1200.0000)` is correctly seen as no change rather than logged as an
 * edit that never happened.
 */
export function diffEntities(
  before: Record<string, FieldValue>,
  after: Record<string, FieldValue>,
): FieldChange[] {
  const changes: FieldChange[] = [];
  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const field of fields) {
    if (IGNORED_FIELDS.has(field)) continue;

    const oldRendered = renderValue(before[field]);
    const newRendered = renderValue(after[field]);

    if (oldRendered === newRendered) continue;

    if (REDACTED_FIELDS.has(field)) {
      // The fact of the change is auditable; the values are not.
      changes.push({ field, oldValue: '[REDACTED]', newValue: '[REDACTED]' });
      continue;
    }

    changes.push({ field, oldValue: oldRendered, newValue: newRendered });
  }

  return changes;
}

function renderValue(value: FieldValue): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    // Prisma `Decimal` and other value-ish objects expose a faithful toString.
    if ('toFixed' in value && typeof (value as { toFixed: unknown }).toFixed === 'function') {
      return (value as { toFixed: (dp: number) => string }).toFixed(4);
    }
    return JSON.stringify(value);
  }
  return String(value);
}

function sanitiseSnapshot(snapshot: Record<string, FieldValue>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (IGNORED_FIELDS.has(key)) continue;
    result[key] = REDACTED_FIELDS.has(key) ? '[REDACTED]' : renderValue(value);
  }
  return result;
}

/**
 * Records an authentication event.
 *
 * Failed logins are audited as deliberately as successful ones — a burst of
 * `LOGIN_FAILED` rows against one account from one address is the earliest
 * signal of credential stuffing available.
 */
export async function recordAuthAudit(
  tx: TransactionClient,
  context: Omit<AuditContext, 'userId'> & { userId: string | null },
  action: Extract<AuditAction, 'LOGIN' | 'LOGOUT' | 'LOGIN_FAILED' | 'ACCESS_DENIED'>,
  details: Prisma.InputJsonValue,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      tenantId: context.tenantId,
      userId: context.userId,
      action,
      entityType: 'User',
      entityId: context.userId ?? 'unknown',
      ipAddress: context.ipAddress,
      userAgent: context.userAgent?.slice(0, 512) ?? null,
      sessionId: context.sessionId,
      correlationId: context.correlationId,
      metadata: details,
    },
  });
}
