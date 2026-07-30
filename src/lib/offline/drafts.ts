import { DRAFT_STORE, openStore, type KeyValueStore, type StoredRecord } from './store';

/**
 * Form drafts that survive the tab closing.
 *
 * The failure this exists for is mundane and expensive: an accountant fills in a
 * forty-line invoice, the laptop sleeps, the session cookie expires, and the form comes
 * back empty. Nothing was wrong with the software and an hour of work is gone.
 *
 * What is stored is the *form state* — the strings in the fields — not a validated
 * document. A draft is by definition incomplete, so it is kept exactly as typed and
 * revalidated when restored. Storing a normalised object would mean deciding what a
 * half-typed quantity normalises to, which is a decision with no right answer.
 *
 * Deliberately not stored: anything from the reference data behind a picker. A draft
 * holds the product id and the label it displayed, and if that product has since been
 * renamed the restored draft shows a stale label until the field is touched. The
 * alternative is a draft that cannot be restored without a network round trip, which
 * defeats the point of having it offline.
 */

export type DraftKind = 'sales-invoice' | 'journal-entry';

export interface DraftRecord<T = unknown> extends StoredRecord {
  readonly key: string;
  readonly kind: DraftKind;
  readonly updatedAt: number;
  /** The form state, as typed. */
  readonly state: T;
}

/**
 * One draft per form kind.
 *
 * A list of drafts per form would need a picker, a naming convention and a way to
 * decide which is stale — a filing system nobody asked for. One slot answers the only
 * question this feature exists to answer: is there unfinished work to come back to.
 */
function draftKey(kind: DraftKind): string {
  return `draft:${kind}`;
}

/** How long a draft is offered back before it is treated as abandoned. */
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class DraftStore {
  constructor(private readonly store: KeyValueStore<DraftRecord> = openStore(DRAFT_STORE)) {}

  async save<T>(kind: DraftKind, state: T): Promise<void> {
    await this.store.put({ key: draftKey(kind), kind, updatedAt: Date.now(), state });
  }

  /**
   * The draft for a form, or `undefined` when there is none or it has expired.
   *
   * An expired draft is deleted on the way past rather than merely hidden: leaving it
   * makes the store grow with work nobody is coming back to, and offering a three-week-old
   * invoice draft is more confusing than offering nothing.
   */
  async load<T>(kind: DraftKind, now: number = Date.now()): Promise<DraftRecord<T> | undefined> {
    const record = await this.store.get(draftKey(kind));
    if (record === undefined) return undefined;

    if (now - record.updatedAt > DRAFT_TTL_MS) {
      await this.store.delete(record.key);
      return undefined;
    }

    return record as DraftRecord<T>;
  }

  async discard(kind: DraftKind): Promise<void> {
    await this.store.delete(draftKey(kind));
  }

  /** Every live draft, newest first — for a "you have unfinished work" surface. */
  async list(now: number = Date.now()): Promise<DraftRecord[]> {
    const records = await this.store.all();
    const live = records.filter((record) => now - record.updatedAt <= DRAFT_TTL_MS);

    await Promise.all(
      records
        .filter((record) => !live.includes(record))
        .map((record) => this.store.delete(record.key)),
    );

    return live.reverse();
  }
}

/** The page-wide draft store. */
export const drafts = new DraftStore();
