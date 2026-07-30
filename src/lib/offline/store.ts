/**
 * The storage seam under offline mode.
 *
 * Everything above this file — drafts, the submission queue — is ordinary logic over
 * a key/value store with sorted iteration. IndexedDB is one implementation of that; a
 * `Map` is another. Splitting them is what lets the interesting behaviour (which draft
 * wins, when a queued submission is retried, what happens to a poisoned entry) be
 * tested exhaustively in milliseconds instead of against a browser database with an
 * event-based API and no `await`.
 *
 * It is not an abstraction for its own sake. IndexedDB's own API is callback-shaped and
 * transaction-scoped in a way that makes every call site verbose; wrapping it once is
 * work that has to happen regardless.
 */

export interface StoredRecord {
  readonly key: string;
  /** Insertion or last-update time, in epoch milliseconds. Iteration is ordered by it. */
  readonly updatedAt: number;
}

export interface KeyValueStore<T extends StoredRecord> {
  get(key: string): Promise<T | undefined>;
  put(record: T): Promise<void>;
  delete(key: string): Promise<void>;
  /** Every record, oldest first. */
  all(): Promise<T[]>;
  clear(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// In memory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The store used by tests, and the fallback when IndexedDB is unavailable.
 *
 * Unavailable is not hypothetical: Safari in private browsing has historically thrown
 * on `indexedDB.open`, and a server-side render has no `indexedDB` at all. A form that
 * threw during auto-save would be worse than one that quietly kept its drafts in
 * memory for the life of the tab.
 */
export class MemoryStore<T extends StoredRecord> implements KeyValueStore<T> {
  private readonly records = new Map<string, T>();

  async get(key: string): Promise<T | undefined> {
    return this.records.get(key);
  }

  async put(record: T): Promise<void> {
    this.records.set(record.key, record);
  }

  async delete(key: string): Promise<void> {
    this.records.delete(key);
  }

  async all(): Promise<T[]> {
    return [...this.records.values()].sort((left, right) => left.updatedAt - right.updatedAt);
  }

  async clear(): Promise<void> {
    this.records.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// IndexedDB
// ─────────────────────────────────────────────────────────────────────────────

const DATABASE_NAME = 'erp-offline';
const DATABASE_VERSION = 1;

export const DRAFT_STORE = 'drafts';
export const QUEUE_STORE = 'queue';

const OBJECT_STORES = [DRAFT_STORE, QUEUE_STORE] as const;

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/** One connection per page, opened lazily and shared. */
let connection: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (connection !== null) return connection;

  connection = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      for (const name of OBJECT_STORES) {
        if (!database.objectStoreNames.contains(name)) {
          // `updatedAt` is indexed because both stores are read in time order — the
          // queue oldest-first so submissions replay in the order they were made,
          // and drafts newest-first so the most recent is offered back.
          const store = database.createObjectStore(name, { keyPath: 'key' });
          store.createIndex('updatedAt', 'updatedAt');
        }
      }
    };

    request.onsuccess = () => {
      const database = request.result;
      // A version change from another tab invalidates this handle. Closing and
      // forgetting it means the next call reopens rather than failing forever.
      database.onversionchange = () => {
        database.close();
        connection = null;
      };
      resolve(database);
    };

    request.onerror = () => reject(request.error ?? new Error('Could not open IndexedDB'));
    request.onblocked = () => reject(new Error('IndexedDB open blocked by another tab'));
  });

  // A rejected connection must not be cached, or one transient failure disables
  // offline mode for the rest of the session.
  connection.catch(() => {
    connection = null;
  });

  return connection;
}

class IndexedDbStore<T extends StoredRecord> implements KeyValueStore<T> {
  constructor(private readonly storeName: string) {}

  private async transaction(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const database = await openDatabase();
    return database.transaction(this.storeName, mode).objectStore(this.storeName);
  }

  async get(key: string): Promise<T | undefined> {
    const store = await this.transaction('readonly');
    return (await promisify(store.get(key))) as T | undefined;
  }

  async put(record: T): Promise<void> {
    const store = await this.transaction('readwrite');
    await promisify(store.put(record));
  }

  async delete(key: string): Promise<void> {
    const store = await this.transaction('readwrite');
    await promisify(store.delete(key));
  }

  async all(): Promise<T[]> {
    const store = await this.transaction('readonly');
    // Read through the index so the order is the database's rather than one this
    // code sorts afterwards.
    const records = (await promisify(store.index('updatedAt').getAll())) as T[];
    return records;
  }

  async clear(): Promise<void> {
    const store = await this.transaction('readwrite');
    await promisify(store.clear());
  }
}

/** True when this environment can actually persist. */
export function isPersistenceAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

/**
 * A store backed by IndexedDB, or by memory when IndexedDB is missing.
 *
 * The fallback is silent by design at this level; the caller that cares — the auto-save
 * indicator — asks `isPersistenceAvailable()` so it can say "this tab only" rather than
 * promising a durability it does not have.
 */
export function openStore<T extends StoredRecord>(storeName: string): KeyValueStore<T> {
  if (!isPersistenceAvailable()) return new MemoryStore<T>();
  return new IndexedDbStore<T>(storeName);
}
