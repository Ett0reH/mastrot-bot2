// Runtime del bot (F4): sostituisce il loopTick legacy.
//
// Due cicli, mai sovrapposti (un lock serializza tutto ciò che tocca stato e ordini):
// - decisionale (`decisionTick`): a ogni fine slot 15m più un margine; il DecisionCycle aspetta
//   la candela delle :45 e decide alla chiusura 1H UTC;
// - di protezione (`protectionTick`, ogni 15-30 s): rinnovo del lease, riconciliazione con
//   Kraken, verifica degli stop, tetto del sizing al collateral, controllo dei dati stale. Non
//   prende decisioni di strategia.
// L'HTTP non guida il motore: legge solo lo stato (D24).
//
// Recovery all'avvio, in quest'ordine (ogni passo si ripete finché non riesce):
//   1. carica lo stato persistito; 2. acquisisce il lease; 3. riconcilia con Kraken;
//   4. ricostruisce le posizioni con tutti i campi (dallo stato del core, D22) e riallinea gli
//      intenti rimasti in sospeso con l'archivio degli ordini; 5. verifica gli stop; 6. riprende.
// In demo e live senza persistenza il bot non opera (SAFE_MODE); in shadow può partire senza.
import type { EngineConfig, TradingMode } from '../config/config';
import type { CoreConfig } from '../core/decisionCore';
import { slotEnd } from '../core/aggregator';
import type { DecisionRecord, EquitySnapshot, TradeRecord } from '../core/types';
import { BAR_15M_MS } from '../data/dataset';
import type { AccountLedger, LedgerEntry } from '../exchange/accountLedger';
import type { InstrumentRegistry } from '../exchange/instruments';
import type { KrakenAdapter } from '../exchange/krakenAdapter';
import { type FundingSource, initialKrakenPortState, KrakenExecutionPort, type KrakenPortConfig, type KrakenPortState } from '../exchange/krakenExecutionPort';
import type { OrderManager } from '../exchange/orderManager';
import { makeCliOrdId } from '../exchange/orders';
import type { StopManager } from '../exchange/stopManager';
import { REALISTIC_PROFILE } from '../backtest/profiles';
import { DecisionCycle, type DecisionCycleConfig, lastClosedSlot, LIVE_CYCLE_DEFAULTS, type TickResult } from '../live/decisionCycle';
import { coreConfigFromEngine } from '../live/liveCycleConfig';
import type { CandleSource } from '../live/ports';
import { type Alert, type AlertCode, type AlertLevel, type AlertSink, makeAlert } from '../ops/alerts';
import type { BotStore, EquityPoint, RuntimeSnapshot } from '../persistence/botStore';
import { SimExecutionPort } from '../replay/replay';
import type { RestingStop } from '../sim/simExchange';
import { GatedExecutionPort } from './gatedPort';
import type { LeaseManager } from './lease';

export type RuntimeStatus = 'STARTING' | 'SAFE_MODE' | 'STANDBY' | 'RECOVERING' | 'RUNNING' | 'STOPPED';

type PortSnapshot = { kind: 'kraken'; state: KrakenPortState } | { kind: 'sim'; state: { stops: RestingStop[] } };

export interface KrakenRuntimeDeps {
  adapter: KrakenAdapter;
  orders: OrderManager;
  stops: StopManager;
  instruments: InstrumentRegistry;
  funding: FundingSource;
  portConfig?: KrakenPortConfig;
  /** Account log di Kraken (fee, funding, depositi e prelievi). */
  ledger?: AccountLedger;
}

export interface RuntimeDeps {
  config: EngineConfig;
  now: () => number;
  store: BotStore;
  lease: LeaseManager;
  source: CandleSource;
  alerts: AlertSink;
  /** Obbligatorio in demo e live, assente in shadow. */
  kraken?: KrakenRuntimeDeps;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export interface RuntimeOptions {
  cycle?: Partial<Omit<DecisionCycleConfig, 'core' | 'startMs'>>;
  /** Dati più vecchi di così: alert STALE_DATA. */
  staleDataMs?: number;
  /** Salvataggi falliti consecutivi dopo i quali gli ingressi si bloccano. */
  maxFailedSaves?: number;
  journalRetentionDays?: number;
  /** Solo test/replay: primo slot di trading per uno stato nuovo (default: il prossimo slot). */
  startMs?: number;
}

type Snapshot = RuntimeSnapshot<PortSnapshot> & { runtime: RuntimeSnapshot['runtime'] & { startMs: number; ledgerLastId?: number } };

/** Intervallo di lettura dell'account log (le API di storico hanno un budget ridotto). */
const LEDGER_SYNC_MS = 10 * 60_000;

export class BotRuntime {
  status: RuntimeStatus = 'STARTING';
  paused = false;
  lastError: string | null = null;
  private cycle: DecisionCycle | null = null;
  private port: KrakenExecutionPort | SimExecutionPort | null = null;
  private snapshot: Snapshot | null = null;
  private snapshotLoaded = false;
  private startMs: number | null = null;
  private failedSaves = 0;
  private persistenceHealthy = true;
  private staleAlerted = false;
  private lastPruneDay = '';
  private lastDecisionAt: number | null = null;
  private ledgerLastId = 0;
  private lastLedgerSync = 0;
  readonly recentLedger: LedgerEntry[] = [];
  private lock: Promise<unknown> = Promise.resolve();
  readonly startedAt: number;
  readonly recentJournal: DecisionRecord[] = [];
  readonly recentTrades: TradeRecord[] = [];
  readonly equityHistory: EquityPoint[] = [];
  readonly recentAlerts: Alert[] = [];
  readonly counters = { decisionTicks: 0, protectionTicks: 0, failedTicks: 0 };

  constructor(private readonly deps: RuntimeDeps, private readonly options: RuntimeOptions = {}) {
    if (deps.config.mode !== 'shadow' && !deps.kraken) throw new Error(`Modalità ${deps.config.mode} senza execution layer Kraken`);
    if (deps.config.mode === 'shadow' && deps.kraken) throw new Error('In shadow il runtime non riceve l execution layer Kraken');
    this.startedAt = deps.now();
  }

  get mode(): TradingMode {
    return this.deps.config.mode;
  }

  /** Esegue `fn` in esclusiva: i due cicli non si sovrappongono mai. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.deps.log?.(level, message);
  }

  private async alert(level: AlertLevel, code: AlertCode, message: string, context?: Record<string, unknown>): Promise<void> {
    const alert = makeAlert(this.deps.now(), level, code, message, context);
    this.recentAlerts.push(alert);
    if (this.recentAlerts.length > 100) this.recentAlerts.splice(0, this.recentAlerts.length - 100);
    try {
      await this.deps.alerts.send(alert);
    } catch (err) {
      this.log('error', `Invio dell'alert ${code} fallito: ${(err as Error).message}`);
    }
  }

  private coreConfig(): CoreConfig {
    return coreConfigFromEngine(this.deps.config);
  }

  private cycleConfig(startMs: number): DecisionCycleConfig {
    return { core: this.coreConfig(), startMs, ...LIVE_CYCLE_DEFAULTS, ...this.options.cycle };
  }

  /** Motivo per cui gli ingressi sono bloccati ora (null = consentiti). */
  entryBlockReason(): string | null {
    if (this.paused) return 'bot in pausa';
    if (!this.persistenceHealthy) return 'persistenza non disponibile';
    return this.deps.lease.canWrite();
  }

  // --- Recovery -------------------------------------------------------------------------------

  /** Porta il runtime in RUNNING eseguendo i passi di recovery mancanti. Idempotente. */
  ensureRunning(): Promise<RuntimeStatus> {
    return this.exclusive(() => this.recover());
  }

  private async recover(): Promise<RuntimeStatus> {
    if (this.status === 'RUNNING' || this.status === 'STOPPED') return this.status;
    const now = this.deps.now();
    // 1. Stato persistito
    if (!this.snapshotLoaded) {
      try {
        this.snapshot = (await this.deps.store.loadSnapshot<PortSnapshot>()) as Snapshot | null;
        this.snapshotLoaded = true;
      } catch (err) {
        this.lastError = `stato non caricato: ${(err as Error).message}`;
        if (this.mode !== 'shadow') {
          if (this.status !== 'SAFE_MODE') await this.alert('critical', 'EXECUTION_ERROR', `Persistenza non disponibile all'avvio: il bot non opera (${this.lastError})`);
          this.status = 'SAFE_MODE';
          return this.status;
        }
        this.snapshot = null;
        this.snapshotLoaded = true;
        await this.alert('warning', 'EXECUTION_ERROR', `Shadow senza persistenza: si parte da uno stato nuovo (${this.lastError})`);
      }
    }
    // 2. Lease
    let acquired = false;
    try {
      acquired = await this.deps.lease.acquire();
    } catch (err) {
      this.lastError = `lease non acquisito: ${(err as Error).message}`;
    }
    if (!acquired) {
      this.status = 'STANDBY';
      return this.status;
    }
    this.status = 'RECOVERING';
    // Il lease può essere passato di mano: lo stato va riletto dopo averlo acquisito.
    if (this.cycle === null) {
      try {
        this.snapshot = (await this.deps.store.loadSnapshot<PortSnapshot>()) as Snapshot | null;
      } catch (err) {
        this.lastError = `stato non caricato: ${(err as Error).message}`;
        if (this.mode !== 'shadow') return this.status;
      }
      this.build(now);
    }
    const cycle = this.cycle as DecisionCycle;
    try {
      if (this.port instanceof KrakenExecutionPort) {
        // 3-5. Intenti in sospeso, riconciliazione con Kraken e verifica degli stop.
        await this.adoptPendingIntents(this.port, cycle);
        await this.port.protect();
      }
      // 6. Storico delle candele e ripresa.
      await cycle.start();
    } catch (err) {
      this.lastError = `recovery incompleto: ${(err as Error).message}`;
      this.log('warn', this.lastError);
      // Il ciclo va ricostruito al prossimo tentativo (start() non è ripetibile).
      this.cycle = null;
      this.port = null;
      return this.status;
    }
    this.status = 'RUNNING';
    this.lastError = null;
    await this.persist();
    this.log('info', `Runtime in esecuzione (${this.mode}, lease epoch ${this.deps.lease.lease?.epoch})`);
    return this.status;
  }

  private build(now: number): void {
    const snap = this.snapshot;
    this.paused = snap?.runtime.paused ?? false;
    this.ledgerLastId = snap?.runtime.ledgerLastId ?? 0;
    this.startMs = snap?.runtime.startMs ?? this.options.startMs ?? Math.floor(now / BAR_15M_MS) * BAR_15M_MS + BAR_15M_MS;
    const kraken = this.deps.kraken;
    if (kraken) {
      if (snap && snap.port.kind !== 'kraken') throw new Error('Stato persistito di un altro tipo di esecuzione (shadow): non riutilizzabile in demo/live');
      const portState = snap && snap.port.kind === 'kraken' ? snap.port.state : initialKrakenPortState();
      this.port = new KrakenExecutionPort(
        { mode: this.mode, adapter: kraken.adapter, orders: kraken.orders, stops: kraken.stops, instruments: kraken.instruments, alerts: this.deps.alerts, funding: kraken.funding, now: this.deps.now },
        kraken.portConfig,
        portState,
      );
    } else {
      const simState = snap && snap.port.kind === 'sim' ? snap.port.state : { stops: [] };
      this.port = new SimExecutionPort(REALISTIC_PROFILE.execution, { kind: 'none' }, simState);
    }
    const gate = new GatedExecutionPort(this.port, () => this.entryBlockReason());
    this.cycle = new DecisionCycle(this.cycleConfig(this.startMs), { source: this.deps.source, port: gate, checkpoint: () => this.checkpoint() }, snap?.core);
  }

  /**
   * Allinea gli intenti rimasti in sospeso nel core con l'archivio degli ordini: un ordine inviato
   * prima del crash viene riconciliato; un intento mai inviato viene annullato (sarà ridecisa
   * alla prossima chiusura oraria, se ancora valida).
   */
  private async adoptPendingIntents(port: KrakenExecutionPort, cycle: DecisionCycle): Promise<void> {
    const orders = (this.deps.kraken as KrakenRuntimeDeps).orders;
    for (const intent of Object.values(cycle.state.pendingOpens)) {
      if (port.state.pendingEntries[intent.positionId] || port.state.positions[intent.positionId]) continue;
      const cliOrdId = makeCliOrdId(intent.positionId, 'ENTRY', 1);
      if (await orders.store.get(cliOrdId)) {
        port.state.pendingEntries[intent.positionId] = { intent, cliOrdId };
      } else {
        cycle.rejectPending(intent.positionId);
        await this.alert('warning', 'EXECUTION_ERROR', `Ingresso ${intent.symbol} deciso prima del riavvio e mai inviato: annullato`, { positionId: intent.positionId });
      }
    }
    for (const pending of Object.values(cycle.state.pendingCloses)) {
      const positionId = pending.intent.positionId;
      const pos = port.state.positions[positionId];
      const exits = (await orders.store.byIntent(positionId)).filter((r) => r.purpose === 'EXIT' || r.purpose === 'EMERGENCY_CLOSE');
      if (pos && exits.length > 0) pos.closing ??= { reason: pending.intent.exitType, since: this.deps.now() };
      else if (exits.length === 0) cycle.rejectPending(positionId);
    }
  }

  // --- Persistenza ------------------------------------------------------------------------------

  private snapshotData(): Omit<Snapshot, 'savedAt' | 'version'> | null {
    if (!this.cycle || !this.port || this.startMs === null) return null;
    const port: PortSnapshot = this.port instanceof KrakenExecutionPort ? { kind: 'kraken', state: this.port.snapshot() } : { kind: 'sim', state: this.port.snapshot() };
    return {
      mode: this.mode,
      core: this.cycle.state,
      port,
      runtime: {
        paused: this.paused,
        startedAt: new Date(this.startedAt).toISOString(),
        lastDecisionAt: this.lastDecisionAt === null ? null : new Date(this.lastDecisionAt).toISOString(),
        startMs: this.startMs,
        ledgerLastId: this.ledgerLastId,
      },
    };
  }

  /** Salvataggio write-ahead prima dell'esecuzione: se fallisce il ciclo non invia ingressi. */
  private async checkpoint(): Promise<void> {
    const data = this.snapshotData();
    if (data) await this.deps.store.saveSnapshot(data);
  }

  private async persist(): Promise<void> {
    const data = this.snapshotData();
    if (!data) return;
    try {
      await this.deps.store.saveSnapshot(data);
      if (!this.persistenceHealthy) await this.alert('info', 'EXECUTION_ERROR', 'Persistenza di nuovo disponibile: ingressi riabilitati');
      this.failedSaves = 0;
      this.persistenceHealthy = true;
    } catch (err) {
      this.failedSaves++;
      this.lastError = `salvataggio fallito: ${(err as Error).message}`;
      if (this.persistenceHealthy && this.failedSaves >= (this.options.maxFailedSaves ?? 3)) {
        this.persistenceHealthy = false;
        await this.alert('critical', 'EXECUTION_ERROR', `Persistenza non disponibile (${this.failedSaves} salvataggi falliti): nuovi ingressi bloccati, protezione attiva`);
      }
    }
  }

  // --- Cicli ------------------------------------------------------------------------------------

  decisionTick(now: number): Promise<TickResult | null> {
    return this.exclusive(async () => {
      if (this.status !== 'RUNNING' && (await this.recover()) !== 'RUNNING') return null;
      if (this.deps.lease.canWrite() !== null && !(await this.deps.lease.renew())) {
        await this.onLeaseLost();
        return null;
      }
      const cycle = this.cycle as DecisionCycle;
      let result: TickResult;
      try {
        result = await cycle.tick(now);
      } catch (err) {
        this.counters.failedTicks++;
        this.lastError = `ciclo decisionale: ${(err as Error).message}`;
        this.log('warn', this.lastError);
        return null;
      }
      this.counters.decisionTicks++;
      if (result.processedSlots > 0) this.lastDecisionAt = now;
      await this.afterTick(result);
      await this.persist();
      return result;
    });
  }

  private async afterTick(result: TickResult): Promise<void> {
    const store = this.deps.store;
    for (const trade of result.trades) {
      const positionId = `${trade.symbol.split('/')[0]}-${trade.entryTime}`;
      this.recentTrades.unshift(trade);
      try {
        await store.appendTrade(positionId, trade);
      } catch (err) {
        this.lastError = `trade non salvato: ${(err as Error).message}`;
      }
      await this.alert('info', 'EXIT', `Trade chiuso ${trade.symbol} ${trade.type} (${trade.reason}): ${trade.pnl.toFixed(2)} $`, { positionId });
    }
    if (this.recentTrades.length > 200) this.recentTrades.length = 200;
    const bySlot = new Map<number, DecisionRecord[]>();
    for (const r of result.journal) bySlot.set(r.slotTime, [...(bySlot.get(r.slotTime) ?? []), r]);
    for (const [slot, records] of bySlot) {
      this.recentJournal.push(...records);
      try {
        await store.appendDecisions(slot, records);
      } catch (err) {
        this.lastError = `journal non salvato: ${(err as Error).message}`;
      }
    }
    if (this.recentJournal.length > 500) this.recentJournal.splice(0, this.recentJournal.length - 500);
    for (const e of result.equity) await this.recordEquity(e);
    for (const event of result.events) {
      if (event.type === 'STALE_ENTRY_REJECTED') await this.alert('warning', 'EXECUTION_ERROR', `Ingresso ${event.positionId} deciso in ritardo (${Math.round(event.delayMs / 60_000)} min): non eseguito`);
      if (event.type === 'CHECKPOINT_FAILED') await this.alert('critical', 'EXECUTION_ERROR', `Stato non salvato prima dell'esecuzione: ingressi bloccati (${event.reason})`);
    }
  }

  private async recordEquity(e: EquitySnapshot): Promise<void> {
    const point: EquityPoint = { t: slotEnd(e.slotTime), equity: e.trueEquity, realized: e.realizedEquity, drawdown: e.drawdown };
    this.equityHistory.push(point);
    if (this.equityHistory.length > 24 * 30) this.equityHistory.splice(0, this.equityHistory.length - 24 * 30);
    try {
      await this.deps.store.appendEquity(point);
    } catch (err) {
      this.lastError = `equity non salvata: ${(err as Error).message}`;
    }
  }

  protectionTick(now: number): Promise<void> {
    return this.exclusive(async () => {
      if (this.status !== 'RUNNING' && (await this.recover()) !== 'RUNNING') return;
      if (!(await this.deps.lease.renew())) {
        await this.onLeaseLost();
        return;
      }
      this.counters.protectionTicks++;
      if (this.port instanceof KrakenExecutionPort) {
        try {
          await this.port.protect();
          await this.updateSizingCap();
          await this.syncLedger(now);
        } catch (err) {
          this.lastError = `ciclo di protezione: ${(err as Error).message}`;
          this.log('warn', this.lastError);
        }
      }
      await this.checkStaleData(now);
      await this.persist();
      await this.dailyMaintenance(now);
    });
  }

  /** Equity di sizing limitata dal collateral del conto di trading (D28). */
  private async updateSizingCap(): Promise<void> {
    const kraken = this.deps.kraken as KrakenRuntimeDeps;
    const flex = (await kraken.adapter.accounts()).flex;
    if (!flex || !Number.isFinite(flex.marginEquity)) throw new Error('conto flex assente: collateral sconosciuto');
    (this.cycle as DecisionCycle).state.sizingEquityCap = flex.marginEquity;
  }

  /** Account log: fee e funding reali nel ledger, depositi e prelievi registrati e segnalati (D28). */
  private async syncLedger(now: number): Promise<void> {
    const ledger = this.deps.kraken?.ledger;
    if (!ledger || now - this.lastLedgerSync < LEDGER_SYNC_MS) return;
    const { added, lastId } = await ledger.sync(this.ledgerLastId);
    this.lastLedgerSync = now;
    this.ledgerLastId = lastId;
    this.recentLedger.push(...added);
    if (this.recentLedger.length > 200) this.recentLedger.splice(0, this.recentLedger.length - 200);
    for (const e of added.filter((x) => x.kind === 'transfer')) {
      await this.alert('warning', 'ACCOUNT_TRANSFER', `${e.balanceChange >= 0 ? 'Deposito' : 'Prelievo'} di ${Math.abs(e.balanceChange)} ${e.asset.toUpperCase()} sul conto (${e.info}): l'equity del bot non cambia, il collateral sì`, { ledgerId: e.id });
    }
  }

  private async checkStaleData(now: number): Promise<void> {
    const lastSlot = this.cycle?.state.lastSlot ?? null;
    // Senza nessuna candela dall'avvio il riferimento è l'avvio stesso.
    const ageMs = now - (lastSlot === null ? this.startedAt : slotEnd(lastSlot));
    const stale = ageMs > (this.options.staleDataMs ?? 30 * 60_000);
    if (stale && !this.staleAlerted) {
      this.staleAlerted = true;
      await this.alert('warning', 'STALE_DATA', `Dati di mercato fermi da ${Math.round(ageMs / 60_000)} minuti: nessun nuovo ingresso, protezione attiva`);
    } else if (!stale && this.staleAlerted) {
      this.staleAlerted = false;
      await this.alert('info', 'STALE_DATA', 'Dati di mercato di nuovo aggiornati');
    }
  }

  private async dailyMaintenance(now: number): Promise<void> {
    const day = new Date(now).toISOString().slice(0, 10);
    if (day === this.lastPruneDay) return;
    this.lastPruneDay = day;
    try {
      await this.deps.store.pruneDecisions(this.options.journalRetentionDays ?? 30);
    } catch (err) {
      this.lastError = `pulizia del journal fallita: ${(err as Error).message}`;
    }
  }

  private async onLeaseLost(): Promise<void> {
    if (this.status === 'STANDBY') return;
    this.status = 'STANDBY';
    this.cycle = null;
    this.port = null;
    await this.alert('critical', 'LEASE_LOST', 'Lease d istanza perso: questa istanza smette subito di inviare ordini');
  }

  // --- Controllo ----------------------------------------------------------------------------------

  pause(): Promise<void> {
    return this.exclusive(async () => {
      this.paused = true;
      await this.persist();
      await this.alert('info', 'MODE_CHANGE', 'Bot in pausa: nessun nuovo ingresso, uscite e stop attivi');
    });
  }

  resume(): Promise<void> {
    return this.exclusive(async () => {
      this.paused = false;
      await this.persist();
      await this.alert('info', 'MODE_CHANGE', 'Bot ripreso');
    });
  }

  /** Solo shadow: riparte da uno stato nuovo. Con ordini reali lo stato non si azzera mai (D28, D34). */
  reset(): Promise<void> {
    return this.exclusive(async () => {
      if (this.mode !== 'shadow') throw new Error('Reset non consentito in demo e live');
      this.snapshot = null;
      this.startMs = null;
      this.cycle = null;
      this.port = null;
      this.recentTrades.length = 0;
      this.recentJournal.length = 0;
      this.equityHistory.length = 0;
      this.status = 'STARTING';
      this.snapshotLoaded = true;
    });
  }

  stop(): Promise<void> {
    return this.exclusive(async () => {
      await this.persist();
      this.status = 'STOPPED';
      await this.deps.lease.release().catch(() => undefined);
    });
  }

  // --- Stato per l'API e la dashboard (solo dati reali, nessuna chiamata esterna) ------------------

  statusPayload(): Record<string, unknown> {
    const now = this.deps.now();
    const core = this.cycle?.state ?? null;
    const cap = this.deps.config.limits.capitalCapUsd;
    const krakenBook = this.port instanceof KrakenExecutionPort ? this.port.state.positions : null;
    const openPositions = (this.cycle?.openPositions() ?? []).map((p) => {
      const last = core?.lastClose[p.symbol] ?? p.trade.entryPrice;
      const sign = p.trade.direction === 'LONG' ? 1 : -1;
      const book = krakenBook?.[p.id];
      return {
        id: p.id,
        symbol: p.symbol,
        side: p.trade.direction,
        direction: p.trade.direction,
        currentStopLoss: p.trade.currentStopLoss,
        size: p.trade.size,
        entryPrice: p.trade.entryPrice,
        entryTime: p.entryTime,
        leverage: p.trade.leverage,
        engine: p.trade.engine,
        stopLoss: p.trade.currentStopLoss,
        backstop: p.backstop,
        unrealizedPnl: sign * (last - p.trade.entryPrice) * p.trade.size - p.fundingPaid,
        margin: (p.trade.size * p.trade.entryPrice) / p.trade.leverage,
        protection: krakenBook ? (book ? (book.unprotectedSince === null ? 'NATIVE_STOP_OK' : 'UNPROTECTED') : 'PENDING') : 'SIMULATED',
      };
    });
    const lastSlot = core?.lastSlot ?? null;
    return {
      tradingMode: this.mode,
      runtimeStatus: this.status,
      status: this.status === 'RUNNING' ? (this.paused ? 'PAUSED' : 'RUNNING') : this.status,
      isActive: this.status === 'RUNNING' && !this.paused,
      paused: this.paused,
      entryBlock: this.status === 'RUNNING' ? this.entryBlockReason() : this.status,
      startTime: new Date(this.startedAt).toISOString(),
      lastUpdate: new Date(now).toISOString(),
      lastDecisionAt: this.lastDecisionAt === null ? null : new Date(this.lastDecisionAt).toISOString(),
      dataAgeMs: lastSlot === null ? null : now - slotEnd(lastSlot),
      latestClosedSlot: new Date(lastClosedSlot(now)).toISOString(),
      initialBalance: cap,
      balance: core?.capital?.trueEquity ?? core?.realizedEquity ?? cap,
      realizedEquity: core?.realizedEquity ?? cap,
      maxDrawdown: core?.maxDrawdown ?? 0,
      sizingEquityCap: core?.sizingEquityCap ?? null,
      openPositions,
      marginUsed: openPositions.reduce((a, p) => a + p.margin, 0),
      // Nomi dei campi usati dalla dashboard attuale (time, side, entry, exit): rifatta in F6.
      closedTrades: this.recentTrades.map((t) => ({ ...t, time: t.exitTime, side: t.type, entry: t.entryPrice, exit: t.exitPrice })),
      recentTrades: this.recentTrades.slice(0, 20).map((t) => ({ ...t, time: t.exitTime, side: t.type, entry: t.entryPrice, exit: t.exitPrice })),
      equityHistory: this.equityHistory.map((p) => ({ ...p, time: new Date(p.t).toISOString() })),
      recentDecisions: this.recentJournal.slice(-100).reverse().map((d) => ({ ...d, time: new Date(d.slotTime + BAR_15M_MS).toISOString() })),
      regimes: Object.fromEntries(this.recentJournal.filter((r) => r.regime).slice(-8 * 2).map((r) => [r.symbol, r.regime])),
      lease: this.deps.lease.lease,
      ledger: {
        lastId: this.ledgerLastId,
        fees: this.recentLedger.reduce((a, e) => a + (e.fee ?? 0), 0),
        funding: this.recentLedger.reduce((a, e) => a + (e.realizedFunding ?? 0), 0),
        transfers: this.recentLedger.filter((e) => e.kind === 'transfer').map((e) => ({ id: e.id, date: e.date, amount: e.balanceChange, info: e.info })),
      },
      writes: this.deps.store.budget.snapshot(),
      alerts: this.recentAlerts.slice(-50).reverse(),
      counters: this.counters,
      lastError: this.lastError,
      krakenStatus: this.deps.kraken ? { connected: this.status === 'RUNNING' && this.lastError === null, lastError: this.lastError, circuit: this.deps.kraken.adapter.breaker.state } : null,
    };
  }
}
