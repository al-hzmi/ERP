import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The ambient tenant of the current unit of work.
 *
 * Every database session must tell PostgreSQL which tenant it is acting for,
 * because the row-level security policies installed by migration 004 reject
 * every row until it does. The question is how that identifier travels from the
 * request, where it is known, to the transaction, where it is needed.
 *
 * Threading it through as a parameter would mean changing the signature of every
 * use case, every service and every function between the two — and a parameter
 * that must be passed everywhere is a parameter that will eventually be
 * forgotten somewhere. `AsyncLocalStorage` carries it out of band instead: the
 * request handler opens a scope, and everything awaited inside that scope sees
 * it, however deep the call stack goes.
 *
 * This is plumbing, not the control. The control is the database policy. If this
 * scope is missing the query returns nothing, which is a visible bug; it never
 * returns another tenant's data, which would be an invisible one.
 */

export interface TenantScope {
  readonly tenantId: string;
  /** Carried for logging and audit correlation, not for authorisation. */
  readonly userId?: string;
  readonly correlationId?: string;
}

const storage = new AsyncLocalStorage<TenantScope>();

/**
 * Runs `work` with `scope` bound to it and to everything it awaits.
 *
 * Returns whatever `work` returns, so this wraps an existing call without
 * changing its shape — `return runInTenantScope(scope, () => handler(...))`.
 *
 * The `.then()` below is not ceremony, and removing it reintroduces a bug that
 * leaves no trace. A Prisma query is a *lazy* promise: constructing it issues
 * nothing, and the query is sent when something subscribes. So for a callback that
 * returns the query without awaiting it —
 *
 *     runInTenantScope(scope, () => prisma.user.findMany(...))   // no `async`
 *
 * — `storage.run` has already returned by the time the caller awaits, the
 * subscription happens outside the store, and the client extension finds no tenant
 * to bind. Under `erp_app` that read then returns zero rows: not an error, just an
 * empty screen. An `async` callback happens to be safe, because the runtime adopts
 * the returned thenable from inside the function's own context — which means the
 * difference between correct and silently unscoped was the word `async`.
 *
 * Subscribing here, while the store is still active, makes both forms behave the
 * same.
 */
export function runInTenantScope<T>(scope: TenantScope, work: () => T): T {
  return storage.run(scope, () => {
    const result = work();

    if (isThenable(result)) {
      // Identity `then` — the point is *when* it is called, not what it does.
      return result.then((value) => value) as T;
    }

    return result;
  });
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/** The current scope, or `undefined` outside one (migrations, seed, CLI). */
export function currentTenantScope(): TenantScope | undefined {
  return storage.getStore();
}

/** The current tenant, or `undefined` outside a scope. */
export function currentTenantId(): string | undefined {
  return storage.getStore()?.tenantId;
}

/**
 * Thrown when code that must be tenant-scoped runs outside a scope.
 *
 * Distinct from a domain error on purpose: this is never the user's fault and
 * never something a client can trigger. It is a wiring mistake, and it should
 * read like one in the log.
 */
export class MissingTenantScopeError extends Error {
  constructor(operation: string) {
    super(
      `${operation} ran outside a tenant scope. Wrap the entry point in ` +
        `runInTenantScope({ tenantId }) — see src/lib/api/handler.ts for the pattern.`,
    );
    this.name = 'MissingTenantScopeError';
  }
}

/** The current tenant, or a loud failure. Use where a tenant is not optional. */
export function requireTenantId(operation = 'This operation'): string {
  const tenantId = currentTenantId();
  if (tenantId === undefined) {
    throw new MissingTenantScopeError(operation);
  }
  return tenantId;
}
