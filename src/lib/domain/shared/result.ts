import type { DomainError } from './errors';

/**
 * An explicit success/failure channel.
 *
 * Expected business outcomes — "this invoice is already posted", "stock is
 * insufficient" — are values, not exceptions. Reserving `throw` for genuine
 * defects means a `catch` block always signals a bug, and the type checker can
 * prove every business failure has been considered.
 */
export type Result<T, E = DomainError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok(): Result<void, never>;
export function ok<T>(value: T): Result<T, never>;
export function ok<T>(value?: T): Result<T | undefined, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is { ok: true; value: T } {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is { ok: false; error: E } {
  return !result.ok;
}

/** Applies `fn` to a success value, passing failures through untouched. */
export function map<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

/** Chains a fallible step; the first failure short-circuits the rest. */
export function andThen<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>,
): Result<U, E> {
  return result.ok ? fn(result.value) : result;
}

/**
 * Collapses a list of results into a result of a list, failing on the first error.
 * Used wherever a batch — invoice lines, journal lines — must validate as a whole.
 */
export function all<T, E>(results: readonly Result<T, E>[]): Result<T[], E> {
  const values: T[] = [];
  for (const result of results) {
    if (!result.ok) return result;
    values.push(result.value);
  }
  return ok(values);
}

/**
 * Collects *every* failure rather than stopping at the first.
 * Form validation wants all the problems at once, not one per round trip.
 */
export function allSettled<T, E>(results: readonly Result<T, E>[]): Result<T[], E[]> {
  const values: T[] = [];
  const errors: E[] = [];
  for (const result of results) {
    if (result.ok) values.push(result.value);
    else errors.push(result.error);
  }
  return errors.length > 0 ? err(errors) : ok(values);
}

/** Unwraps a success or throws. Only valid where failure is genuinely impossible. */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(
      `Called unwrap on a failed Result: ${JSON.stringify(result.error)}`,
    );
  }
  return result.value;
}

export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}
