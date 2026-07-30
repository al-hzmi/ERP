'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { drafts, type DraftKind } from './drafts';
import { submissionQueue, type PendingSubmission } from './queue';
import { flushQueue } from './sync';
import { isPersistenceAvailable } from './store';

/**
 * Whether the browser thinks it is online.
 *
 * `navigator.onLine` is worth exactly what it claims and no more: it reports whether
 * there is a network interface, not whether this server is reachable. A captive portal
 * reads as online. So this drives the *hint* — the banner, the "will be sent when you
 * reconnect" wording — while the actual decision about a submission is made by whether
 * the request succeeded. Anything else trusts a signal that is routinely wrong.
 */
export function useOnlineStatus(): boolean {
  // Starts optimistic. Rendering "offline" during hydration and correcting a frame later
  // is a flash of bad news on every page load.
  const [online, setOnline] = useState(true);

  useEffect(() => {
    setOnline(navigator.onLine);

    const goOnline = (): void => setOnline(true);
    const goOffline = (): void => setOnline(false);

    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);

    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  return online;
}

export interface DraftAutosave<T> {
  /** A draft found on mount, offered back rather than applied. */
  readonly recovered: { state: T; updatedAt: number } | null;
  /** Accepts the recovered draft. The caller applies the state to its own fields. */
  readonly dismissRecovered: () => void;
  readonly discard: () => void;
  readonly savedAt: number | null;
  /** False when this browser cannot persist, so the UI can avoid over-promising. */
  readonly durable: boolean;
}

/**
 * Saves form state as it changes, and offers back whatever was there on arrival.
 *
 * Two behaviours that are easy to get wrong:
 *
 * **The recovered draft is offered, never applied.** Silently filling a form from
 * storage means a user who came to raise a *new* invoice starts editing an old one
 * without being told. Offering it makes the choice theirs.
 *
 * **Saving is debounced and skips the first render.** Without the skip, mounting the
 * form immediately overwrites the stored draft with the empty initial state — deleting
 * the very thing the user came back for, before they could be asked about it.
 */
export function useDraftAutosave<T>(
  kind: DraftKind,
  state: T,
  options: { enabled?: boolean; debounceMs?: number } = {},
): DraftAutosave<T> {
  const { enabled = true, debounceMs = 800 } = options;

  const [recovered, setRecovered] = useState<{ state: T; updatedAt: number } | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const loaded = useRef(false);

  useEffect(() => {
    let cancelled = false;

    void drafts.load<T>(kind).then((record) => {
      if (cancelled) return;
      if (record !== undefined) {
        setRecovered({ state: record.state, updatedAt: record.updatedAt });
      }
      // Set only after the load resolves, so a save cannot race ahead of the read and
      // clobber the draft it was about to offer.
      loaded.current = true;
    });

    return () => {
      cancelled = true;
    };
  }, [kind]);

  useEffect(() => {
    if (!enabled || !loaded.current) return;

    const timer = setTimeout(() => {
      void drafts.save(kind, state).then(() => setSavedAt(Date.now()));
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [kind, state, enabled, debounceMs]);

  const discard = useCallback(() => {
    void drafts.discard(kind).then(() => setSavedAt(null));
  }, [kind]);

  return {
    recovered,
    dismissRecovered: () => setRecovered(null),
    discard,
    savedAt,
    durable: isPersistenceAvailable(),
  };
}

export interface QueueState {
  readonly pending: readonly PendingSubmission[];
  readonly flushing: boolean;
  readonly refresh: () => void;
  readonly flush: () => void;
  readonly discard: (key: string) => void;
}

/**
 * The submission queue, and a flush on reconnect.
 *
 * The flush is triggered by the `online` event rather than polled, because the event is
 * the only moment the browser actually knows something changed. It is also triggered
 * once on mount: a tab opened after a reload may already have a queue from the previous
 * session, and nothing else would ever send it.
 */
export function useSubmissionQueue(): QueueState {
  const [pending, setPending] = useState<readonly PendingSubmission[]>([]);
  const [flushing, setFlushing] = useState(false);
  const inFlight = useRef(false);

  const refresh = useCallback(() => {
    void submissionQueue.pending().then(setPending);
  }, []);

  const flush = useCallback(() => {
    // Guarded because `online` can fire more than once in quick succession, and two
    // concurrent flushes would both read the same queue and race on its entries.
    if (inFlight.current) return;
    inFlight.current = true;
    setFlushing(true);

    void flushQueue()
      .then(() => submissionQueue.pending())
      .then(setPending)
      .finally(() => {
        inFlight.current = false;
        setFlushing(false);
      });
  }, []);

  useEffect(() => {
    refresh();
    if (navigator.onLine) flush();

    const onOnline = (): void => flush();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [refresh, flush]);

  return {
    pending,
    flushing,
    refresh,
    flush,
    discard: (key: string) => {
      void submissionQueue.discard(key).then(refresh);
    },
  };
}
