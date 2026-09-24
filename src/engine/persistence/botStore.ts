// Persistenza del bot (F4: D23, D24, D27).
//
//   bot_runtime/state      documento piccolo: stato del core, della porta e del runtime
//   orders/{cliOrdId}      un documento per ordine (macchina a stati, fill)
//   trades/{positionId}    trade chiusi (append-only)
//   decisions/{ora}        journal delle decisioni di una chiusura oraria (append-only, retention)
//   equity/{giorno}        equity oraria del giorno (un documento al giorno)
//   ledger/{id}            movimenti dell'account log di Kraken (fee, funding, trasferimenti)
// Si scrive solo quando qualcosa cambia (confronto del contenuto) e le scritture sono contate
// per giorno UTC: oltre il budget si sospendono quelle non essenziali (journal, equity) con un
// alert, mai quelle di stato e ordini.
import type { CoreState } from '../core/decisionCore';
import type { DecisionRecord, TradeRecord } from '../core/types';
import type { OrderRecord, OrderStore } from '../exchange/orders';
import { TERMINAL_STATES } from '../exchange/orders';
import { canonicalHash } from '../util/canonical';
import type { DocumentStore } from './documentStore';

export interface WriteStats {
  day: string;
  writes: number;
  skippedUnchanged: number;
  skippedOverBudget: number;
  budget: number;
}

export class WriteBudget {
  private stats: WriteStats;

  constructor(readonly dailyBudget: number, private readonly now: () => number) {
    this.stats = this.fresh();
  }

  private fresh(): WriteStats {
    return { day: new Date(this.now()).toISOString().slice(0, 10), writes: 0, skippedUnchanged: 0, skippedOverBudget: 0, budget: this.dailyBudget };
  }

  private roll(): void {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (day !== this.stats.day) this.stats = this.fresh();
  }

  /** true se una scrittura non essenziale può partire. */
  allowOptional(): boolean {
    this.roll();
    return this.stats.writes < this.dailyBudget;
  }

  recordWrite(): void {
    this.roll();
    this.stats.writes++;
  }

  recordSkip(reason: 'unchanged' | 'over_budget'): void {
    this.roll();
    if (reason === 'unchanged') this.stats.skippedUnchanged++;
    else this.stats.skippedOverBudget++;
  }

  snapshot(): WriteStats {
    this.roll();
    return { ...this.stats };
  }
}

export interface EquityPoint {
  t: number;
  equity: number;
  realized: number;
  drawdown: number;
}

export interface RuntimeSnapshot<PortState = unknown> {
  version: 1;
  savedAt: string;
  mode: string;
  core: CoreState;
  port: PortState;
  runtime: { paused: boolean; startedAt: string; lastDecisionAt: string | null };
}

/** OrderStore su DocumentStore: un documento per ordine, scritto solo se cambia. */
export class PersistentOrderStore implements OrderStore {
  private readonly hashes = new Map<string, string>();

  constructor(private readonly docs: DocumentStore, private readonly budget: WriteBudget) {}

  async get(cliOrdId: string): Promise<OrderRecord | null> {
    return this.docs.get<OrderRecord>(`orders/${cliOrdId}`);
  }

  async save(record: OrderRecord): Promise<void> {
    const hash = canonicalHash(record);
    if (this.hashes.get(record.cliOrdId) === hash) {
      this.budget.recordSkip('unchanged');
      return;
    }
    await this.docs.set(`orders/${record.cliOrdId}`, record);
    this.budget.recordWrite();
    this.hashes.set(record.cliOrdId, hash);
  }

  async active(): Promise<OrderRecord[]> {
    const states = ['INTENT_CREATED', 'SUBMITTED', 'ACKNOWLEDGED', 'PARTIAL', 'UNKNOWN'].filter((s) => !TERMINAL_STATES.has(s as OrderRecord['state']));
    return (await this.docs.query<OrderRecord>('orders', [{ field: 'state', op: 'in', value: states }])).map((d) => d.data);
  }

  async byIntent(intentKey: string): Promise<OrderRecord[]> {
    return (await this.docs.query<OrderRecord>('orders', [{ field: 'intentKey', op: '==', value: intentKey }])).map((d) => d.data);
  }
}

export class BotStore {
  readonly orders: PersistentOrderStore;
  private snapshotHash: string | null = null;
  private equityDay: { day: string; points: EquityPoint[] } | null = null;

  constructor(readonly docs: DocumentStore, readonly budget: WriteBudget, private readonly now: () => number) {
    this.orders = new PersistentOrderStore(docs, budget);
  }

  async loadSnapshot<P>(): Promise<RuntimeSnapshot<P> | null> {
    const snap = await this.docs.get<RuntimeSnapshot<P>>('bot_runtime/state');
    if (snap && snap.version !== 1) throw new Error(`Versione dello stato non supportata: ${String((snap as { version: unknown }).version)}`);
    this.snapshotHash = snap ? canonicalHash({ ...snap, savedAt: '' }) : null;
    return snap;
  }

  /** Elimina lo stato salvato (solo per il reset dello shadow). */
  async deleteSnapshot(): Promise<void> {
    await this.docs.delete('bot_runtime/state');
    this.budget.recordWrite();
    this.snapshotHash = null;
  }

  /** Salva lo stato se è cambiato. Restituisce true se ha scritto. */
  async saveSnapshot<P>(snapshot: Omit<RuntimeSnapshot<P>, 'savedAt' | 'version'>): Promise<boolean> {
    const full: RuntimeSnapshot<P> = { version: 1, savedAt: '', ...snapshot };
    const hash = canonicalHash(full);
    if (hash === this.snapshotHash) {
      this.budget.recordSkip('unchanged');
      return false;
    }
    await this.docs.set('bot_runtime/state', { ...full, savedAt: new Date(this.now()).toISOString() });
    this.budget.recordWrite();
    this.snapshotHash = hash;
    return true;
  }

  async appendTrade(positionId: string, trade: TradeRecord): Promise<void> {
    await this.docs.set(`trades/${positionId}`, trade);
    this.budget.recordWrite();
  }

  /** Journal di una chiusura oraria (non essenziale: sospeso oltre il budget). */
  async appendDecisions(slotTime: number, records: readonly DecisionRecord[]): Promise<boolean> {
    if (records.length === 0) return false;
    if (!this.budget.allowOptional()) {
      this.budget.recordSkip('over_budget');
      return false;
    }
    await this.docs.set(`decisions/${new Date(slotTime).toISOString()}`, { slotTime, records });
    this.budget.recordWrite();
    return true;
  }

  /** Punto di equity orario, nel documento del giorno (non essenziale). */
  async appendEquity(point: EquityPoint): Promise<boolean> {
    const day = new Date(point.t).toISOString().slice(0, 10);
    if (!this.equityDay || this.equityDay.day !== day) {
      const existing = await this.docs.get<{ day: string; points: EquityPoint[] }>(`equity/${day}`);
      this.equityDay = existing ?? { day, points: [] };
    }
    if (this.equityDay.points.some((p) => p.t === point.t)) return false;
    this.equityDay.points.push(point);
    if (!this.budget.allowOptional()) {
      this.budget.recordSkip('over_budget');
      return false;
    }
    await this.docs.set(`equity/${day}`, this.equityDay);
    this.budget.recordWrite();
    return true;
  }

  async recentTrades(limit: number): Promise<TradeRecord[]> {
    const all = await this.docs.query<TradeRecord>('trades', []);
    return all.map((d) => d.data).sort((a, b) => b.exitTime.localeCompare(a.exitTime)).slice(0, limit);
  }

  async equityHistory(days: number): Promise<EquityPoint[]> {
    const out: EquityPoint[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const day = new Date(this.now() - i * 86_400_000).toISOString().slice(0, 10);
      const doc = await this.docs.get<{ points: EquityPoint[] }>(`equity/${day}`);
      if (doc) out.push(...doc.points);
    }
    return out;
  }

  /** Retention del journal: elimina le decisioni più vecchie di `days` giorni. */
  async pruneDecisions(days: number): Promise<number> {
    const cutoff = this.now() - days * 86_400_000;
    const old = await this.docs.query<{ slotTime: number }>('decisions', [{ field: 'slotTime', op: '<', value: cutoff }], 500);
    for (const d of old) {
      await this.docs.delete(`decisions/${d.id}`);
      this.budget.recordWrite();
    }
    return old.length;
  }
}
