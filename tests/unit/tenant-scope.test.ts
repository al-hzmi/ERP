import { describe, expect, it } from 'vitest';
import {
  MissingTenantScopeError,
  currentTenantId,
  currentTenantScope,
  requireTenantId,
  runInTenantScope,
} from '@/lib/infrastructure/db/tenant-scope';

/**
 * The ambient tenant scope.
 *
 * Most of this is the obvious contract. The tests worth reading are the two about
 * lazily executed work, which cover a failure that leaves no trace: a Prisma query
 * is a lazy promise, so a callback that returns one without awaiting it used to be
 * subscribed *after* `storage.run` had returned — outside the store, with no tenant
 * bound. Under `erp_app` the query then returns no rows rather than raising, so the
 * symptom is an empty screen and the cause is the absence of the word `async`.
 *
 * `LazyThenable` stands in for a Prisma query here: nothing runs until something
 * subscribes, and what it records is the scope visible at that moment.
 */

class LazyThenable<T> implements PromiseLike<T> {
  scopeAtSubscription: string | undefined;

  constructor(private readonly value: T) {}

  then<R1 = T, R2 = never>(
    onFulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    // The whole point: the ambient scope is read when the work actually starts.
    this.scopeAtSubscription = currentTenantId();
    return Promise.resolve(this.value).then(onFulfilled, onRejected);
  }
}

const scope = { tenantId: 'tenant-1' };

describe('runInTenantScope', () => {
  it('exposes the tenant inside the callback', () => {
    runInTenantScope(scope, () => {
      expect(currentTenantId()).toBe('tenant-1');
    });
  });

  it('carries the whole scope, not only the tenant', () => {
    runInTenantScope({ tenantId: 't', userId: 'u', correlationId: 'c' }, () => {
      expect(currentTenantScope()).toEqual({ tenantId: 't', userId: 'u', correlationId: 'c' });
    });
  });

  it('returns what the callback returned', () => {
    expect(runInTenantScope(scope, () => 42)).toBe(42);
  });

  it('leaves no scope behind', () => {
    runInTenantScope(scope, () => undefined);

    expect(currentTenantId()).toBeUndefined();
  });

  it('survives an await inside an async callback', async () => {
    const seen = await runInTenantScope(scope, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return currentTenantId();
    });

    expect(seen).toBe('tenant-1');
  });

  it('binds lazily executed work returned from a non-async callback', async () => {
    // The regression this exists for. Before the fix, subscription happened after
    // `storage.run` returned and this was `undefined` — an unscoped query that looks
    // exactly like a scoped one until it silently returns nothing.
    const lazy = new LazyThenable('result');

    await runInTenantScope(scope, () => lazy);

    expect(lazy.scopeAtSubscription).toBe('tenant-1');
  });

  it('binds lazily executed work returned from an async callback too', async () => {
    const lazy = new LazyThenable('result');

    await runInTenantScope(scope, async () => lazy);

    expect(lazy.scopeAtSubscription).toBe('tenant-1');
  });

  it('still resolves to the awaited value', async () => {
    const value = await runInTenantScope(scope, () => new LazyThenable('payload'));

    expect(value).toBe('payload');
  });

  it('propagates a rejection rather than swallowing it', async () => {
    await expect(
      runInTenantScope(scope, () => Promise.reject(new Error('inner failure'))),
    ).rejects.toThrow('inner failure');
  });

  it('nests, with the inner scope winning and the outer restored', () => {
    runInTenantScope({ tenantId: 'outer' }, () => {
      runInTenantScope({ tenantId: 'inner' }, () => {
        expect(currentTenantId()).toBe('inner');
      });

      expect(currentTenantId()).toBe('outer');
    });
  });
});

describe('requireTenantId', () => {
  it('returns the tenant inside a scope', () => {
    expect(runInTenantScope(scope, () => requireTenantId())).toBe('tenant-1');
  });

  it('throws a wiring error outside one, not a domain error', () => {
    // Distinct on purpose: this is never the user's fault and never something a
    // client can trigger, so it should not be shaped like a validation failure.
    expect(() => requireTenantId('Posting an invoice')).toThrow(MissingTenantScopeError);
    expect(() => requireTenantId('Posting an invoice')).toThrow(/Posting an invoice/);
  });
});
