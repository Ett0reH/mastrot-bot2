// DocumentStore su Firestore (firebase-admin, solo lato server: le regole negano i client, F1).
//
// Ogni documento è salvato come `{ payload: <JSON>, ...campi indice }`: il JSON evita i limiti
// del modello dati di Firestore (array annidati, undefined, chiavi particolari) e i campi indice
// servono alle query (es. lo stato degli ordini). Limite di Firestore: 1 MiB per documento.
import type { DocumentStore, Filter } from './documentStore';
import { StoreUnavailableError } from './documentStore';

/** Il sottoinsieme dell'API Firestore di firebase-admin usato qui. */
export interface FirestoreLike {
  doc(path: string): FirestoreDocRef;
  collection(path: string): FirestoreQuery;
  runTransaction<T>(fn: (tx: FirestoreTx) => Promise<T>): Promise<T>;
}
export interface FirestoreDocRef {
  get(): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }>;
  set(data: Record<string, unknown>): Promise<unknown>;
  delete(): Promise<unknown>;
}
export interface FirestoreQuery {
  where(field: string, op: '==' | 'in' | '<', value: unknown): FirestoreQuery;
  limit(n: number): FirestoreQuery;
  get(): Promise<{ docs: { id: string; data(): Record<string, unknown> }[] }>;
}
export interface FirestoreTx {
  get(ref: FirestoreDocRef): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }>;
  set(ref: FirestoreDocRef, data: Record<string, unknown>): unknown;
}

/** Campi indicizzati per collezione (gli altri stanno solo nel payload). */
export const INDEX_FIELDS: Readonly<Record<string, readonly string[]>> = {
  orders: ['state', 'intentKey', 'symbol', 'purpose', 'updatedAt'],
  decisions: ['slotTime'],
  trades: ['exitTime'],
  equity: ['day'],
  ledger: ['kind', 'date'],
};

function collectionOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/'));
}

function encode(path: string, data: object): Record<string, unknown> {
  const doc: Record<string, unknown> = { payload: JSON.stringify(data) };
  for (const field of INDEX_FIELDS[collectionOf(path)] ?? []) {
    const value = (data as Record<string, unknown>)[field];
    if (value !== undefined) doc[field] = value;
  }
  return doc;
}

function decode<T>(raw: Record<string, unknown> | undefined): T | null {
  if (!raw) return null;
  if (typeof raw.payload === 'string') return JSON.parse(raw.payload) as T;
  // Documento scritto a mano dalla console di Firestore (es. il flag del kill switch in
  // `bot_runtime/control`): i campi si leggono così come sono.
  return raw as T;
}

async function guard<T>(what: string, op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    throw new StoreUnavailableError(`Firestore ${what}: ${(err as Error).message}`);
  }
}

export class FirestoreDocumentStore implements DocumentStore {
  constructor(private readonly db: FirestoreLike) {}

  get<T>(path: string): Promise<T | null> {
    return guard('get', async () => decode<T>((await this.db.doc(path).get()).data()));
  }

  async set(path: string, data: object): Promise<void> {
    await guard('set', () => this.db.doc(path).set(encode(path, data)));
  }

  async delete(path: string): Promise<void> {
    await guard('delete', () => this.db.doc(path).delete());
  }

  query<T>(collection: string, filters: Filter[], limit?: number): Promise<{ id: string; data: T }[]> {
    const indexed = INDEX_FIELDS[collection] ?? [];
    for (const f of filters) if (!indexed.includes(f.field)) throw new Error(`Campo non indicizzato per ${collection}: ${f.field}`);
    return guard('query', async () => {
      let q = this.db.collection(collection);
      for (const f of filters) q = q.where(f.field, f.op, f.value);
      if (limit !== undefined) q = q.limit(limit);
      const snap = await q.get();
      return snap.docs.map((d) => ({ id: d.id, data: decode<T>(d.data()) as T }));
    });
  }

  transact<T>(path: string, fn: (current: T | null) => T | null): Promise<T | null> {
    return guard('transaction', () =>
      this.db.runTransaction(async (tx) => {
        const ref = this.db.doc(path);
        const current = decode<T>((await tx.get(ref)).data());
        const next = fn(current);
        if (next === null) return current;
        tx.set(ref, encode(path, next as object));
        return next;
      }),
    );
  }
}
