import { QUEUE_STORE, openStore, type KeyValueStore, type StoredRecord } from './store';

/**
 * Submissions made while offline, replayed when the connection returns.
 *
 * This is the dangerous half of offline mode, and the danger is specific: replaying a
 * `POST /api/sales/invoices` twice creates two invoices, each consuming a document
 * number, each posting to the ledger. "Probably delivered" is an acceptable answer for a
 * chat message and an unacceptable one for an invoice.
 *
 * So every queued submission carries an **idempotency key**, generated once when it is
 * enqueued and reused on every attempt. The server records the first outcome against
 * that key and returns it verbatim for any repeat, which makes a retry safe whether the
 * original request never arrived, arrived and its response was lost, or arrived twice.
 * Without that key this queue would be a mechanism for duplicating financial records,
 * and it would fail exactly when the network was worst.
 *
 * Two ordering decisions follow from the same concern:
 *
 *   - **Oldest first.** Documents are numbered in the order they are accepted, so
 *     replaying out of order produces a register whose numbering disagrees with its
 *     own dates.
 *   - **Stop at the first transient failure.** Skipping past a submission that could
 *     not be delivered and sending the next one reorders them silently. A queue that
 *     halts is visible; a queue that reorders is not.
 */

export type SubmissionKind = 'sales-invoice' | 'journal-entry';

export interface PendingSubmission extends StoredRecord {
  /** The idempotency key. Generated once, sent on every attempt. */
  readonly key: string;
  readonly kind: SubmissionKind;
  readonly url: string;
  readonly payload: unknown;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly attempts: number;
  /**
   * Set when the server refused this submission outright. The entry is kept so the user
   * can see *what* was rejected rather than being told a number they cannot inspect.
   */
  readonly failure?: { code: string; messageAr: string };
}

/** Attempts before a submission stops being retried and waits for a human. */
export const MAX_ATTEMPTS = 5;

export type SendOutcome =
  /**
   * Accepted, or already accepted under this key. Either way it is done.
   *
   * `data` carries the response envelope's payload so a caller submitting interactively
   * gets the document number back without a second request. A background flush ignores
   * it — there is no longer a form waiting for the answer.
   */
  | { status: 'accepted'; data?: unknown }
  /** Refused on its merits — a validation error, a closed period. Retrying cannot help. */
  | { status: 'refused'; code: string; messageAr: string }
  /** Could not be delivered, or the server failed. Worth retrying. */
  | { status: 'unreachable' };

export type Sender = (submission: PendingSubmission) => Promise<SendOutcome>;

export interface FlushReport {
  readonly sent: number;
  readonly refused: number;
  readonly remaining: number;
  /** True when the flush stopped early because the network was still down. */
  readonly halted: boolean;
}

function newIdempotencyKey(): string {
  // `randomUUID` is available in every browser that has service workers, which is the
  // same set that can be offline-capable at all.
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export class SubmissionQueue {
  constructor(
    private readonly store: KeyValueStore<PendingSubmission> = openStore(QUEUE_STORE),
  ) {}

  /** Queues a submission and returns the idempotency key it will be sent under. */
  async enqueue(kind: SubmissionKind, url: string, payload: unknown): Promise<string> {
    const key = newIdempotencyKey();
    const now = Date.now();

    await this.store.put({
      key,
      kind,
      url,
      payload,
      createdAt: now,
      updatedAt: now,
      attempts: 0,
    });

    return key;
  }

  async pending(): Promise<PendingSubmission[]> {
    return this.store.all();
  }

  /** Submissions that will not be retried again without intervention. */
  async stuck(): Promise<PendingSubmission[]> {
    const all = await this.store.all();
    return all.filter(
      (entry) => entry.failure !== undefined || entry.attempts >= MAX_ATTEMPTS,
    );
  }

  async discard(key: string): Promise<void> {
    await this.store.delete(key);
  }

  /**
   * Replays the queue.
   *
   * `send` is injected rather than reaching for `fetch` here, which is what lets the
   * ordering and give-up behaviour be tested without a network.
   */
  async flush(send: Sender): Promise<FlushReport> {
    const queued = await this.store.all();

    let sent = 0;
    let refused = 0;
    let halted = false;

    for (const submission of queued) {
      // A submission already parked for a human is skipped, not retried. It is not in
      // the way of the ones behind it: it has already had its outcome decided.
      if (submission.failure !== undefined || submission.attempts >= MAX_ATTEMPTS) continue;

      const outcome = await send(submission);

      if (outcome.status === 'accepted') {
        await this.store.delete(submission.key);
        sent += 1;
        continue;
      }

      if (outcome.status === 'refused') {
        // Kept rather than deleted, with the reason attached. Deleting it would mean
        // the user's work vanished and the only trace was a toast they may not have
        // been looking at.
        await this.store.put({
          ...submission,
          updatedAt: Date.now(),
          attempts: submission.attempts + 1,
          failure: { code: outcome.code, messageAr: outcome.messageAr },
        });
        refused += 1;
        continue;
      }

      await this.store.put({
        ...submission,
        updatedAt: Date.now(),
        attempts: submission.attempts + 1,
      });

      // Still offline. Stop here rather than trying the rest, so the queue keeps the
      // order the user created it in.
      halted = true;
      break;
    }

    const remaining = (await this.store.all()).length;
    return { sent, refused, remaining, halted };
  }
}

export const submissionQueue = new SubmissionQueue();
