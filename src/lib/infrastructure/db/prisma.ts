import { PrismaClient, Prisma } from '@prisma/client';
import { currentTenantId } from './tenant-scope';

/**
 * The Prisma clients.
 *
 * There are two, and the distinction matters.
 *
 * `base` is an ordinary client. Everything that opens its own transaction —
 * `withTransaction`, `withTenantRead`, and the tenant binding itself — goes
 * through it, so the transaction client handed to a use case has exactly the
 * type it always had.
 *
 * `prisma` is `base` with one extension: any query issued outside a transaction
 * is wrapped in a tiny transaction that binds `erp.tenant_id` first. Without it,
 * a direct `prisma.document.findMany(...)` — which is what every page and every
 * report service does — would carry no tenant, and the row-level security
 * policies from migration 004 would reject every row.
 *
 * The alternative was to convert some seventy call sites to pass a transaction
 * client around. That would have been seventy chances to miss one, and the one
 * missed would be the one that returns an empty screen in production on a
 * Tuesday. Binding at the client is a single place that cannot be forgotten.
 */

function createBaseClient(): PrismaClient {
  const client = new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? [
            { emit: 'event', level: 'query' },
            { emit: 'stdout', level: 'warn' },
            { emit: 'stdout', level: 'error' },
          ]
        : [{ emit: 'stdout', level: 'error' }],
    errorFormat: 'minimal',
  });

  if (process.env.NODE_ENV === 'development') {
    // Surfacing slow queries during development is how an index gets added
    // before the table has ten million rows rather than after.
    client.$on('query' as never, (event: Prisma.QueryEvent) => {
      if (event.duration >= 200) {
        // eslint-disable-next-line no-console
        console.warn(`[prisma] slow query ${event.duration}ms: ${event.query.slice(0, 300)}`);
      }
    });
  }

  return client;
}

/**
 * Wraps every standalone operation in a tenant-bound transaction.
 *
 * `$allOperations` at the top level covers model calls and raw queries alike,
 * which matters because the reporting services are written almost entirely in
 * `$queryRaw` — an extension that only reached the model delegates would leave
 * the reports unprotected while looking complete.
 *
 * The two statements go in a batch transaction so they share one connection:
 * `set_config(..., TRUE)` is transaction-local, and setting it on a connection
 * the query might not be issued on would bind nothing at all.
 *
 * When there is no ambient tenant — migrations, the seed generator, a
 * maintenance script — the query is passed straight through and the connection's
 * own privileges decide what it may see. That is the owner's business, not this
 * layer's.
 */
function createExtendedClient(base: PrismaClient) {
  return base.$extends({
    query: {
      async $allOperations({ args, query }) {
        const tenantId = currentTenantId();

        if (tenantId === undefined) {
          return query(args);
        }

        const [, result] = await base.$transaction([
          base.$executeRaw`SELECT set_config('erp.tenant_id', ${tenantId}::text, TRUE)`,
          // The extension's own typing describes this as a plain promise; the
          // batch form needs the Prisma flavour of one. Same object, narrower
          // declaration.
          query(args) as Prisma.PrismaPromise<unknown>,
        ]);

        return result;
      },
    },
  });
}

type ExtendedPrismaClient = ReturnType<typeof createExtendedClient>;

/**
 * Next.js hot-reloads modules in development, which would otherwise open a new
 * pool on every edit until PostgreSQL refuses connections. Stashing the
 * instances on `globalThis` keeps exactly one pool alive across reloads.
 */
const globalForPrisma = globalThis as unknown as {
  prismaBase: PrismaClient | undefined;
  prisma: ExtendedPrismaClient | undefined;
};

const base: PrismaClient = globalForPrisma.prismaBase ?? createBaseClient();

export const prisma: ExtendedPrismaClient = globalForPrisma.prisma ?? createExtendedClient(base);

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prismaBase = base;
  globalForPrisma.prisma = prisma;
}

/**
 * The transaction-scoped client type.
 *
 * Application services accept this rather than the full `PrismaClient`, which
 * makes it impossible to open a nested transaction by accident and guarantees
 * every write in a use case shares one atomic scope.
 */
export type TransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * A client that can only issue raw queries.
 *
 * Read-only services written entirely in `$queryRaw` — the reports and the
 * search — need to run both inside a transaction and standalone against the
 * extended client. `TransactionClient` cannot express that: it is derived from
 * the unextended `PrismaClient`, so the model delegates it carries are typed
 * against different generic arguments than the extended client's and the two
 * are not assignable. Asking only for `$queryRaw`, which `$extends` leaves
 * untouched, is satisfied by either one and states what these services actually
 * use.
 */
export type RawQueryClient = Pick<TransactionClient, '$queryRaw'>;

export interface TransactionOptions {
  readonly maxRetries?: number;
  readonly timeoutMs?: number;
  /**
   * Tenant to bind the transaction to. Defaults to the ambient tenant scope,
   * which is what every request-driven path uses. Pass it explicitly only where
   * no scope exists — the seed generator and maintenance scripts.
   */
  readonly tenantId?: string;
}

/**
 * Runs `work` inside a serialisable transaction, bound to a tenant.
 *
 * `Serializable` is deliberate for financial writes: stock issues and payment
 * allocations read a balance and then write based on it, which is exactly the
 * read-modify-write that weaker isolation levels permit two sessions to do
 * simultaneously. Serialisation failures are retried — under contention that is
 * expected behaviour, not an error.
 *
 * The first statement in the transaction binds `erp.tenant_id`, so the row-level
 * security policies apply to everything the transaction goes on to do. It is
 * placed here rather than in each use case for the same reason authentication
 * lives in the route wrapper: a control that every caller must remember to
 * invoke is a control that is one day forgotten.
 */
export async function withTransaction<T>(
  work: (tx: TransactionClient) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  // Five, not three. Serialisation failures are not rare events to be tolerated
  // once or twice — under contention on a hot row (a document-number counter,
  // say) a dozen writers can collide in the same instant, and each retry round
  // only thins the field. Too small a budget turns ordinary contention into a
  // user-visible error.
  const maxRetries = options.maxRetries ?? 5;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const tenantId = options.tenantId ?? currentTenantId();

  warnIfUnscoped('withTransaction', tenantId);

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await base.$transaction(
        async (tx) => {
          if (tenantId !== undefined) {
            await setTenantContext(tx, tenantId);
          }
          return work(tx);
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          timeout: timeoutMs,
          maxWait: 5_000,
        },
      );
    } catch (error) {
      lastError = error;
      if (!isRetryableTransactionError(error) || attempt === maxRetries) {
        throw error;
      }
      // Exponential backoff with full jitter, so retrying contenders do not
      // synchronise and collide again at the same instant. Full jitter (rather
      // than a fixed delay plus noise) is what actually decorrelates a thundering
      // herd: the spread grows with the backoff window.
      const ceiling = 2 ** attempt * 20;
      const backoff = 5 + Math.random() * ceiling;
      await sleep(backoff);
    }
  }

  throw lastError;
}

/**
 * Runs several reads under one tenant-bound transaction, without paying for
 * serialisable isolation.
 *
 * A report or a list page reads and does not write, so the anomalies
 * `Serializable` exists to prevent cannot occur — and taking predicate locks for
 * a dashboard would make every write on the system queue behind a chart.
 *
 * The client extension already binds a tenant to standalone queries, so this is
 * not needed for correctness. It is needed for cost: a page that issues eleven
 * queries pays for eleven transactions through the extension and one through
 * here. Group reads that belong to the same screen.
 */
export async function withTenantRead<T>(
  work: (tx: TransactionClient) => Promise<T>,
  options: { tenantId?: string; timeoutMs?: number } = {},
): Promise<T> {
  const tenantId = options.tenantId ?? currentTenantId();

  warnIfUnscoped('withTenantRead', tenantId);

  return base.$transaction(
    async (tx) => {
      if (tenantId !== undefined) {
        await setTenantContext(tx, tenantId);
      }
      return work(tx);
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      timeout: options.timeoutMs ?? 10_000,
      maxWait: 5_000,
    },
  );
}

/**
 * Binds the current tenant to the transaction so the row-level security policies
 * installed by migration 004 take effect.
 *
 * Under the owner role the policies are inert and this costs one round trip —
 * cheap insurance while the deployment still connects as the owner. Under
 * `erp_app` it is the difference between seeing the tenant's rows and seeing
 * none at all.
 */
export async function setTenantContext(tx: TransactionClient, tenantId: string): Promise<void> {
  // Parameterised: `tenantId` never reaches the server as SQL text.
  await tx.$executeRaw`SELECT set_config('erp.tenant_id', ${tenantId}::text, true)`;
}

/**
 * Complains, in development, about a transaction with no tenant bound.
 *
 * Silent in production and in the seed: both have unscoped work that is
 * legitimate. In development it catches the wiring mistake at the moment it is
 * made, rather than after the deployment switches to `erp_app` and every screen
 * empties at once.
 */
function warnIfUnscoped(operation: string, tenantId: string | undefined): void {
  if (tenantId === undefined && process.env.NODE_ENV === 'development') {
    // eslint-disable-next-line no-console
    console.warn(
      `[prisma] ${operation} ran with no tenant scope. Row-level security will ` +
        `reject every row once the application connects as erp_app.`,
    );
  }
}

/** PostgreSQL 40001 (serialisation failure) and 40P01 (deadlock) are transient. */
function isRetryableTransactionError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const pgCode =
      typeof error.meta?.['code'] === 'string' ? (error.meta['code'] as string) : undefined;
    return pgCode === '40001' || pgCode === '40P01' || error.code === 'P2034';
  }
  if (error instanceof Error) {
    return /40001|40P01|could not serialize|deadlock detected/i.test(error.message);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Maps a Prisma/PostgreSQL error to the stable code raised by our triggers. */
export function extractDatabaseErrorCode(error: unknown): string | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = error.meta;
    if (meta !== undefined && typeof meta['code'] === 'string') {
      return meta['code'];
    }
    return error.code;
  }
  if (error instanceof Error) {
    const match = /\b(ERP\d{2})\b/.exec(error.message);
    return match?.[1] ?? null;
  }
  return null;
}

export { Prisma };
