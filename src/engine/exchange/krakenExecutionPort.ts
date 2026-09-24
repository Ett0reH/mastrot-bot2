// ExecutionPort su Kraken Futures (F3): esegue gli intenti del DecisionCycle in demo e live.
//
// Ingresso (D21): leva isolated impostata e verificata → ordine IOC marketable con un buffer
//   rispetto al prezzo della decisione (non si insegue il prezzo oltre il buffer) → la posizione
//   ha la size ESEGUITA (anche parziale) → stop nativo subito dopo, sulla size eseguita (I7).
//   Nessun polling bloccante: un ordine con esito incerto resta pendente e lo risolve il ciclo
//   di protezione.
// Uscita: ordine a mercato reduceOnly (ridurre il rischio ha la precedenza); lo stop viene
//   cancellato dopo la chiusura. Una chiusura parziale prosegue nel ciclo di protezione e il
//   core riceve un'unica chiusura con il prezzo medio.
// Ciclo di protezione (`protect`, ogni 15-30 s, e prima di ogni slot con `settle`):
//   riconcilia gli ordini, confronta il libro posizioni con Kraken (I10), verifica e ripristina
//   gli stop, chiude d'emergenza una posizione che resta senza protezione oltre il tempo
//   massimo, attribuisce le chiusure avvenute su Kraken (backstop, manuale, liquidazione) e
//   applica UNKNOWN_POSITION_POLICY alle posizioni che il bot non conosce (D22: nessuna
//   "adozione" con campi inventati).
// Non va mai costruita in shadow: lì il ciclo usa l'exchange simulato.
import type { FuturesFill, FuturesOpenOrder, FuturesOpenPosition } from '@siebly/kraken-api';
import type { TradingMode } from '../config/config';
import type { CloseIntent, CloseReason, Direction, Fill, Intent, OpenIntent, UpdateStopIntent } from '../core/types';
import { KRAKEN_NATIVE_SYMBOLS } from '../data/dataset';
import type { ExecutionPort, ExecutionReport, FundingCharge, FundingPosition } from '../live/ports';
import { type AlertCode, type AlertLevel, type AlertSink, makeAlert } from '../ops/alerts';
import { floorToStep, type InstrumentRegistry, roundToTick } from './instruments';
import type { KrakenAdapter } from './krakenAdapter';
import { ensureIsolatedLeverage } from './leverage';
import type { OrderManager } from './orderManager';
import { averagePrice, isOwnCliOrdId, makeCliOrdId, type OrderFill, type OrderRecord, TERMINAL_STATES } from './orders';
import type { StopManager, StopTarget } from './stopManager';

/** Funding realizzato sulle posizioni aperte (in live dal ledger di Kraken, F4). */
export interface FundingSource {
  charges(hourCloseSlot: number, positions: readonly FundingPosition[]): Promise<FundingCharge[]>;
}

export interface KrakenPortConfig {
  /** Buffer del limite dell'IOC di ingresso rispetto al prezzo della decisione (%). */
  entryLimitBufferPct: number;
  /** Fee taker stimata per i fill (la fee reale arriva dal ledger in F4). */
  feeRateEstimate: number;
  /** Tempo massimo di una posizione senza stop verificato prima della chiusura d'emergenza. */
  stopTimeoutMs: number;
  /** Stop protettivo delle posizioni sconosciute: distanza dal prezzo d'ingresso (%). */
  unknownPositionStopPct: number;
}

/** Finestra di elaborazione degli ordini che riducono il rischio: l'esito serve in fretta. */
const PROTECTIVE_PROCESS_WINDOW_MS = 5_000;

export const DEFAULT_KRAKEN_PORT_CONFIG: KrakenPortConfig = {
  entryLimitBufferPct: 0.5,
  feeRateEstimate: 0.0005,
  stopTimeoutMs: 60_000,
  unknownPositionStopPct: 5,
};

export interface BookPosition {
  positionId: string;
  symbol: string;
  native: string;
  direction: Direction;
  /** Size eseguita all'ingresso (quella del trade nel core). */
  entrySize: number;
  /** Size attuale su Kraken. */
  size: number;
  entryPrice: number;
  stopLevel: number;
  openedAt: number;
  unprotectedSince: number | null;
  closing: { reason: CloseReason; since: number } | null;
}

export interface UnknownPosition {
  symbol: string;
  side: 'long' | 'short';
  size: number;
  price: number;
  protectionId: string;
  detectedAt: number;
}

export interface KrakenPortState {
  positions: Record<string, BookPosition>;
  pendingEntries: Record<string, { intent: OpenIntent; cliOrdId: string }>;
  unknownPositions: Record<string, UnknownPosition>;
  alertedForeignOrders: string[];
  queue: ExecutionReport;
}

export function initialKrakenPortState(): KrakenPortState {
  return { positions: {}, pendingEntries: {}, unknownPositions: {}, alertedForeignOrders: [], queue: { fills: [], rejected: [] } };
}

export interface KrakenPortDeps {
  mode: TradingMode;
  adapter: KrakenAdapter;
  orders: OrderManager;
  stops: StopManager;
  instruments: InstrumentRegistry;
  alerts: AlertSink;
  funding: FundingSource;
  now: () => number;
}

export function nativeSymbol(symbol: string): string {
  const native = KRAKEN_NATIVE_SYMBOLS[symbol];
  if (!native) throw new Error(`Nessun contratto Kraken per ${symbol}`);
  return native;
}

export class KrakenExecutionPort implements ExecutionPort {
  constructor(
    private readonly deps: KrakenPortDeps,
    private readonly config: KrakenPortConfig = DEFAULT_KRAKEN_PORT_CONFIG,
    readonly state: KrakenPortState = initialKrakenPortState(),
  ) {
    if (deps.mode === 'shadow') throw new Error('KrakenExecutionPort non può essere usata in shadow: nessun ordine in shadow');
  }

  snapshot(): KrakenPortState {
    return structuredClone(this.state);
  }

  private now(): number {
    return this.deps.now();
  }

  private async alert(level: AlertLevel, code: AlertCode, message: string, context: Record<string, unknown>): Promise<void> {
    await this.deps.alerts.send(makeAlert(this.now(), level, code, message, context));
  }

  private fee(fills: readonly OrderFill[]): number {
    return fills.reduce((a, f) => a + f.size * f.price * this.config.feeRateEstimate, 0);
  }

  private target(pos: BookPosition): StopTarget {
    return { positionId: pos.positionId, symbol: pos.native, direction: pos.direction, size: pos.size, level: pos.stopLevel };
  }

  // --- ExecutionPort ------------------------------------------------------------------------

  async execute(intents: readonly Intent[]): Promise<ExecutionReport> {
    const report: ExecutionReport = { fills: [], rejected: [] };
    for (const intent of intents) {
      if (intent.kind === 'OPEN') await this.open(intent, report);
      else if (intent.kind === 'CLOSE') await this.close(intent, report);
      else await this.updateStop(intent, report);
    }
    return report;
  }

  async settle(): Promise<ExecutionReport> {
    await this.protect();
    const out = this.state.queue;
    this.state.queue = { fills: [], rejected: [] };
    return out;
  }

  async funding(hourCloseSlot: number, positions: readonly FundingPosition[]): Promise<FundingCharge[]> {
    return this.deps.funding.charges(hourCloseSlot, positions);
  }

  // --- Ingresso ------------------------------------------------------------------------------

  private async open(intent: OpenIntent, report: ExecutionReport): Promise<void> {
    const reject = async (reason: string) => {
      report.rejected.push({ positionId: intent.positionId, reason });
      await this.alert('warning', 'EXECUTION_ERROR', `Ingresso ${intent.symbol} non eseguito: ${reason}`, { positionId: intent.positionId });
    };
    let native: string;
    let spec;
    try {
      native = nativeSymbol(intent.symbol);
      spec = await this.deps.instruments.get(native);
    } catch (err) {
      return reject((err as Error).message);
    }
    const size = floorToStep(intent.size, spec);
    if (size <= 0) return reject(`size ${intent.size} sotto il passo minimo del contratto (${spec.sizeStep})`);
    if (spec.maxPositionSize !== null && size > spec.maxPositionSize) return reject(`size ${size} oltre il massimo del contratto (${spec.maxPositionSize})`);
    const leverage = await ensureIsolatedLeverage(this.deps.adapter, native, intent.leverage);
    if (leverage.outcome === 'failed') {
      await this.alert('critical', 'LEVERAGE_NOT_SET', `Leva isolated non impostata su ${native}: ingresso annullato`, { positionId: intent.positionId, reason: leverage.reason });
      report.rejected.push({ positionId: intent.positionId, reason: leverage.reason });
      return;
    }
    const side = intent.direction === 'LONG' ? 'buy' : 'sell';
    const buffer = this.config.entryLimitBufferPct / 100;
    const limitPrice = roundToTick(intent.referencePrice * (side === 'buy' ? 1 + buffer : 1 - buffer), spec.tickSize, side === 'buy' ? 'up' : 'down');
    let record: OrderRecord;
    try {
      record = await this.deps.orders.submit({ intentKey: intent.positionId, purpose: 'ENTRY', symbol: native, side, orderType: 'ioc', size, limitPrice, reduceOnly: false });
    } catch (err) {
      // Se il record risulta già inviato l'esito è incerto: resta pendente, non si rifiuta.
      const cliOrdId = makeCliOrdId(intent.positionId, 'ENTRY', 1);
      const stored = await this.deps.orders.store.get(cliOrdId);
      if (stored && stored.state !== 'INTENT_CREATED') {
        this.state.pendingEntries[intent.positionId] = { intent, cliOrdId };
        return;
      }
      return reject((err as Error).message);
    }
    await this.onEntryResult(intent, record, report);
  }

  private async onEntryResult(intent: OpenIntent, record: OrderRecord, report: ExecutionReport): Promise<void> {
    const terminal = TERMINAL_STATES.has(record.state);
    if (terminal && record.filledSize > 0) {
      const price = averagePrice(record.fills) as number;
      const pos: BookPosition = {
        positionId: intent.positionId,
        symbol: intent.symbol,
        native: record.symbol,
        direction: intent.direction,
        entrySize: record.filledSize,
        size: record.filledSize,
        entryPrice: price,
        stopLevel: intent.backstop,
        openedAt: this.now(),
        unprotectedSince: this.now(),
        closing: null,
      };
      this.state.positions[pos.positionId] = pos;
      report.fills.push({ kind: 'OPEN', symbol: intent.symbol, positionId: intent.positionId, price, size: record.filledSize, fee: this.fee(record.fills), time: this.now(), source: 'exchange', feeEstimated: true });
      await this.alert('info', 'ENTRY', `Ingresso ${intent.direction} ${intent.symbol}: ${record.filledSize} a ${price}${record.filledSize < record.size ? ` (parziale su ${record.size})` : ''}`, { positionId: intent.positionId, cliOrdId: record.cliOrdId });
      await this.protectPosition(pos, report);
    } else if (terminal) {
      report.rejected.push({ positionId: intent.positionId, reason: `ordine d'ingresso ${record.state}${record.lastError ? ` (${record.lastError})` : ''}` });
    } else {
      this.state.pendingEntries[intent.positionId] = { intent, cliOrdId: record.cliOrdId };
      await this.alert('warning', 'ORDER_UNKNOWN_STATE', `Esito dell'ingresso ${intent.symbol} incerto: in riconciliazione`, { positionId: intent.positionId, cliOrdId: record.cliOrdId });
    }
  }

  // --- Protezione ----------------------------------------------------------------------------

  private async protectPosition(pos: BookPosition, report: ExecutionReport, openOrders?: FuturesOpenOrder[]): Promise<void> {
    let status;
    try {
      status = await this.deps.stops.ensure(this.target(pos), openOrders);
    } catch (err) {
      status = { status: 'PENDING' as const, reason: `verifica dello stop fallita: ${(err as Error).message}` };
    }
    if (status.status === 'PROTECTED') {
      pos.unprotectedSince = null;
      return;
    }
    if (status.status === 'NO_POSITION') return; // la chiusura viene attribuita dalla riconciliazione
    pos.unprotectedSince ??= this.now();
    const expired = this.now() - pos.unprotectedSince >= this.config.stopTimeoutMs;
    if (status.status === 'FAILED' || expired) {
      await this.emergencyClose(pos, status.reason, report);
    } else {
      await this.alert('warning', 'STOP_MISSING', `Posizione ${pos.symbol} senza stop verificato: ${status.reason}`, { positionId: pos.positionId });
    }
  }

  private async emergencyClose(pos: BookPosition, reason: string, report: ExecutionReport): Promise<void> {
    pos.closing = { reason: 'PROTECTION_FAILURE', since: this.now() };
    const record = await this.deps.stops.emergencyClose(this.target(pos), reason);
    if (record.filledSize >= pos.size) await this.finalizeClose(pos, record.fills, 'PROTECTION_FAILURE', report);
  }

  private async finalizeClose(pos: BookPosition, closingFills: readonly OrderFill[], reason: CloseReason, report: ExecutionReport): Promise<void> {
    const price = averagePrice(closingFills);
    if (price === null) throw new Error(`Chiusura di ${pos.positionId} senza fill`);
    report.fills.push({ kind: 'CLOSE', symbol: pos.symbol, positionId: pos.positionId, price, size: pos.entrySize, fee: this.fee(closingFills), time: this.now(), exitType: reason, source: 'exchange', feeEstimated: true });
    delete this.state.positions[pos.positionId];
    try {
      await this.deps.stops.remove(pos.positionId);
    } catch (err) {
      // Stop residuo: il ciclo di protezione cancella gli ordini propri senza posizione.
      await this.alert('warning', 'EXECUTION_ERROR', `Stop di ${pos.positionId} non cancellato: ${(err as Error).message}`, { positionId: pos.positionId });
    }
    const level: AlertLevel = reason === 'EXTERNAL_CLOSE' || reason === 'LIQUIDATION' ? 'critical' : 'info';
    await this.alert(level, reason === 'EXTERNAL_CLOSE' || reason === 'LIQUIDATION' ? 'DESYNC' : 'EXIT', `Uscita ${pos.symbol} (${reason}) a ${price}`, { positionId: pos.positionId });
  }

  // --- Uscita e stop --------------------------------------------------------------------------

  private async close(intent: CloseIntent, report: ExecutionReport): Promise<void> {
    const pos = this.state.positions[intent.positionId];
    if (!pos) {
      report.rejected.push({ positionId: intent.positionId, reason: 'posizione assente dal libro di Kraken' });
      await this.alert('critical', 'DESYNC', `Uscita richiesta per ${intent.positionId}, assente su Kraken`, { positionId: intent.positionId });
      return;
    }
    if (pos.closing) return; // chiusura già in corso: prosegue nel ciclo di protezione
    pos.closing = { reason: intent.exitType, since: this.now() };
    await this.submitExit(pos, report);
  }

  private async submitExit(pos: BookPosition, report: ExecutionReport): Promise<void> {
    const records = await this.deps.orders.store.byIntent(pos.positionId);
    const previous = records.filter((r) => r.purpose === 'EXIT' || r.purpose === 'EMERGENCY_CLOSE');
    if (previous.some((r) => !TERMINAL_STATES.has(r.state))) return; // una chiusura è già in volo
    const reason = pos.closing?.reason ?? 'EXTERNAL_CLOSE';
    const purpose = reason === 'PROTECTION_FAILURE' ? 'EMERGENCY_CLOSE' : 'EXIT';
    const record = await this.deps.orders.submit(
      { intentKey: pos.positionId, purpose, symbol: pos.native, side: pos.direction === 'LONG' ? 'sell' : 'buy', orderType: 'mkt', size: pos.size, reduceOnly: true },
      previous.filter((r) => r.purpose === purpose).length + 1,
      'protective',
      PROTECTIVE_PROCESS_WINDOW_MS,
    );
    const closingFills = [...previous, record].flatMap((r) => r.fills);
    const closed = closingFills.reduce((a, f) => a + f.size, 0);
    if (closed >= pos.entrySize) {
      await this.finalizeClose(pos, closingFills, reason, report);
    } else if (record.state === 'REJECTED' && record.lastError !== 'wouldNotReducePosition') {
      // Rifiuto definitivo: il core riceve il rifiuto e ridecide all'ora successiva; lo stop resta.
      pos.closing = null;
      if (closed === 0) report.rejected.push({ positionId: pos.positionId, reason: `uscita rifiutata (${record.lastError})` });
      await this.alert('warning', 'EXECUTION_ERROR', `Uscita ${pos.symbol} rifiutata (${record.lastError})`, { positionId: pos.positionId });
    } else if (record.filledSize > 0) {
      pos.size = Number((pos.size - record.filledSize).toFixed(10));
    }
  }

  private async updateStop(intent: UpdateStopIntent, report: ExecutionReport): Promise<void> {
    const pos = this.state.positions[intent.positionId];
    if (!pos || pos.closing) return;
    pos.stopLevel = intent.backstop;
    await this.protectPosition(pos, report);
  }

  // --- Ciclo di protezione --------------------------------------------------------------------

  /** Riconciliazione con Kraken e verifica degli stop (nessuna decisione di strategia). */
  async protect(): Promise<void> {
    const queue = this.state.queue;
    await this.deps.orders.reconcileAll('protective');

    for (const [positionId, pending] of Object.entries(this.state.pendingEntries)) {
      const record = await this.deps.orders.store.get(pending.cliOrdId);
      if (!record || !TERMINAL_STATES.has(record.state)) continue;
      delete this.state.pendingEntries[positionId];
      await this.onEntryResult(pending.intent, record, queue);
    }

    const [positions, openOrders] = await Promise.all([this.deps.adapter.openPositions('protective'), this.deps.adapter.openOrders('protective')]);
    const book = Object.values(this.state.positions);
    const since = book.length ? Math.min(...book.map((p) => p.openedAt)) - 60_000 : null;
    const fills = since === null ? [] : await this.deps.orders.fillsSince(new Date(since).toISOString(), 'protective');

    for (const pos of book) {
      const onExchange = positions.find((p) => p.symbol === pos.native);
      if (!onExchange) {
        await this.closedOnExchange(pos, fills, queue);
        continue;
      }
      const expectedSide = pos.direction === 'LONG' ? 'long' : 'short';
      if (onExchange.side !== expectedSide) {
        await this.alert('critical', 'DESYNC', `Posizione ${pos.native} di verso opposto su Kraken`, { positionId: pos.positionId, exchange: onExchange });
        continue;
      }
      if (onExchange.size !== pos.size) {
        if (!pos.closing) await this.alert('critical', 'DESYNC', `Size di ${pos.native} diversa su Kraken: ${onExchange.size} invece di ${pos.size}`, { positionId: pos.positionId });
        pos.size = onExchange.size;
      }
      if (pos.closing) await this.submitExit(pos, queue);
      else await this.protectPosition(pos, queue, openOrders);
    }

    const known = new Set(Object.values(this.state.positions).map((p) => p.native));
    const pendingNatives = new Set(Object.values(this.state.pendingEntries).map((p) => nativeSymbol(p.intent.symbol)));
    for (const ex of positions) {
      if (known.has(ex.symbol) || pendingNatives.has(ex.symbol)) continue;
      await this.unknownPosition(ex, openOrders);
    }
    for (const [native, unknown] of Object.entries(this.state.unknownPositions)) {
      if (positions.some((p) => p.symbol === native)) continue;
      delete this.state.unknownPositions[native];
      await this.deps.stops.remove(unknown.protectionId);
    }
    await this.cleanOrders(openOrders);
  }

  /** La posizione non c'è più su Kraken: si attribuisce la chiusura dai fill. */
  private async closedOnExchange(pos: BookPosition, fills: readonly FuturesFill[], queue: ExecutionReport): Promise<void> {
    const closeSide = pos.direction === 'LONG' ? 'sell' : 'buy';
    const closing = fills.filter((f) => f.symbol === pos.native && f.side === closeSide && Date.parse(f.fillTime) >= pos.openedAt - 1_000);
    if (closing.length === 0) {
      await this.alert('critical', 'DESYNC', `Posizione ${pos.native} assente su Kraken e nessun fill di chiusura visibile`, { positionId: pos.positionId });
      return;
    }
    const records = await this.deps.orders.store.byIntent(pos.positionId);
    const idsOf = (purpose: OrderRecord['purpose']) => new Set(records.filter((r) => r.purpose === purpose).map((r) => r.cliOrdId));
    const stopIds = idsOf('STOP');
    const emergencyIds = idsOf('EMERGENCY_CLOSE');
    let reason: CloseReason;
    if (closing.some((f) => f.fillType === 'liquidation')) reason = 'LIQUIDATION';
    else if (closing.some((f) => f.cliOrdId && stopIds.has(f.cliOrdId))) reason = 'BACKSTOP';
    else if (closing.some((f) => f.cliOrdId && emergencyIds.has(f.cliOrdId))) reason = 'PROTECTION_FAILURE';
    else if (pos.closing) reason = pos.closing.reason;
    else reason = 'EXTERNAL_CLOSE';
    await this.finalizeClose(pos, closing.map((f) => ({ fillId: f.fill_id, price: f.price, size: f.size, time: f.fillTime })), reason, queue);
  }

  /** UNKNOWN_POSITION_POLICY = alert_protect_no_manage. */
  private async unknownPosition(ex: FuturesOpenPosition, openOrders: FuturesOpenOrder[]): Promise<void> {
    let unknown = this.state.unknownPositions[ex.symbol];
    if (!unknown) {
      unknown = { symbol: ex.symbol, side: ex.side, size: ex.size, price: ex.price, protectionId: `unknown-${ex.symbol}-${ex.fillTime}`, detectedAt: this.now() };
      this.state.unknownPositions[ex.symbol] = unknown;
      await this.alert('critical', 'UNKNOWN_POSITION', `Posizione sconosciuta su Kraken: ${ex.side} ${ex.size} ${ex.symbol} a ${ex.price}. Solo stop protettivo, nessuna gestione`, { position: ex });
    }
    unknown.size = ex.size;
    const pct = this.config.unknownPositionStopPct / 100;
    const direction: Direction = ex.side === 'long' ? 'LONG' : 'SHORT';
    const level = direction === 'LONG' ? ex.price * (1 - pct) : ex.price * (1 + pct);
    const status = await this.deps.stops.ensure({ positionId: unknown.protectionId, symbol: ex.symbol, direction, size: ex.size, level }, openOrders);
    if (status.status !== 'PROTECTED') {
      await this.alert('critical', 'STOP_MISSING', `Posizione sconosciuta ${ex.symbol} senza stop protettivo: ${status.reason}`, { position: ex });
    }
  }

  /** Ordini propri senza più una posizione (es. stop residui) si cancellano; quelli altrui si segnalano. */
  private async cleanOrders(openOrders: FuturesOpenOrder[]): Promise<void> {
    const owners = new Set([...Object.keys(this.state.positions), ...Object.values(this.state.unknownPositions).map((u) => u.protectionId), ...Object.keys(this.state.pendingEntries)]);
    for (const order of openOrders) {
      if (isOwnCliOrdId(order.cliOrdId)) {
        const record = await this.deps.orders.store.get(order.cliOrdId as string);
        if (record && owners.has(record.intentKey)) continue;
        await this.deps.adapter.cancelOrder({ order_id: order.order_id }, 'protective');
        if (record) await this.deps.orders.reconcile(record.cliOrdId, 'protective');
      } else if (!this.state.alertedForeignOrders.includes(order.order_id)) {
        this.state.alertedForeignOrders.push(order.order_id);
        await this.alert('warning', 'UNKNOWN_ORDER', `Ordine non del bot su Kraken: ${order.side} ${order.orderType} ${order.symbol}`, { order });
      }
    }
  }
}

/** Funding non ancora letto da Kraken: dichiarato esplicitamente, sostituito dal ledger in F4. */
export class FundingFromLedgerPending implements FundingSource {
  async charges(): Promise<FundingCharge[]> {
    return [];
  }
}
