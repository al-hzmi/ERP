import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DraftStore, DRAFT_TTL_MS, type DraftRecord } from '@/lib/offline/drafts';
import {
  MAX_ATTEMPTS,
  SubmissionQueue,
  type PendingSubmission,
  type SendOutcome,
} from '@/lib/offline/queue';
import { MemoryStore } from '@/lib/offline/store';

/**
 * Offline drafts and the submission queue.
 *
 * The queue is the part worth testing hardest, because getting it wrong duplicates
 * financial records. Its contract is narrower than "retry until it works":
 *
 *   - oldest first, because documents are numbered in the order they are accepted;
 *   - stop at the first thing that could not be delivered, rather than skipping past it
 *     and silently reordering the rest;
 *   - a refusal is not a retry — the server understood and said no;
 *   - one idempotency key per submission, reused on every attempt, because that is the
 *     only thing that makes a retry safe when the truth is "it worked and the reply was
 *     lost".
 *
 * `MemoryStore` stands in for IndexedDB. The logic under test does not know the
 * difference, which is why the seam exists.
 */

describe('DraftStore', () => {
  let store: MemoryStore<DraftRecord>;
  let drafts: DraftStore;

  beforeEach(() => {
    store = new MemoryStore<DraftRecord>();
    drafts = new DraftStore(store);
  });

  it('returns nothing when no draft was saved', async () => {
    expect(await drafts.load('sales-invoice')).toBeUndefined();
  });

  it('round-trips form state exactly as given', async () => {
    // Stored as typed, half-finished values included: normalising here would mean
    // deciding what "12." becomes, which has no right answer.
    const state = { customer: 'c-1', lines: [{ quantity: '12.', price: '' }] };
    await drafts.save('sales-invoice', state);

    const recovered = await drafts.load<typeof state>('sales-invoice');

    expect(recovered?.state).toEqual(state);
  });

  it('keeps one draft per form kind, independently', async () => {
    await drafts.save('sales-invoice', { a: 1 });
    await drafts.save('journal-entry', { b: 2 });

    expect((await drafts.load<{ a: number }>('sales-invoice'))?.state).toEqual({ a: 1 });
    expect((await drafts.load<{ b: number }>('journal-entry'))?.state).toEqual({ b: 2 });
  });

  it('overwrites rather than accumulating', async () => {
    await drafts.save('sales-invoice', { version: 1 });
    await drafts.save('sales-invoice', { version: 2 });

    expect((await drafts.load<{ version: number }>('sales-invoice'))?.state).toEqual({
      version: 2,
    });
    expect(await store.all()).toHaveLength(1);
  });

  it('forgets a draft once discarded', async () => {
    await drafts.save('sales-invoice', { a: 1 });
    await drafts.discard('sales-invoice');

    expect(await drafts.load('sales-invoice')).toBeUndefined();
  });

  it('does not offer back a draft older than the retention window', async () => {
    await drafts.save('sales-invoice', { a: 1 });

    const wellPast = Date.now() + DRAFT_TTL_MS + 1;

    expect(await drafts.load('sales-invoice', wellPast)).toBeUndefined();
  });

  it('deletes an expired draft rather than merely hiding it', async () => {
    await drafts.save('sales-invoice', { a: 1 });
    await drafts.load('sales-invoice', Date.now() + DRAFT_TTL_MS + 1);

    // Left behind, the store grows with work nobody is coming back to.
    expect(await store.all()).toHaveLength(0);
  });

  it('still offers a draft just inside the window', async () => {
    await drafts.save('sales-invoice', { a: 1 });

    expect(await drafts.load('sales-invoice', Date.now() + DRAFT_TTL_MS - 1000)).toBeDefined();
  });

  it('lists live drafts newest first', async () => {
    await drafts.save('sales-invoice', { a: 1 });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await drafts.save('journal-entry', { b: 2 });

    const listed = await drafts.list();

    expect(listed.map((record) => record.kind)).toEqual(['journal-entry', 'sales-invoice']);
  });
});

describe('SubmissionQueue', () => {
  let store: MemoryStore<PendingSubmission>;
  let queue: SubmissionQueue;

  beforeEach(() => {
    store = new MemoryStore<PendingSubmission>();
    queue = new SubmissionQueue(store);
  });

  const accepted: SendOutcome = { status: 'accepted' };
  const unreachable: SendOutcome = { status: 'unreachable' };
  const refused: SendOutcome = {
    status: 'refused',
    code: 'PERIOD_CLOSED',
    messageAr: 'الفترة مقفلة',
  };

  it('gives every submission its own idempotency key', async () => {
    const first = await queue.enqueue('sales-invoice', '/api/sales/invoices', { a: 1 });
    const second = await queue.enqueue('sales-invoice', '/api/sales/invoices', { a: 1 });

    // Identical payloads, different keys. Two invoices for the same customer on the same
    // day for the same amount are a legitimate pair, and only the client knows that.
    expect(first).not.toBe(second);
  });

  it('sends the same key on every attempt', async () => {
    const key = await queue.enqueue('sales-invoice', '/api/sales/invoices', { a: 1 });
    const keysSeen: string[] = [];

    const send = vi.fn(async (submission: PendingSubmission): Promise<SendOutcome> => {
      keysSeen.push(submission.key);
      return unreachable;
    });

    await queue.flush(send);
    await queue.flush(send);

    // The whole safety argument rests on this: a retry under a *new* key is a second
    // invoice, not a retry.
    expect(keysSeen).toEqual([key, key]);
  });

  it('removes a submission the server accepted', async () => {
    await queue.enqueue('sales-invoice', '/api/sales/invoices', { a: 1 });

    const report = await queue.flush(async () => accepted);

    expect(report.sent).toBe(1);
    expect(await queue.pending()).toHaveLength(0);
  });

  it('replays in the order the submissions were made', async () => {
    await queue.enqueue('sales-invoice', '/api/sales/invoices', { n: 1 });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await queue.enqueue('sales-invoice', '/api/sales/invoices', { n: 2 });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await queue.enqueue('sales-invoice', '/api/sales/invoices', { n: 3 });

    const order: number[] = [];
    await queue.flush(async (submission) => {
      order.push((submission.payload as { n: number }).n);
      return accepted;
    });

    // Document numbers are allocated in acceptance order, so replaying out of order
    // produces a register whose numbering disagrees with its own dates.
    expect(order).toEqual([1, 2, 3]);
  });

  it('stops at the first undelivered submission instead of skipping it', async () => {
    await queue.enqueue('sales-invoice', '/api/sales/invoices', { n: 1 });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await queue.enqueue('sales-invoice', '/api/sales/invoices', { n: 2 });

    const attempted: number[] = [];
    const report = await queue.flush(async (submission) => {
      attempted.push((submission.payload as { n: number }).n);
      return unreachable;
    });

    // Only the first was tried. Reaching past it would send #2 before #1.
    expect(attempted).toEqual([1]);
    expect(report.halted).toBe(true);
    expect(report.remaining).toBe(2);
  });

  it('counts an attempt against a submission that could not be delivered', async () => {
    await queue.enqueue('sales-invoice', '/api/sales/invoices', { a: 1 });

    await queue.flush(async () => unreachable);
    await queue.flush(async () => unreachable);

    expect((await queue.pending())[0]?.attempts).toBe(2);
  });

  it('keeps a refused submission, with the reason attached', async () => {
    await queue.enqueue('sales-invoice', '/api/sales/invoices', { a: 1 });

    const report = await queue.flush(async () => refused);

    expect(report.refused).toBe(1);
    const [entry] = await queue.pending();
    // Deleting it would make the user's work vanish with only a toast to explain it.
    expect(entry?.failure).toEqual({ code: 'PERIOD_CLOSED', messageAr: 'الفترة مقفلة' });
  });

  it('does not retry a refusal, and does not let it block the queue', async () => {
    await queue.enqueue('sales-invoice', '/api/sales/invoices', { n: 1 });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await queue.enqueue('sales-invoice', '/api/sales/invoices', { n: 2 });

    await queue.flush(async (submission) =>
      (submission.payload as { n: number }).n === 1 ? refused : accepted,
    );

    const attempted: number[] = [];
    await queue.flush(async (submission) => {
      attempted.push((submission.payload as { n: number }).n);
      return accepted;
    });

    // #1 stays parked and is not retried; #2 went through on the first pass rather than
    // being held up behind it.
    expect(attempted).toEqual([]);
    expect((await queue.pending()).map((entry) => (entry.payload as { n: number }).n)).toEqual([1]);
  });

  it('gives up after the attempt limit rather than retrying forever', async () => {
    await queue.enqueue('sales-invoice', '/api/sales/invoices', { a: 1 });

    for (let i = 0; i < MAX_ATTEMPTS + 3; i += 1) {
      await queue.flush(async () => unreachable);
    }

    const [entry] = await queue.pending();
    expect(entry?.attempts).toBe(MAX_ATTEMPTS);
  });

  it('reports a submission that has stopped retrying as stuck', async () => {
    await queue.enqueue('sales-invoice', '/api/sales/invoices', { a: 1 });
    await queue.flush(async () => refused);

    expect(await queue.stuck()).toHaveLength(1);
  });

  it('does not report a submission still being retried as stuck', async () => {
    await queue.enqueue('sales-invoice', '/api/sales/invoices', { a: 1 });
    await queue.flush(async () => unreachable);

    expect(await queue.stuck()).toHaveLength(0);
  });

  it('discards a submission on request', async () => {
    const key = await queue.enqueue('sales-invoice', '/api/sales/invoices', { a: 1 });

    await queue.discard(key);

    expect(await queue.pending()).toHaveLength(0);
  });

  it('reports an empty flush without calling the sender', async () => {
    const send = vi.fn(async () => accepted);

    const report = await queue.flush(send);

    expect(send).not.toHaveBeenCalled();
    expect(report).toEqual({ sent: 0, refused: 0, remaining: 0, halted: false });
  });

  it('drains a mixed queue over successive flushes', async () => {
    await queue.enqueue('sales-invoice', '/api/sales/invoices', { n: 1 });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await queue.enqueue('journal-entry', '/api/finance/journals', { n: 2 });

    // First pass: still offline.
    expect((await queue.flush(async () => unreachable)).sent).toBe(0);

    // Connection returns.
    const second = await queue.flush(async () => accepted);

    expect(second.sent).toBe(2);
    expect(second.remaining).toBe(0);
  });
});

describe('MemoryStore', () => {
  it('iterates oldest first, which is what the queue depends on', async () => {
    const store = new MemoryStore<PendingSubmission>();

    await store.put({
      key: 'b',
      kind: 'sales-invoice',
      url: '/x',
      payload: {},
      createdAt: 2,
      updatedAt: 2,
      attempts: 0,
    });
    await store.put({
      key: 'a',
      kind: 'sales-invoice',
      url: '/x',
      payload: {},
      createdAt: 1,
      updatedAt: 1,
      attempts: 0,
    });

    expect((await store.all()).map((record) => record.key)).toEqual(['a', 'b']);
  });
});
