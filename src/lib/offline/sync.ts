import { IDEMPOTENCY_HEADER } from '@/lib/api/idempotency-header';
import type { PendingSubmission, SendOutcome } from './queue';
import { submissionQueue } from './queue';

/**
 * Delivering a queued submission.
 *
 * The key question is which failures are worth retrying, and the answer is not "all of
 * them". A 422 means the server understood and refused — a closed fiscal period, an
 * inactive product — and retrying that forever is a queue that never drains while
 * telling the user it is working. A 503 or a dropped connection is the opposite: the
 * request never got a verdict, so retrying is the only way to get one.
 *
 * 429 sits with the transient ones. The server is asking for a delay, not refusing the
 * content.
 *
 * Every attempt carries the same `Idempotency-Key`, which is what makes "retry" safe
 * when the truth is "it worked and the reply was lost". The server replays its recorded
 * outcome, so the second attempt is accepted without creating a second document.
 */
export async function sendSubmission(submission: PendingSubmission): Promise<SendOutcome> {
  let response: Response;

  try {
    response = await fetch(submission.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [IDEMPOTENCY_HEADER]: submission.key,
      },
      body: JSON.stringify(submission.payload),
    });
  } catch {
    return { status: 'unreachable' };
  }

  if (response.ok) {
    // Parsed here rather than by a second request: the envelope is already in hand, and
    // re-sending to read it would be a wasted round trip on every submission.
    try {
      const body = (await response.json()) as { data?: unknown };
      return { status: 'accepted', data: body.data };
    } catch {
      return { status: 'accepted' };
    }
  }

  if (response.status >= 500 || response.status === 429) {
    return { status: 'unreachable' };
  }

  // A refusal, and the envelope carries a message meant for a person. Losing it here
  // would leave the user with a failed submission and no way to learn why.
  let code = `HTTP_${response.status}`;
  let messageAr = 'رفض الخادم هذا الطلب.';

  try {
    const body = (await response.json()) as {
      error?: { code?: string; messageAr?: string };
    };
    code = body.error?.code ?? code;
    messageAr = body.error?.messageAr ?? messageAr;
  } catch {
    // Keep the defaults. A non-JSON 4xx is unusual but not a reason to reclassify a
    // refusal as retryable.
  }

  return { status: 'refused', code, messageAr };
}

/** Replays everything queued, using the real network. */
export function flushQueue(): ReturnType<typeof submissionQueue.flush> {
  return submissionQueue.flush(sendSubmission);
}

/**
 * Submits now if online, queues if not.
 *
 * The distinction the caller needs back is not success versus failure but *where the
 * work went*: an accepted invoice has a number to show, a queued one has nothing yet and
 * the UI has to say so rather than implying it was filed.
 */
export async function submitOrQueue<T>(
  kind: PendingSubmission['kind'],
  url: string,
  payload: unknown,
): Promise<
  | { outcome: 'accepted'; data: T }
  | { outcome: 'queued'; key: string }
  | { outcome: 'refused'; code: string; messageAr: string }
> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    const key = await submissionQueue.enqueue(kind, url, payload);
    return { outcome: 'queued', key };
  }

  // Enqueued *before* the attempt, deliberately. If the tab closes or the network drops
  // between sending and receiving, the submission is already recorded under a key — and
  // because the key is the same one the server saw, replaying it cannot duplicate the
  // document. Sending first and queueing on failure would lose exactly the submission
  // whose fate is unknown, which is the only one that matters.
  const key = await submissionQueue.enqueue(kind, url, payload);
  const submission = (await submissionQueue.pending()).find((entry) => entry.key === key);

  if (submission === undefined) {
    // The store is unavailable — memory fallback in a context that lost it. Send
    // unkeyed rather than refusing to submit at all.
    return sendUnkeyed<T>(url, payload);
  }

  const result = await sendSubmission(submission);

  if (result.status === 'accepted') {
    await submissionQueue.discard(key);
    return { outcome: 'accepted', data: result.data as T };
  }

  if (result.status === 'refused') {
    await submissionQueue.discard(key);
    return { outcome: 'refused', code: result.code, messageAr: result.messageAr };
  }

  // Unreachable: it stays queued for the reconnect flush.
  return { outcome: 'queued', key };
}

async function sendUnkeyed<T>(
  url: string,
  payload: unknown,
): Promise<
  { outcome: 'accepted'; data: T } | { outcome: 'refused'; code: string; messageAr: string }
> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = (await response.json()) as {
      success: boolean;
      data?: T;
      error?: { code?: string; messageAr?: string };
    };

    if (response.ok && body.data !== undefined) return { outcome: 'accepted', data: body.data };

    return {
      outcome: 'refused',
      code: body.error?.code ?? `HTTP_${response.status}`,
      messageAr: body.error?.messageAr ?? 'رفض الخادم هذا الطلب.',
    };
  } catch {
    return {
      outcome: 'refused',
      code: 'NETWORK_ERROR',
      messageAr: 'تعذّر الوصول إلى الخادم.',
    };
  }
}
