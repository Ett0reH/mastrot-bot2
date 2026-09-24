// Archivio documentale minimo usato dal runtime (F4). Due implementazioni: in memoria (test e
// shadow senza Firestore) e Firestore (firestoreStore.ts). I documenti sono JSON: ciò che non è
// serializzabile in JSON non può essere persistito per errore.
export type Filter = { field: string; op: '==' | 'in' | '<'; value: unknown };

export interface DocumentStore {
  get<T>(path: string): Promise<T | null>;
  set(path: string, data: object): Promise<void>;
  delete(path: string): Promise<void>;
  query<T>(collection: string, filters: Filter[], limit?: number): Promise<{ id: string; data: T }[]>;
  /** Lettura e scrittura atomiche di un documento: `fn` restituisce il nuovo valore, o null per non scrivere. */
  transact<T>(path: string, fn: (current: T | null) => T | null): Promise<T | null>;
}

export class StoreUnavailableError extends Error {
  constructor(message = 'Archivio non disponibile') {
    super(message);
    this.name = 'StoreUnavailableError';
  }
}

function split(path: string): { collection: string; id: string } {
  const i = path.lastIndexOf('/');
  if (i <= 0 || i === path.length - 1) throw new Error(`Percorso non valido: ${path}`);
  return { collection: path.slice(0, i), id: path.slice(i + 1) };
}

function fieldOf(data: unknown, field: string): unknown {
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>)[field] : undefined;
}

export function matches(data: unknown, filters: readonly Filter[]): boolean {
  return filters.every((f) => {
    const v = fieldOf(data, f.field);
    if (f.op === '==') return v === f.value;
    if (f.op === 'in') return Array.isArray(f.value) && f.value.includes(v);
    return typeof v === typeof f.value && (v as number | string) < (f.value as number | string);
  });
}

export class MemoryDocumentStore implements DocumentStore {
  private readonly docs = new Map<string, string>();
  writes = 0;
  reads = 0;
  /** Simula un'interruzione dell'archivio: ogni operazione fallisce. */
  unavailable = false;

  private check(): void {
    if (this.unavailable) throw new StoreUnavailableError();
  }

  async get<T>(path: string): Promise<T | null> {
    this.check();
    this.reads++;
    const raw = this.docs.get(path);
    return raw === undefined ? null : (JSON.parse(raw) as T);
  }

  async set(path: string, data: object): Promise<void> {
    this.check();
    split(path);
    this.writes++;
    this.docs.set(path, JSON.stringify(data));
  }

  async delete(path: string): Promise<void> {
    this.check();
    this.writes++;
    this.docs.delete(path);
  }

  async query<T>(collection: string, filters: Filter[], limit = Infinity): Promise<{ id: string; data: T }[]> {
    this.check();
    const out: { id: string; data: T }[] = [];
    for (const [path, raw] of [...this.docs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const { collection: c, id } = split(path);
      if (c !== collection) continue;
      const data = JSON.parse(raw) as T;
      if (!matches(data, filters)) continue;
      this.reads++;
      out.push({ id, data });
      if (out.length >= limit) break;
    }
    return out;
  }

  async transact<T>(path: string, fn: (current: T | null) => T | null): Promise<T | null> {
    this.check();
    this.reads++;
    const raw = this.docs.get(path);
    const next = fn(raw === undefined ? null : (JSON.parse(raw) as T));
    if (next === null) return raw === undefined ? null : (JSON.parse(raw) as T);
    this.writes++;
    this.docs.set(path, JSON.stringify(next));
    return next;
  }

  /** Copia indipendente del contenuto (il "disco" in un certo istante, per i test di crash). */
  clone(): MemoryDocumentStore {
    const copy = new MemoryDocumentStore();
    for (const [k, v] of this.docs) copy.docs.set(k, v);
    return copy;
  }

  paths(prefix = ''): string[] {
    return [...this.docs.keys()].filter((p) => p.startsWith(prefix)).sort();
  }
}
