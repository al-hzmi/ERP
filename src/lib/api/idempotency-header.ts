/**
 * The header name, alone in its own module.
 *
 * Both sides need this string and only this string. `idempotency.ts` pulls in Prisma and
 * `node:crypto`, so a client component importing the constant from there would drag the
 * server into the browser bundle — which Next.js refuses to build, and rightly.
 */
export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

/** Long enough for a uuid with room to spare, short enough to index. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 64;
