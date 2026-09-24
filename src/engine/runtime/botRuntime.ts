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
// Lo stato salvato da un bot di un'altra modalità (stesso database) non si usa mai e il suo lease
// non si prende; uno stato non ricostruibile ferma il bot con un alert (SAFE_MODE, D51, D53).
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
import { type Alert, type AlertCode, type AlertLevel, type AlertSink, makeAlert, RecordingAlertSink } from '../ops/alerts';
import { type CycleContext, Logger, type LogLevel } from '../ops/logger';
import { buildDailyReport, type DailyReport, summarizeReport } from '../ops/dailyReport';
import { compareDay, type DayCheckpoint, notAvailable, type ParityResult, replayDay } from '../ops/dayParity';
import { dayOf, type DayStats, DayTracker, type TrackerState } from '../ops/dayTracker';
import { type BotMetrics, computeMetrics } from '../ops/metrics';
import type { BotStore, EquityPoint, RuntimeSnapshot } from '../persistence/botStore';
import { SimExecutionPort } from '../replay/replay';
import type { RestingStop } from '../sim/simExchange';
import { checkEntry, evaluateEquity, type EquityWatch, type OperationalState } from '../risk/riskGuard';
import type { Fill, Intent, OpenIntent } from '../core/types';
import { GatedExecutionPort } from './gatedPort';
import type { HeartbeatStatus } from './heartbeat';
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
  /** Log strutturato (F6); in assenza, nessun log. */
  logger?: Logger;
  /** Ciclo in corso, condiviso con i logger e gli alert (correlation id `cycleId`). */
  cycle?: CycleContext;
}

export interface RuntimeOptions {
  cycle?: Partial<Omit<DecisionCycleConfig, 'core' | 'startMs'>>;
  /** Dati più vecchi di così: alert STALE_DATA. */
  staleDataMs?: number;
  /** Protezione (o recovery) fallita di continuo per così tanto: alert critico e health non sano (D54). */
  protectionFailingMs?: number;
  /** Salvataggi falliti consecutivi dopo i quali gli ingressi si bloccano. */
  maxFailedSaves?: number;
  journalRetentionDays?: number;
  /** Solo test/replay: primo slot di trading per uno stato nuovo (default: il prossimo slot). */
  startMs?: number;
  /** Etichetta della fonte dei dati quando non è Kraken dal vivo (es. replay di dati storici). */
  dataSourceLabel?: string;
}

interface RiskRuntimeState {
  opState: OperationalState;
  equityWatch: EquityWatch;
  dailyLossBlockUntil: number | null;
  /** Riferimento del drawdown per il guardrail (la ripresa manuale lo riporta all'equity corrente). */
  riskHighWater: number | null;
  killRun: { runId: string; source: string; requestedAt: string } | null;
}

type Snapshot = RuntimeSnapshot<PortSnapshot> & {
  runtime: RuntimeSnapshot['runtime'] & {
    startMs: number;
    ledgerLastId?: number;
    risk?: RiskRuntimeState;
    /** Statistiche dei giorni non ancora riportati e candele mancanti recenti (F6). */
    tracker?: TrackerState;
    /** Giorno dell'ultimo checkpoint del core salvato per il confronto con il backtest. */
    checkpointDay?: string | null;
    /** Primo avvio di questo stato: il ledger di Kraken si confronta da qui in poi. */
    firstStartedAt?: string;
    /** Fee e funding del ledger di Kraken dal primo avvio. */
    ledgerTotals?: { fees: number; funding: number };
  };
};

function initialRiskState(): RiskRuntimeState {
  return { opState: 'RUNNING', equityWatch: { dayStart: null }, dailyLossBlockUntil: null, riskHighWater: null, killRun: null };
}

/** Stato di protezione di una posizione: stop nativo verificato, scoperta, in attesa, simulato (shadow). */
export type ProtectionStatus = 'NATIVE_STOP_OK' | 'UNPROTECTED' | 'PENDING' | 'SIMULATED';

export interface PositionHealth {
  id: string;
  symbol: string;
  direction: string;
  size: number;
  protection: ProtectionStatus;
  /** Livello dello stop sull'exchange (o simulato), null se non noto. */
  stopLevel: number | null;
  unprotectedSince: string | null;
}

/** Health del runtime (F6): quello che serve per sapere se il bot è sotto controllo. */
export interface HealthReport {
  healthy: boolean;
  issues: string[];
  at: string;
  mode: TradingMode;
  runtimeStatus: RuntimeStatus;
  operationalState: OperationalState;
  paused: boolean;
  entryBlock: string | null;
  lease: { holder: string | null; epoch: number | null; expiresAt: string | null; valid: boolean; reason: string | null };
  data: { lastSlot: string | null; ageMs: number | null; stale: boolean };
  cycles: { lastDecisionAt: string | null; decisionTicks: number; protectionTicks: number; failedTicks: number };
  heartbeat: HeartbeatStatus | null;
  positions: PositionHealth[];
  unknownPositions: { symbol: string; side: string; size: number; protectionId: string }[];
  allProtected: boolean;
  persistence: { healthy: boolean; writes: ReturnType<BotStore['budget']['snapshot']> };
  recentErrors: { at: string; source: 'log' | 'alert'; level: string; message: string; code?: string }[];
}

/** Frase richiesta per riprendere da REDUCE_ONLY o HALTED (azione di una persona). */
export const RESUME_CONFIRMATION = 'CONFERMO_RIPRESA';

/** Intervallo di lettura dell'account log (le API di storico hanno un budget ridotto). */
const LEDGER_SYNC_MS = 10 * 60_000;

export class BotRuntime {
  status: RuntimeStatus = 'STARTING';
  paused = false;
  lastError: string | null = null;
  private cycle: DecisionCycle | null = null;
  private port: KrakenExecutionPort | SimExecutionPort | null = null;
  private gate: GatedExecutionPort | null = null;
  private snapshot: Snapshot | null = null;
  private snapshotLoaded = false;
  /** Motivo per cui lo stato salvato non si può usare: il bot resta fermo fino al riavvio (D51, D53). */
  private stateRefusal: string | null = null;
  /** Inizio della serie di cicli di protezione (o recovery) falliti, con l'ultimo errore (D54). */
  private protectionFailure: { since: number; error: string; alerted: boolean } | null = null;
  private startMs: number | null = null;
  private failedSaves = 0;
  private persistenceHealthy = true;
  private staleAlerted = false;
  private lastPruneDay = '';
  private lastDecisionAt: number | null = null;
  private ledgerLastId = 0;
  private risk: RiskRuntimeState = initialRiskState();
  private lastLedgerSync = 0;
  readonly recentLedger: LedgerEntry[] = [];
  private tracker = new DayTracker();
  private checkpointDay: string | null = null;
  private firstStartedAt: string | null = null;
  private ledgerTotals = { fees: 0, funding: 0 };
  private historyLoaded = false;
  /** Tutti i trade chiusi dello stato attuale (dal più recente): base delle metriche. */
  readonly allTrades: TradeRecord[] = [];
  private readonly reportTasks = new Set<Promise<void>>();
  private readonly savedTrades = new Set<string>();
  private readonly reporting = new Set<string>();
  latestReport: DailyReport | null = null;
  private lock: Promise<unknown> = Promise.resolve();
  readonly startedAt: number;
  readonly recentJournal: DecisionRecord[] = [];
  readonly recentTrades: TradeRecord[] = [];
  readonly equityHistory: EquityPoint[] = [];
  /** Alert di tutti i componenti (se il factory passa lo stesso registro anche allo StopManager). */
  private readonly alertSink: RecordingAlertSink;
  readonly counters = { decisionTicks: 0, protectionTicks: 0, failedTicks: 0 };

  constructor(private readonly deps: RuntimeDeps, private readonly options: RuntimeOptions = {}) {
    if (deps.config.mode !== 'shadow' && !deps.kraken) throw new Error(`Modalità ${deps.config.mode} senza execution layer Kraken`);
    if (deps.config.mode === 'shadow' && deps.kraken) throw new Error('In shadow il runtime non riceve l execution layer Kraken');
    this.startedAt = deps.now();
    this.alertSink = deps.alerts instanceof RecordingAlertSink ? deps.alerts : new RecordingAlertSink(deps.alerts);
  }

  get recentAlerts(): readonly Alert[] {
    return this.alertSink.recent;
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

  private get logger(): Logger {
    return (this.deps.logger ??= Logger.silent());
  }

  private log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    this.logger.log(level, message, context);
  }

  /** Esegue `fn` in esclusiva con un correlation id di ciclo (D decisione, P protezione, K kill switch, R recovery, C controllo). */
  private inCycle<T>(kind: 'D' | 'P' | 'K' | 'R' | 'C', fn: () => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      const cycle = this.deps.cycle;
      if (cycle) cycle.current = `${kind}-${new Date(this.deps.now()).toISOString().replace(/[-:.]/g, '').slice(0, 15)}Z`;
      try {
        return await fn();
      } finally {
        if (cycle) cycle.current = null;
      }
    });
  }

  private async alert(level: AlertLevel, code: AlertCode, message: string, context?: Record<string, unknown>): Promise<void> {
    const alert = makeAlert(this.deps.now(), level, code, message, context);
    try {
      await this.alertSink.send(alert);
    } catch (err) {
      this.log('error', `Invio dell'alert ${code} fallito: ${(err as Error).message}`);
    }
  }

  /** Alert da componenti esterni al runtime (heartbeat, prova del canale): stessa coda e stesso canale. */
  raiseAlert(level: AlertLevel, code: AlertCode, message: string, context?: Record<string, unknown>): Promise<void> {
    return this.alert(level, code, message, context);
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

  /** Protezione ferma da oltre la soglia (null = funziona o il guasto è appena iniziato). */
  private protectionStalled(now: number): string | null {
    const failure = this.protectionFailure;
    if (failure === null || now - failure.since < (this.options.protectionFailingMs ?? 90_000)) return null;
    return `protezione ferma da ${Math.round((now - failure.since) / 1000)} s (${failure.error})`;
  }

  /**
   * Esito di un ciclo di protezione o di un tentativo di recovery con Kraken (error null = riuscito).
   * Oltre la soglia: un alert critico e health non sano; al ritorno, un alert di ripristino (D54).
   * Gli ingressi sono già fermi: il ciclo decisionale riconcilia con Kraken prima di ogni slot
   * (settle), quindi senza Kraken non decide nulla; al ritorno gli ingressi ormai tardivi non partono.
   */
  private async trackProtection(now: number, error: string | null): Promise<void> {
    const failure = this.protectionFailure;
    if (error === null) {
      this.protectionFailure = null;
      if (failure?.alerted) await this.alert('info', 'PROTECTION_FAILING', `Protezione di nuovo attiva dopo ${Math.max(1, Math.round((now - failure.since) / 60_000))} min`);
      return;
    }
    const current = failure ? { ...failure, error } : { since: now, error, alerted: false };
    this.protectionFailure = current;
    const stalled = this.protectionStalled(now);
    if (stalled !== null && !current.alerted) {
      current.alerted = true;
      const stops = this.mode === 'shadow' ? '' : '; gli stop nativi già su Kraken restano attivi';
      await this.alert('critical', 'PROTECTION_FAILING', `${stalled.charAt(0).toUpperCase()}${stalled.slice(1)}: nessuna nuova decisione finché non riprende${stops}`);
    }
  }

  // --- Recovery -------------------------------------------------------------------------------

  /** Porta il runtime in RUNNING eseguendo i passi di recovery mancanti. Idempotente. */
  ensureRunning(): Promise<RuntimeStatus> {
    return this.inCycle('R', () => this.recover());
  }

  private async recover(): Promise<RuntimeStatus> {
    if (this.status === 'RUNNING' || this.status === 'STOPPED') return this.status;
    // Stato salvato non utilizzabile: serve una persona (configurazione o database), poi un riavvio.
    if (this.stateRefusal !== null) return this.status;
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
    // Lo stato di un bot di un'altra modalità non si usa, e il suo lease non si prende.
    if (await this.refuseForeignState(this.snapshot)) return this.status;
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
      if (await this.refuseForeignState(this.snapshot)) return this.status;
      try {
        this.build(now);
      } catch (err) {
        // Errore deterministico (lo stato non cambia da solo): non si riprova a ogni ciclo.
        await this.refuseState(`stato salvato non utilizzabile: ${(err as Error).message}`);
        return this.status;
      }
    }
    const cycle = this.cycle as DecisionCycle;
    try {
      if (this.port instanceof KrakenExecutionPort) {
        // 3-5. Intenti in sospeso, riconciliazione con Kraken e verifica degli stop. Con un kill
        // switch in corso la riconciliazione la fa il kill switch stesso (chiusure KILL_SWITCH).
        const unsent = await this.adoptPendingIntents(this.port, cycle);
        if (this.risk.opState !== 'HALTING') {
          await this.port.protect();
          if (unsent.length > 0) {
            // Prima gli esiti trovati dalla riconciliazione (chiusure, ingressi eseguiti), così il
            // core rispecchia Kraken quando gli intenti rimasti partono.
            const drained = cycle.applyExternal(this.port.drain());
            await this.afterTick({ processedSlots: 0, waiting: false, lastSlot: cycle.state.lastSlot, intents: [], journal: [], trades: drained.trades, events: [], equity: [], fills: drained.fills });
            await this.resendUnsent(unsent, cycle);
          }
        }
      }
      // 6. Storico delle candele e ripresa.
      await cycle.start();
    } catch (err) {
      this.lastError = `recovery incompleto: ${(err as Error).message}`;
      this.log('warn', this.lastError);
      // Il ciclo va ricostruito al prossimo tentativo (start() non è ripetibile).
      this.cycle = null;
      this.port = null;
      await this.trackProtection(now, this.lastError);
      return this.status;
    }
    this.status = 'RUNNING';
    this.lastError = null;
    await this.trackProtection(now, null);
    await this.loadHistory();
    await this.ensureDayCheckpoint();
    await this.persist();
    this.log('info', `Runtime in esecuzione (${this.mode}, lease epoch ${this.deps.lease.lease?.epoch})`);
    return this.status;
  }

  /** Stato salvato da un bot di un'altra modalità sullo stesso database (D51). */
  private async refuseForeignState(snap: Snapshot | null): Promise<boolean> {
    if (!snap || snap.mode === this.mode) return false;
    await this.refuseState(
      `lo stato salvato è di un bot in modalità ${snap.mode}, questa istanza è in ${this.mode}: il database è di un altro bot. ` +
        'Serve un database Firestore per ogni modalità (FIRESTORE_DATABASE_ID)',
    );
    return true;
  }

  /** Il bot non opera con questo stato: SAFE_MODE senza lease, un alert critico, nessuna scrittura. */
  private async refuseState(reason: string): Promise<void> {
    this.stateRefusal = reason;
    this.lastError = reason;
    this.status = 'SAFE_MODE';
    this.cycle = null;
    this.port = null;
    this.gate = null;
    await this.deps.lease.release().catch(() => undefined);
    await this.alert('critical', 'STATE_REFUSED', `Il bot non opera: ${reason}`);
  }

  private build(now: number): void {
    const snap = this.snapshot;
    this.paused = snap?.runtime.paused ?? false;
    this.ledgerLastId = snap?.runtime.ledgerLastId ?? 0;
    if (snap?.runtime.risk) this.risk = snap.runtime.risk;
    this.tracker = new DayTracker(snap?.runtime.tracker ?? {});
    this.checkpointDay = snap?.runtime.checkpointDay ?? null;
    this.firstStartedAt = snap?.runtime.firstStartedAt ?? this.firstStartedAt ?? new Date(now).toISOString();
    this.ledgerTotals = snap?.runtime.ledgerTotals ?? this.ledgerTotals;
    this.startMs = snap?.runtime.startMs ?? this.options.startMs ?? Math.floor(now / BAR_15M_MS) * BAR_15M_MS + BAR_15M_MS;
    const kraken = this.deps.kraken;
    if (kraken) {
      if (snap && snap.port.kind !== 'kraken') throw new Error('Stato persistito di un altro tipo di esecuzione (shadow): non riutilizzabile in demo/live');
      const portState = snap && snap.port.kind === 'kraken' ? snap.port.state : initialKrakenPortState();
      this.port = new KrakenExecutionPort(
        { mode: this.mode, adapter: kraken.adapter, orders: kraken.orders, stops: kraken.stops, instruments: kraken.instruments, alerts: this.alertSink, funding: kraken.funding, now: this.deps.now },
        kraken.portConfig,
        portState,
      );
    } else {
      const simState = snap && snap.port.kind === 'sim' ? snap.port.state : { stops: [] };
      this.port = new SimExecutionPort(REALISTIC_PROFILE.execution, { kind: 'none' }, simState);
    }
    this.gate = new GatedExecutionPort(this.port, (intent, approved) => this.guardEntry(intent, approved));
    this.cycle = new DecisionCycle(this.cycleConfig(this.startMs), { source: this.deps.source, port: this.gate, checkpoint: (pending) => this.checkpoint(pending.trades) }, snap?.core);
  }

  /**
   * Allinea gli intenti rimasti in sospeso nel core con l'archivio degli ordini: un ordine inviato
   * prima del crash viene riconciliato. Restituisce gli intenti decisi e mai inviati (il record
   * dell'ordine si salva prima dell'invio: senza record l'ordine non è mai partito).
   */
  private async adoptPendingIntents(port: KrakenExecutionPort, cycle: DecisionCycle): Promise<Intent[]> {
    const orders = (this.deps.kraken as KrakenRuntimeDeps).orders;
    const unsent: Intent[] = [];
    for (const pending of Object.values(cycle.state.pendingCloses)) {
      const positionId = pending.intent.positionId;
      const pos = port.state.positions[positionId];
      const exits = (await orders.store.byIntent(positionId)).filter((r) => r.purpose === 'EXIT' || r.purpose === 'EMERGENCY_CLOSE');
      if (pos && exits.length > 0) pos.closing ??= { reason: pending.intent.exitType, since: this.deps.now() };
      else if (pos) unsent.push(pending.intent);
      else if (exits.length === 0) cycle.rejectPending(positionId);
    }
    for (const intent of Object.values(cycle.state.pendingOpens)) {
      if (port.state.pendingEntries[intent.positionId] || port.state.positions[intent.positionId] || port.state.deferredEntries[intent.positionId]) continue;
      const cliOrdId = makeCliOrdId(intent.positionId, 'ENTRY', 1);
      if (await orders.store.get(cliOrdId)) port.state.pendingEntries[intent.positionId] = { intent, cliOrdId };
      else unsent.push(intent);
    }
    return unsent;
  }

  /**
   * Intenti decisi prima del riavvio e mai inviati (D49): le uscite partono sempre, gli ingressi
   * solo se sono ancora nella finestra del ciclo (come senza riavvio); gli altri si annullano.
   */
  private async resendUnsent(unsent: readonly Intent[], cycle: DecisionCycle): Promise<void> {
    if (unsent.length === 0) return;
    const now = this.deps.now();
    const maxDelay = this.cycleConfig(this.startMs as number).maxEntryDelayMs;
    const send: Intent[] = [];
    for (const intent of unsent) {
      const delay = now - slotEnd(intent.slotTime);
      if (intent.kind === 'OPEN' && delay > maxDelay) {
        cycle.rejectPending(intent.positionId);
        await this.alert('warning', 'EXECUTION_ERROR', `Ingresso ${intent.symbol} deciso prima del riavvio e mai inviato: ${Math.round(delay / 60_000)} minuti dopo la decisione, annullato`, { positionId: intent.positionId });
      } else {
        send.push(intent);
      }
    }
    if (send.length === 0) return;
    this.log('info', `Recovery: invio di ${send.length} intenti decisi prima del riavvio e mai inviati`);
    const report = await (this.gate as GatedExecutionPort).execute(send);
    const applied = cycle.applyExternal(report);
    await this.afterTick({ processedSlots: 0, waiting: false, lastSlot: cycle.state.lastSlot, intents: [], journal: [], trades: applied.trades, events: [], equity: [], fills: applied.fills });
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
        risk: this.risk,
        tracker: this.tracker.snapshot(),
        checkpointDay: this.checkpointDay,
        firstStartedAt: this.firstStartedAt ?? new Date(this.startedAt).toISOString(),
        ledgerTotals: this.ledgerTotals,
      },
    };
  }

  /** Salvataggio write-ahead prima dell'esecuzione: se fallisce il ciclo non invia ingressi. */
  private async checkpoint(trades: readonly TradeRecord[] = []): Promise<void> {
    // Prima i trade già chiusi nel tick: lo stato che segue li contiene (D50). Un errore qui
    // blocca gli ingressi del ciclo, come il salvataggio dello stato.
    for (const trade of trades) await this.persistTrade(trade);
    const data = this.snapshotData();
    if (data) await this.deps.store.saveSnapshot(data);
  }

  /** Salva un trade chiuso (una volta: il documento è per posizione, un secondo salvataggio non serve). */
  private async persistTrade(trade: TradeRecord): Promise<void> {
    const positionId = `${trade.symbol.split('/')[0]}-${trade.entryTime}`;
    if (this.savedTrades.has(positionId)) return;
    await this.deps.store.appendTrade(positionId, trade);
    this.savedTrades.add(positionId);
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

  // --- Storico, checkpoint del giorno e report giornaliero (F6) ------------------------------------

  /** Dopo un riavvio: trade, equity e journal recenti dall'archivio (dashboard e metriche). */
  private async loadHistory(): Promise<void> {
    if (this.historyLoaded) return;
    this.historyLoaded = true;
    try {
      const trades = await this.deps.store.recentTrades(100_000);
      this.allTrades.splice(0, this.allTrades.length, ...trades);
      this.recentTrades.splice(0, this.recentTrades.length, ...trades.slice(0, 200));
      this.equityHistory.splice(0, this.equityHistory.length, ...(await this.deps.store.equityHistory(30)));
      const lastSlot = this.cycle?.state.lastSlot ?? null;
      if (lastSlot !== null) this.recentJournal.splice(0, this.recentJournal.length, ...(await this.deps.store.decisionsBetween(lastSlot - 24 * 3_600_000, lastSlot)).slice(-500));
    } catch (err) {
      this.log('warn', `Storico non caricato dall archivio: ${(err as Error).message}`);
    }
  }

  private dayCheckpoint(day: string): DayCheckpoint {
    const cycle = this.cycle as DecisionCycle;
    return { day, savedAt: new Date(this.deps.now()).toISOString(), core: cycle.snapshot(), simStops: this.port instanceof SimExecutionPort ? this.port.snapshot().stops : null };
  }

  private async saveDayCheckpoint(checkpoint: DayCheckpoint): Promise<void> {
    this.checkpointDay = checkpoint.day;
    try {
      await this.deps.store.saveDayCheckpoint(checkpoint);
    } catch (err) {
      this.log('warn', `Checkpoint del giorno ${checkpoint.day} non salvato: ${(err as Error).message}`);
    }
  }

  /** All'avvio: checkpoint del giorno in corso se manca (il confronto parte da qui). */
  private async ensureDayCheckpoint(): Promise<void> {
    const lastSlot = this.cycle?.state.lastSlot ?? null;
    if (lastSlot === null) return;
    const day = dayOf(lastSlot + BAR_15M_MS);
    if (this.checkpointDay !== day) await this.saveDayCheckpoint(this.dayCheckpoint(day));
  }

  /** Avvia i report dei giorni conclusi (in background: il replay scarica le candele). */
  private scheduleReports(lastSlot: number | null): void {
    if (lastSlot === null) return;
    for (const day of this.tracker.completedBefore(dayOf(lastSlot))) {
      if (this.reporting.has(day)) continue;
      // Con Kraken si aspetta una lettura dell'account log dopo la fine del giorno (fee e funding completi).
      if (this.deps.kraken?.ledger && this.lastLedgerSync < Date.parse(`${day}T00:00:00Z`) + 86_400_000) continue;
      this.reporting.add(day);
      const stats = structuredClone(this.tracker.days[day]);
      const replayFills = structuredClone(this.tracker.fillsAppliedIn(day));
      const task: Promise<void> = this.generateReport(day, stats, replayFills)
        .then(() => {
          delete this.tracker.days[day];
        })
        .catch((err) => this.log('error', `Report del ${day} non generato: ${(err as Error).message}`))
        .finally(() => {
          this.reporting.delete(day);
          this.reportTasks.delete(task);
        });
      this.reportTasks.add(task);
    }
  }

  /** Attende i report in corso (test e arresto ordinato). */
  async flushReports(): Promise<void> {
    while (this.reportTasks.size > 0) await Promise.all([...this.reportTasks]);
  }

  private async dayParity(day: string, dayStats: DayStats, replayFills: DayStats['fills']): Promise<ParityResult> {
    // Il replay rigioca gli slot del giorno: servono i fill APPLICATI in quegli slot (anche se eseguiti dopo mezzanotte).
    const stats: DayStats = { ...dayStats, fills: replayFills };
    const mode: ParityResult['mode'] = this.mode === 'shadow' ? 'simulated' : 'actual_fills';
    const checkpoint = await this.deps.store.loadDayCheckpoint(day);
    if (!checkpoint) return notAvailable('nessun checkpoint di inizio giorno (salvataggio saltato o archivio non disponibile)', mode);
    if (mode === 'simulated' && stats.fills.some((f) => f.phase === 'external')) return notAvailable('kill switch nel giorno: chiusure fuori dal modello del backtest', mode);
    const { core: _core, ...cycleConfig } = this.cycleConfig(this.startMs as number);
    const replay = await replayDay({ mode, day, checkpoint, stats, cycle: cycleConfig, core: this.coreConfig(), source: this.deps.source });
    const dayEnd = replay.toSlot + BAR_15M_MS;
    const inRange = (t: TradeRecord) => Date.parse(t.exitTime) >= replay.fromSlot && Date.parse(t.exitTime) <= dayEnd;
    return compareDay({
      mode,
      fromSlot: replay.fromSlot,
      toSlot: replay.toSlot,
      actualJournal: await this.deps.store.decisionsBetween(replay.fromSlot, replay.toSlot),
      replayJournal: replay.journal,
      ...(mode === 'simulated' ? { actualTrades: this.allTrades.filter(inRange), replayTrades: replay.trades.filter(inRange) } : {}),
      missing: stats.missing,
      recentMissing: this.tracker.recentMissing,
      btcSymbol: this.deps.config.symbols.includes('BTC') ? 'BTC' : undefined,
    });
  }

  private async generateReport(day: string, stats: DayStats, replayFills: DayStats['fills']): Promise<DailyReport> {
    let parity: ParityResult;
    try {
      parity = await this.dayParity(day, stats, replayFills);
    } catch (err) {
      parity = notAvailable(`replay non riuscito: ${(err as Error).message}`, this.mode === 'shadow' ? 'simulated' : 'actual_fills');
    }
    const dayStart = Date.parse(`${day}T00:00:00Z`);
    const dayEnd = dayStart + 86_400_000;
    const before = this.equityHistory.filter((p) => p.t < dayStart).at(-1);
    const report = buildDailyReport({
      day,
      mode: this.mode,
      generatedAt: new Date(this.deps.now()).toISOString(),
      stats,
      trades: this.allTrades.filter((t) => t.exitTime >= `${day}T00:00:00` && t.exitTime < new Date(dayEnd).toISOString()),
      equity: [...(before ? [before] : []), ...this.equityHistory.filter((p) => p.t >= dayStart && p.t < dayEnd)].map((p) => ({ t: p.t, equity: p.equity })),
      ledger: this.deps.kraken ? await this.deps.store.ledgerOfDay(day) : null,
      modelSlippageBps: REALISTIC_PROFILE.execution.slippageBps,
      parity,
      alerts: this.recentAlerts.filter((a) => a.at.startsWith(day)),
    });
    await this.deps.store.saveDailyReport(report);
    this.latestReport = report;
    await this.alert(report.issues.length > 0 ? 'warning' : 'info', 'DAILY_REPORT', summarizeReport(report), { day });
    this.log('info', `Report giornaliero ${day}: parità ${parity.status}`, { day, parity: parity.status, issues: report.issues.length });
    return report;
  }

  /** Report giornalieri per l'API (dal più recente). */
  dailyReports(limit = 30): Promise<DailyReport[]> {
    return this.deps.store.recentDailyReports(limit);
  }

  dailyReport(day: string): Promise<DailyReport | null> {
    return this.deps.store.dailyReport(day);
  }

  /** Metriche del bot, dagli stessi dati del ledger (trade, equity) e confrontate con Kraken. */
  metrics(): BotMetrics {
    const core = this.cycle?.state ?? null;
    const cap = this.deps.config.limits.capitalCapUsd;
    return computeMetrics({
      initialEquity: cap,
      currentEquity: core?.capital?.trueEquity ?? core?.realizedEquity ?? cap,
      realizedEquity: core?.realizedEquity ?? cap,
      trades: this.allTrades,
      equity: this.equityHistory.map((p) => ({ t: p.t, equity: p.equity })),
      ledger: this.deps.kraken ? this.ledgerTotals : null,
      now: this.deps.now(),
    });
  }

  // --- Guardrail (F5) ----------------------------------------------------------------------------

  /** Controllo di ogni ingresso prima dell'invio: pausa, persistenza, lease e RiskGuard. */
  private guardEntry(intent: OpenIntent, approved: readonly OpenIntent[]): string | null {
    const block = this.entryBlockReason();
    if (block !== null) return block;
    const cycle = this.cycle as DecisionCycle;
    const core = cycle.state;
    const equity = core.capital?.trueEquity ?? core.realizedEquity;
    const verdict = checkEntry(
      intent,
      {
        state: this.risk.opState,
        dailyLossBlockUntil: this.risk.dailyLossBlockUntil,
        openPositions: cycle.openPositions().filter((p) => !core.pendingCloses[p.id]),
        approved,
        // Mai oltre il collateral del conto (sezione 2).
        equity: core.sizingEquityCap === null ? equity : Math.min(equity, core.sizingEquityCap),
        now: this.deps.now(),
      },
      this.deps.config.limits,
    );
    if (verdict.outcome === 'allowed') return null;
    const unexpected = verdict.code !== 'REDUCE_ONLY' && verdict.code !== 'HALTED' && verdict.code !== 'DAILY_LOSS';
    if (unexpected) void this.alert('warning', 'RISK_REJECTED', `Ingresso ${intent.symbol} rifiutato dal RiskGuard (${verdict.code}): ${verdict.reason}`, { positionId: intent.positionId });
    return `${verdict.code}: ${verdict.reason}`;
  }

  /** Perdita giornaliera e drawdown dopo ogni ciclo decisionale. */
  private async evaluateRisk(now: number): Promise<void> {
    const core = (this.cycle as DecisionCycle).state;
    if (!core.capital) return;
    const trueEquity = core.capital.trueEquity;
    this.risk.riskHighWater = Math.max(this.risk.riskHighWater ?? core.maxHistoricalEquity, trueEquity);
    const e = evaluateEquity(this.risk.equityWatch, { trueEquity, maxHistoricalEquity: this.risk.riskHighWater }, now, this.deps.config.limits);
    this.risk.equityWatch = { dayStart: e.dayStart };
    if (e.dailyLossBlockUntil !== null && this.risk.dailyLossBlockUntil !== e.dailyLossBlockUntil) {
      this.risk.dailyLossBlockUntil = e.dailyLossBlockUntil;
      await this.alert('critical', 'RISK_LIMIT', `Perdita giornaliera ${e.dailyLossPct.toFixed(2)}% (limite ${this.deps.config.limits.maxDailyLossPct}%): nessun nuovo ingresso fino a ${new Date(e.dailyLossBlockUntil).toISOString()}`);
    }
    if (this.risk.dailyLossBlockUntil !== null && now >= this.risk.dailyLossBlockUntil) this.risk.dailyLossBlockUntil = null;
    if (e.drawdownBreached && this.risk.opState === 'RUNNING') {
      this.risk.opState = 'REDUCE_ONLY';
      await this.alert('critical', 'RISK_LIMIT', `Drawdown ${e.drawdownPct.toFixed(2)}% (limite ${this.deps.config.limits.drawdownReduceOnlyPct}%): REDUCE_ONLY, solo uscite. Ripresa solo manuale`);
    }
  }

  /** Kill switch: da API, dashboard o flag. Idempotente: una seconda richiesta non ne avvia un'altra. */
  killSwitch(source: string): Promise<{ opState: OperationalState; steps: string[] }> {
    return this.inCycle('K', async () => {
      if (this.status !== 'RUNNING') {
        throw new Error(`Kill switch non eseguibile: runtime ${this.status}. In emergenza POST /api/emergency-kraken-transfer chiude le posizioni direttamente su Kraken`);
      }
      if (this.risk.opState === 'HALTED') return { opState: 'HALTED' as OperationalState, steps: ['già fermo: nessuna azione'] };
      if (!this.risk.killRun) {
        this.risk.killRun = { runId: new Date(this.deps.now()).toISOString().replace(/[^0-9]/g, '').slice(0, 14), source, requestedAt: new Date(this.deps.now()).toISOString() };
        this.risk.opState = 'HALTING';
        await this.persist();
        await this.alert('critical', 'KILL_SWITCH', `Kill switch attivato (${source}): chiusura di tutte le posizioni`);
      }
      return this.killStep();
    });
  }

  /** Un passo del kill switch; si ripete a ogni ciclo di protezione finché il conto non è flat. */
  private async killStep(): Promise<{ opState: OperationalState; steps: string[] }> {
    const run = this.risk.killRun as NonNullable<RiskRuntimeState['killRun']>;
    const cycle = this.cycle as DecisionCycle;
    let flat: boolean;
    let steps: string[];
    if (this.port instanceof KrakenExecutionPort) {
      ({ flat, steps } = await this.port.killSwitch(run.runId));
      const { trades, fills } = cycle.applyExternal(this.port.drain());
      await this.afterTick({ processedSlots: 0, waiting: false, lastSlot: cycle.state.lastSlot, intents: [], journal: [], trades, events: [], equity: [], fills });
    } else {
      // Shadow: chiusure simulate all'ultimo prezzo noto e cancellazione degli stop simulati.
      const core = cycle.state;
      const fee = this.coreConfig().feeRate;
      const fills: Fill[] = cycle.openPositions().map((p) => {
        const price = core.lastClose[p.symbol] ?? p.trade.entryPrice;
        return { kind: 'CLOSE', symbol: p.symbol, positionId: p.id, price, size: p.trade.size, fee: p.trade.size * price * fee, time: this.deps.now(), exitType: 'KILL_SWITCH', source: 'sim' };
      });
      for (const id of Object.keys(core.pendingOpens)) cycle.rejectPending(id);
      const applied = cycle.applyExternal({ fills, rejected: [] });
      (this.port as SimExecutionPort).exchange.cancelAll();
      await this.afterTick({ processedSlots: 0, waiting: false, lastSlot: core.lastSlot, intents: [], journal: [], trades: applied.trades, events: [], equity: [], fills: applied.fills });
      flat = true;
      steps = [`chiuse ${fills.length} posizioni simulate`];
    }
    if (flat) {
      for (const id of Object.keys(cycle.state.pendingOpens)) cycle.rejectPending(id);
      const leftover = cycle.openPositions();
      if (leftover.length > 0) await this.alert('critical', 'DESYNC', `Kill switch: conto flat ma il core ha ancora ${leftover.map((p) => p.id).join(', ')}`);
      this.risk.opState = 'HALTED';
      await this.alert('critical', 'KILL_SWITCH', `Kill switch completato: conto flat, bot fermo (${run.source})`, { steps });
    }
    await this.persist();
    return { opState: this.risk.opState, steps };
  }

  /** Ripresa da REDUCE_ONLY o HALTED: solo con conferma esplicita di una persona. */
  resumeRisk(confirmation: string): Promise<OperationalState> {
    return this.inCycle('C', async () => {
      if (confirmation !== RESUME_CONFIRMATION) throw new Error(`Conferma mancante: inviare "${RESUME_CONFIRMATION}"`);
      if (this.risk.opState === 'HALTING') throw new Error('Kill switch in corso: attendere HALTED');
      // Da RUNNING non c'è nulla da riprendere (e il riferimento del drawdown non si sposta).
      if (this.risk.opState === 'RUNNING') throw new Error('Nessuna ripresa necessaria: il bot è già in RUNNING');
      if (await this.controlFlag()) throw new Error('Il flag kill switch su Firestore è ancora attivo: disattivarlo prima');
      const core = this.cycle?.state;
      this.risk = { ...this.risk, opState: 'RUNNING', killRun: null, riskHighWater: core?.capital?.trueEquity ?? core?.realizedEquity ?? null };
      await this.persist();
      await this.alert('warning', 'MODE_CHANGE', 'Ripresa manuale: ingressi riabilitati (riferimento del drawdown del guardrail riportato all equity attuale)');
      return this.risk.opState;
    });
  }

  /**
   * Flag kill switch su Firestore (`bot_runtime/control`, campo `killSwitch`), impostabile anche a
   * mano dalla console senza passare dalle API. Vale come attivo `true` o la stringa "true".
   */
  private async controlFlag(): Promise<boolean> {
    const control = await this.deps.store.docs.get<{ killSwitch?: unknown }>('bot_runtime/control');
    const flag = control?.killSwitch;
    return flag === true || (typeof flag === 'string' && flag.trim().toLowerCase() === 'true');
  }

  get operationalState(): OperationalState {
    return this.risk.opState;
  }

  // --- Cicli ------------------------------------------------------------------------------------

  decisionTick(now: number): Promise<TickResult | null> {
    return this.inCycle('D', async () => {
      if (this.status !== 'RUNNING' && (await this.recover()) !== 'RUNNING') return null;
      if (this.deps.lease.canWrite() !== null && !(await this.deps.lease.renew())) {
        await this.onLeaseLost();
        return null;
      }
      if (this.risk.opState === 'HALTING') return null; // il kill switch ha la precedenza
      const cycle = this.cycle as DecisionCycle;
      // Il prossimo slot apre un nuovo giorno UTC: lo stato di adesso è il checkpoint del giorno.
      const before = cycle.state.lastSlot;
      const crossing = before !== null && dayOf(before) !== dayOf(before + BAR_15M_MS) && this.checkpointDay !== dayOf(before + BAR_15M_MS) ? this.dayCheckpoint(dayOf(before + BAR_15M_MS)) : null;
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
      if (crossing && result.processedSlots > 0) await this.saveDayCheckpoint(crossing);
      else if (this.checkpointDay === null) await this.ensureDayCheckpoint(); // stato nuovo: primo checkpoint
      await this.afterTick(result);
      await this.evaluateRisk(now);
      this.scheduleReports(result.lastSlot);
      await this.persist();
      return result;
    });
  }

  private async afterTick(result: TickResult): Promise<void> {
    const store = this.deps.store;
    this.tracker.record(result, this.deps.now());
    for (const intent of result.intents) {
      const detail = intent.kind === 'OPEN' ? `${intent.direction} size ${intent.size} leva ${intent.leverage}x rif. ${intent.referencePrice}` : intent.kind === 'CLOSE' ? `${intent.exitType} rif. ${intent.referencePrice}` : `stop ${intent.strategyStop} backstop ${intent.backstop}`;
      this.log('info', `Intento ${intent.kind} ${intent.symbol}: ${detail}`, { positionId: intent.positionId, symbol: intent.symbol });
    }
    // In demo e live l'alert di ingresso lo invia la porta Kraken (con il cliOrdId); in shadow qui.
    for (const fill of result.fills.filter((f) => f.kind === 'OPEN' && f.source === 'sim')) {
      await this.alert('info', 'ENTRY', `Ingresso ${fill.side === 'buy' ? 'LONG' : 'SHORT'} ${fill.symbol} (simulato): ${Number(fill.size.toPrecision(6))} a ${fill.price}`, { positionId: fill.positionId });
    }
    for (const trade of result.trades) {
      const positionId = `${trade.symbol.split('/')[0]}-${trade.entryTime}`;
      this.log('info', `Trade chiuso ${trade.symbol} ${trade.type} (${trade.reason}): ${trade.pnl.toFixed(2)} $`, { positionId, pnl: trade.pnl, reason: trade.reason });
      this.recentTrades.unshift(trade);
      this.allTrades.unshift(trade);
      try {
        await this.persistTrade(trade);
      } catch (err) {
        this.lastError = `trade non salvato: ${(err as Error).message}`;
      }
      await this.alert('info', 'EXIT', `Trade chiuso ${trade.symbol} ${trade.type} (${trade.reason}): ${trade.pnl.toFixed(2)} $`, { positionId });
    }
    if (this.recentTrades.length > 200) this.recentTrades.length = 200;
    // Intenti respinti (guardrail o exchange): nel journal con il motivo e nel log.
    const intents = new Map(result.intents.map((i) => [i.positionId, i] as const));
    const rejected: DecisionRecord[] = [];
    for (const event of result.events) {
      if (event.type !== 'INTENT_REJECTED') continue;
      const intent = intents.get(event.positionId);
      rejected.push({ slotTime: event.slot, symbol: intent?.symbol ?? event.positionId.split('-')[0], action: 'REJECTED', reason: `${intent?.kind ?? 'intento'} ${event.positionId}: ${event.reason}`, ...(intent ? { direction: intent.direction } : {}) });
      this.log('warn', `Intento ${event.positionId} respinto: ${event.reason}`);
    }
    const bySlot = new Map<number, DecisionRecord[]>();
    for (const r of [...result.journal, ...rejected]) bySlot.set(r.slotTime, [...(bySlot.get(r.slotTime) ?? []), r]);
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
    return this.inCycle('P', async () => {
      if (this.status !== 'RUNNING' && (await this.recover()) !== 'RUNNING') return;
      if (!(await this.deps.lease.renew())) {
        await this.onLeaseLost();
        return;
      }
      this.counters.protectionTicks++;
      // Una lettura fallita del flag non deve fermare la protezione (stop e riconciliazione).
      let flag = false;
      try {
        flag = this.risk.opState === 'RUNNING' || this.risk.opState === 'REDUCE_ONLY' ? await this.controlFlag() : false;
      } catch (err) {
        this.lastError = `flag del kill switch non letto: ${(err as Error).message}`;
        this.log('warn', this.lastError);
      }
      if (flag) {
        this.risk.killRun = { runId: new Date(now).toISOString().replace(/[^0-9]/g, '').slice(0, 14), source: 'flag Firestore', requestedAt: new Date(now).toISOString() };
        this.risk.opState = 'HALTING';
        await this.persist();
        await this.alert('critical', 'KILL_SWITCH', 'Kill switch attivato dal flag su Firestore: chiusura di tutte le posizioni');
      }
      if (this.risk.opState === 'HALTING') {
        // Il kill switch ha la precedenza sulla protezione ordinaria; si ripete finché non è flat.
        try {
          await this.killStep();
          await this.trackProtection(now, null);
        } catch (err) {
          this.lastError = `kill switch: ${(err as Error).message}`;
          this.log('warn', this.lastError);
          await this.persist();
          await this.trackProtection(now, this.lastError);
        }
        return;
      }
      if (this.port instanceof KrakenExecutionPort) {
        let protectedOk = false;
        try {
          await this.port.protect();
          protectedOk = true;
          await this.updateSizingCap();
          await this.syncLedger(now);
        } catch (err) {
          this.lastError = `ciclo di protezione: ${(err as Error).message}`;
          this.log('warn', this.lastError);
        }
        // Conta solo la protezione (riconciliazione e stop): sizing e ledger si ripetono da soli.
        await this.trackProtection(now, protectedOk ? null : this.lastError);
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
    // Totali dal primo avvio del bot (le voci precedenti del conto non sono del bot).
    const since = this.firstStartedAt ?? new Date(this.startedAt).toISOString();
    for (const e of added.filter((x) => x.date >= since)) {
      this.ledgerTotals.fees += e.fee ?? 0;
      this.ledgerTotals.funding += e.realizedFunding ?? 0;
    }
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
    // La protezione passa all'istanza con il lease: un guasto in corso non è più di questa istanza.
    this.protectionFailure = null;
    await this.alert('critical', 'LEASE_LOST', 'Lease d istanza perso: questa istanza smette subito di inviare ordini');
  }

  // --- Controllo ----------------------------------------------------------------------------------

  pause(): Promise<void> {
    return this.inCycle('C', async () => {
      this.paused = true;
      await this.persist();
      await this.alert('info', 'MODE_CHANGE', 'Bot in pausa: nessun nuovo ingresso, uscite e stop attivi');
    });
  }

  resume(): Promise<void> {
    return this.inCycle('C', async () => {
      this.paused = false;
      await this.persist();
      await this.alert('info', 'MODE_CHANGE', 'Bot ripreso');
    });
  }

  /** Solo shadow: riparte da uno stato nuovo. Con ordini reali lo stato non si azzera mai (D28, D34). */
  reset(): Promise<void> {
    return this.inCycle('C', async () => {
      if (this.mode !== 'shadow') throw new Error('Reset non consentito in demo e live');
      // Solo l'istanza che opera (con il lease) cancella stato e storico: sullo stesso database
      // può esserci il bot di un'altra modalità o un altro shadow (D52).
      const blocked = this.stateRefusal ?? this.deps.lease.canWrite();
      if (blocked !== null) throw new Error(`Reset rifiutato: ${blocked}`);
      // Lo stato salvato va eliminato: il recovery lo rileggerebbe dopo aver preso il lease.
      await this.deps.store.deleteSnapshot();
      await this.deps.store.clearHistory();
      this.snapshot = null;
      this.risk = initialRiskState();
      this.tracker = new DayTracker();
      this.checkpointDay = null;
      this.firstStartedAt = null;
      this.ledgerTotals = { fees: 0, funding: 0 };
      this.allTrades.length = 0;
      this.savedTrades.clear();
      this.latestReport = null;
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
    return this.inCycle('C', async () => {
      await this.persist();
      this.status = 'STOPPED';
      await this.deps.lease.release().catch(() => undefined);
    });
  }

  // --- Stato per l'API e la dashboard (solo dati reali, nessuna chiamata esterna) ------------------

  /** Protezione di ogni posizione del core: stop nativo su Kraken o stop simulato in shadow. */
  private positionsHealth(): PositionHealth[] {
    const book = this.port instanceof KrakenExecutionPort ? this.port.state.positions : null;
    const sim = this.port instanceof SimExecutionPort ? this.port.exchange : null;
    return (this.cycle?.openPositions() ?? []).map((p) => {
      const entry = book?.[p.id];
      const protection: ProtectionStatus = book ? (entry ? (entry.unprotectedSince === null ? 'NATIVE_STOP_OK' : 'UNPROTECTED') : 'PENDING') : 'SIMULATED';
      return {
        id: p.id,
        symbol: p.symbol,
        direction: p.trade.direction,
        size: p.trade.size,
        protection,
        stopLevel: entry ? (entry.stopOnExchange ?? null) : sim ? sim.restingStop(p.id) : null,
        unprotectedSince: entry?.unprotectedSince ? new Date(entry.unprotectedSince).toISOString() : null,
      };
    });
  }

  /** Health per l'endpoint autenticato: modalità, lease, età dei dati, cicli, protezione, errori recenti. */
  health(heartbeat: HeartbeatStatus | null = null): HealthReport {
    const now = this.deps.now();
    const lastSlot = this.cycle?.state.lastSlot ?? null;
    const ageMs = lastSlot === null ? null : now - slotEnd(lastSlot);
    const stale = (ageMs ?? now - this.startedAt) > (this.options.staleDataMs ?? 30 * 60_000);
    const lease = this.deps.lease.lease;
    const leaseReason = this.deps.lease.canWrite();
    const positions = this.positionsHealth();
    const unknown = this.port instanceof KrakenExecutionPort ? Object.values(this.port.state.unknownPositions) : [];
    const allProtected = positions.every((p) => p.protection === 'NATIVE_STOP_OK' || p.protection === 'SIMULATED');
    const issues: string[] = [];
    if (this.status !== 'RUNNING') issues.push(`runtime ${this.status}${this.lastError ? `: ${this.lastError}` : ''}`);
    if (leaseReason !== null) issues.push(`lease: ${leaseReason}`);
    if (stale) issues.push(ageMs === null ? 'nessuna candela ricevuta dall avvio' : `dati fermi da ${Math.round(ageMs / 60_000)} min`);
    for (const p of positions.filter((x) => x.protection === 'UNPROTECTED' || x.protection === 'PENDING')) issues.push(`posizione ${p.id} ${p.protection === 'PENDING' ? 'in attesa di conferma' : 'senza stop nativo'}`);
    if (unknown.length > 0) issues.push(`${unknown.length} posizioni sconosciute sul conto`);
    if (!this.persistenceHealthy) issues.push('persistenza non disponibile');
    const stalled = this.protectionStalled(now);
    if (stalled !== null) issues.push(stalled);
    if (heartbeat && !heartbeat.healthy) issues.push(...heartbeat.issues);
    const fromLogs = this.logger.recentProblems(20).map((r) => ({ at: r.at, source: 'log' as const, level: r.level, message: r.message }));
    const fromAlerts = this.recentAlerts.filter((a) => a.level !== 'info').slice(-20).map((a) => ({ at: a.at, source: 'alert' as const, level: a.level, message: a.message, code: a.code }));
    return {
      healthy: issues.length === 0,
      issues,
      at: new Date(now).toISOString(),
      mode: this.mode,
      runtimeStatus: this.status,
      operationalState: this.risk.opState,
      paused: this.paused,
      entryBlock: this.status === 'RUNNING' ? this.entryBlockReason() : this.status,
      lease: { holder: lease?.holder ?? null, epoch: lease?.epoch ?? null, expiresAt: lease ? new Date(lease.expiresAt).toISOString() : null, valid: leaseReason === null, reason: leaseReason },
      data: { lastSlot: lastSlot === null ? null : new Date(lastSlot).toISOString(), ageMs, stale },
      cycles: { lastDecisionAt: this.lastDecisionAt === null ? null : new Date(this.lastDecisionAt).toISOString(), ...this.counters },
      heartbeat,
      positions,
      unknownPositions: unknown.map((u) => ({ symbol: u.symbol, side: u.side, size: u.size, protectionId: u.protectionId })),
      allProtected,
      persistence: { healthy: this.persistenceHealthy, writes: this.deps.store.budget.snapshot() },
      recentErrors: [...fromLogs, ...fromAlerts].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 20),
    };
  }

  statusPayload(): Record<string, unknown> {
    const now = this.deps.now();
    const core = this.cycle?.state ?? null;
    const cap = this.deps.config.limits.capitalCapUsd;
    const protection = new Map(this.positionsHealth().map((h) => [h.id, h] as const));
    const openPositions = (this.cycle?.openPositions() ?? []).map((p) => {
      const last = core?.lastClose[p.symbol] ?? p.trade.entryPrice;
      const sign = p.trade.direction === 'LONG' ? 1 : -1;
      const health = protection.get(p.id);
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
        protection: health?.protection ?? 'PENDING',
        nativeStopLevel: health?.stopLevel ?? null,
        lastPrice: last,
      };
    });
    const lastSlot = core?.lastSlot ?? null;
    return {
      tradingMode: this.mode,
      dataSource: this.options.dataSourceLabel ?? null,
      runtimeStatus: this.status,
      status: this.status === 'RUNNING' ? (this.risk.opState !== 'RUNNING' ? this.risk.opState : this.paused ? 'PAUSED' : 'RUNNING') : this.status,
      isActive: this.status === 'RUNNING' && !this.paused && this.risk.opState === 'RUNNING',
      paused: this.paused,
      operationalState: this.risk.opState,
      dailyLossBlockUntil: this.risk.dailyLossBlockUntil === null ? null : new Date(this.risk.dailyLossBlockUntil).toISOString(),
      killSwitch: this.risk.killRun,
      limits: this.deps.config.limits,
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
      metrics: this.metrics(),
      latestReport: this.latestReport,
      alerts: this.recentAlerts.slice(-50).reverse(),
      counters: this.counters,
      lastError: this.lastError,
      krakenStatus: this.deps.kraken ? { connected: this.status === 'RUNNING' && this.lastError === null, lastError: this.lastError, circuit: this.deps.kraken.adapter.breaker.state } : null,
    };
  }
}
