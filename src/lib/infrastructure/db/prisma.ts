import { PrismaClient, Prisma } from '@prisma/client';

/**
 * The Prisma client singleton.
 *
 * Next.js hot-reloads modules in development, which would otherwise open a new
 * pool on every edit until PostgreSQL refuses connections. Stashing the instance
 * on `globalThis` keeps exactly one pool alive across reloads.
 */

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createClient(): PrismaClient {
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

export const prisma: PrismaClient = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== 'production') {
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
 * Runs `work` inside a serialisable transaction.
 *
 * `Serializable` is deliberate for financial writes: stock issues and payment
 * allocations read a balance and then write based on it, which is exactly the
 * read-modify-write that weaker isolation levels permit two sessions to do
 * simultaneously. Serialisation failures are retried — under contention that is
 * expected behaviour, not an error.
 */
export async function withTransaction<T>(
  work: (tx: TransactionClient) => Promise<T>,
  options: { maxRetries?: number; timeoutMs?: number } = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const timeoutMs = options.timeoutMs ?? 15_000;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await prisma.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: timeoutMs,
        maxWait: 5_000,
      });
    } catch (error) {
      lastError = error;
      if (!isRetryableTransactionError(error) || attempt === maxRetries) {
        throw error;
      }
      // Exponential backoff with jitter, so retrying contenders do not
      // synchronise and collide again at the same instant.
      const backoff = 2 ** attempt * 25 + Math.random() * 25;
      await sleep(backoff);
    }
  }

  throw lastError;
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

/**
 * Binds the current tenant to the session so the row-level security policies
 * installed by migration 002 take effect.
 *
 * Called at the start of every transaction that runs under a non-owner database
 * role. Under the owner role the policies are inert and this is a no-op that
 * costs one round trip — cheap insurance against a missing WHERE clause.
 */
export async function setTenantContext(tx: TransactionClient, tenantId: string): Promise<void> {
  // Parameterised: `tenantId` never reaches the server as SQL text.
  await tx.$executeRaw`SELECT set_config('erp.tenant_id', ${tenantId}::text, true)`;
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
