// Kraken Futures simulato per i test di contratto (F3) e gli scenari di caos (F7).
//
// Implementa le stesse firme di DerivativesClient usate dal bot (KrakenFuturesApi) e restituisce
// le forme documentate dai tipi di @siebly/kraken-api (types/response/derivatives.types.d.ts,
// con i riferimenti a docs.kraken.com). Dove la documentazione non è verificabile da questo
// ambiente il comportamento è indicato come ipotesi e va confermato con lo smoke test in demo:
// - getOrderStatus vede gli ordini aperti e quelli chiusi negli ultimi 5 secondi (doc siebly);
// - getFills restituisce al massimo 100 fill, i più recenti prima di `lastFillTime` (ipotesi);
// - uno stop `stp` senza limitPrice è uno stop-market che scatta sul mark price (ipotesi);
// - un ordine reduceOnly più grande della posizione viene ridotto alla posizione (reducedQuantity).
// I guasti si iniettano con `failNext`: errori HTTP e applicativi nella forma lanciata da siebly,
// errori di rete, e il caso critico "timeout dopo l'elaborazione" (l'ordine esiste su Kraken
// ma il client riceve un timeout).
import type {
  FuturesAccountLogEntry,
  FuturesCancelOrderParams,
  FuturesGetAccountLogParams,
  FuturesEditOrderParams,
  FuturesFill,
  FuturesInitiateWalletTransferParams,
  FuturesInstrument,
  FuturesOpenOrder,
  FuturesOpenPosition,
  FuturesOrderEvent,
  FuturesOrderJson,
  FuturesOrderStatusInfo,
  FuturesSendOrderParams,
  FuturesSendOrderStatus,
  FuturesTicker,
} from '@siebly/kraken-api';
import type { KrakenFuturesApi } from '../exchange/krakenApi';

type Method = keyof KrakenFuturesApi;

export type Fault =
  /** Risposta HTTP di errore, richiesta NON elaborata. */
  | { kind: 'http'; status: number }
  /** HTTP 200 con result: 'error', richiesta NON elaborata (es. apiLimitExceeded). */
  | { kind: 'api_error'; error: string }
  /** Nessuna risposta, richiesta NON arrivata. */
  | { kind: 'network' }
  /** La richiesta viene ELABORATA, poi il client riceve un timeout. */
  | { kind: 'timeout_after_processing' }
  /** sendorder risponde con questo status (rifiuto) senza creare l'ordine. */
  | { kind: 'send_status'; status: FuturesSendOrderStatus['status'] };

interface FakeOrder {
  orderId: string;
  cliOrdId: string | null;
  symbol: string;
  side: 'buy' | 'sell';
  type: 'ioc' | 'lmt' | 'mkt' | 'stp' | 'post' | 'fok' | 'take_profit' | 'trailing_stop';
  size: number;
  filled: number;
  limitPrice: number | null;
  stopPrice: number | null;
  reduceOnly: boolean;
  triggerSignal: 'mark' | 'last' | 'index';
  status: 'open' | 'filled' | 'cancelled' | 'rejected';
  createdAt: number;
  updatedAt: number;
}

interface FakePosition {
  size: number; // con segno: > 0 long, < 0 short
  price: number;
  fillTime: number;
}

export interface FakeKrakenOptions {
  now: () => number;
  instruments: FuturesInstrument[];
  marks: Record<string, number>;
  /** Slippage dei fill a mercato, in punti base. */
  slippageBps?: number;
}

export const FAKE_INSTRUMENTS: FuturesInstrument[] = [
  // Valori illustrativi (non quelli reali): ai test interessa che il bot usi ciò che riceve.
  { symbol: 'PF_XBTUSD', type: 'flexible_futures', tradeable: true, tradfi: false, tickSize: 0.5, contractValueTradePrecision: 4, maxPositionSize: 1_000_000 },
  { symbol: 'PF_ETHUSD', type: 'flexible_futures', tradeable: true, tradfi: false, tickSize: 0.1, contractValueTradePrecision: 3, maxPositionSize: 1_000_000 },
  { symbol: 'PF_SOLUSD', type: 'flexible_futures', tradeable: true, tradfi: false, tickSize: 0.01, contractValueTradePrecision: 2, maxPositionSize: 1_000_000 },
  { symbol: 'PF_XRPUSD', type: 'flexible_futures', tradeable: true, tradfi: false, tickSize: 0.0001, contractValueTradePrecision: 0, maxPositionSize: 1_000_000 },
  { symbol: 'PF_DOGEUSD', type: 'flexible_futures', tradeable: true, tradfi: false, tickSize: 0.00001, contractValueTradePrecision: -1, maxPositionSize: 10_000_000 },
  { symbol: 'PF_AVAXUSD', type: 'flexible_futures', tradeable: true, tradfi: false, tickSize: 0.001, contractValueTradePrecision: 1, maxPositionSize: 1_000_000 },
  { symbol: 'PF_LINKUSD', type: 'flexible_futures', tradeable: true, tradfi: false, tickSize: 0.001, contractValueTradePrecision: 1, maxPositionSize: 1_000_000 },
  { symbol: 'PF_ADAUSD', type: 'flexible_futures', tradeable: true, tradfi: false, tickSize: 0.00001, contractValueTradePrecision: 0, maxPositionSize: 10_000_000 },
  { symbol: 'PF_LTCUSD', type: 'flexible_futures', tradeable: true, tradfi: false, tickSize: 0.01, contractValueTradePrecision: 2, maxPositionSize: 1_000_000 },
  { symbol: 'PF_OLDUSD', type: 'flexible_futures', tradeable: false, tradfi: false, tickSize: 0.01, contractValueTradePrecision: 2 },
];

function sieblyHttpError(status: number, body: unknown) {
  return { code: status, message: `HTTP ${status}`, body, headers: {}, requestOptions: {}, requestParams: {} };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export class FakeKrakenFutures implements KrakenFuturesApi {
  readonly marks = new Map<string, number>();
  /** Size massima eseguibile da un singolo ordine a mercato/IOC (per simulare fill parziali). */
  readonly liquidity = new Map<string, number>();
  readonly positions = new Map<string, FakePosition>();
  readonly orders = new Map<string, FakeOrder>();
  readonly fills: FuturesFill[] = [];
  readonly leverage = new Map<string, number>();
  readonly calls: { method: Method; params: unknown }[] = [];
  /** Simboli per cui setLeverageSettings viene accettato ma non applicato (per D20). */
  readonly ignoreLeverageFor = new Set<string>();
  readonly transfers: FuturesInitiateWalletTransferParams[] = [];
  readonly accountLogEntries: FuturesAccountLogEntry[] = [];
  /** Chiamato dopo che una richiesta è stata elaborata (prima della risposta al client). */
  onProcessed: ((method: Method, params: unknown) => void) | null = null;
  private readonly faults = new Map<Method, { fault: Fault; when?: (params: unknown) => boolean }[]>();
  private seq = 0;
  instruments: FuturesInstrument[];
  slippageBps: number;

  constructor(private readonly options: FakeKrakenOptions) {
    this.instruments = options.instruments;
    for (const [s, p] of Object.entries(options.marks)) this.marks.set(s, p);
    this.slippageBps = options.slippageBps ?? 0;
  }

  private now(): number {
    return this.options.now();
  }

  // --- Iniezione di guasti ---------------------------------------------------------------

  /** Programma un guasto sulle prossime `times` chiamate del metodo (solo quelle per cui `when` è vero). */
  failNext(method: Method, fault: Fault, times = 1, when?: (params: unknown) => boolean): void {
    const list = this.faults.get(method) ?? [];
    for (let i = 0; i < times; i++) list.push({ fault, when });
    this.faults.set(method, list);
  }

  /** Rimuove i guasti ancora programmati (tutti o di un metodo). */
  clearFaults(method?: Method): void {
    if (method) this.faults.delete(method);
    else this.faults.clear();
  }

  private takeFault(method: Method, params: unknown): Fault | null {
    const list = this.faults.get(method);
    if (!list) return null;
    const i = list.findIndex((f) => !f.when || f.when(params));
    return i >= 0 ? list.splice(i, 1)[0].fault : null;
  }

  /** Esegue `process` rispettando il guasto programmato per il metodo. */
  private async call<T>(method: Method, params: unknown, process: () => T): Promise<T> {
    this.calls.push({ method, params: structuredClone(params ?? null) });
    const fault = this.takeFault(method, params);
    if (fault?.kind === 'http') throw sieblyHttpError(fault.status, { result: 'error', error: `HTTP ${fault.status}` });
    if (fault?.kind === 'api_error') throw sieblyHttpError(200, { result: 'error', error: fault.error, serverTime: iso(this.now()) });
    if (fault?.kind === 'network') throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    if (fault?.kind === 'send_status') {
      if (method !== 'submitOrder') throw new Error('send_status vale solo per submitOrder');
      const p = params as FuturesSendOrderParams;
      return { result: 'success', serverTime: iso(this.now()), sendStatus: { status: fault.status, cliOrdId: p.cliOrdId, receivedTime: iso(this.now()), orderEvents: [] } } as T;
    }
    const value = process();
    this.onProcessed?.(method, params);
    if (fault?.kind === 'timeout_after_processing') throw Object.assign(new Error('timeout of 10000ms exceeded'), { code: 'ECONNABORTED' });
    return value;
  }

  private ok<T extends object>(data: T): { result: 'success'; serverTime: string } & T {
    return { result: 'success', serverTime: iso(this.now()), ...data };
  }

  // --- Mercato e azioni esterne ----------------------------------------------------------

  private instrument(symbol: string): FuturesInstrument | undefined {
    return this.instruments.find((i) => i.symbol === symbol);
  }

  private mark(symbol: string): number {
    const m = this.marks.get(symbol);
    if (m === undefined) throw new Error(`Fake: mark price mancante per ${symbol}`);
    return m;
  }

  /** Nuovo mark price: scattano gli stop attraversati (stop-market, fill al nuovo prezzo). */
  setMark(symbol: string, price: number): void {
    this.marks.set(symbol, price);
    for (const o of [...this.orders.values()]) {
      if (o.symbol !== symbol || o.status !== 'open' || o.type !== 'stp' || o.stopPrice === null) continue;
      const crossed = o.side === 'sell' ? price <= o.stopPrice : price >= o.stopPrice;
      if (crossed) this.executeMarket(o, o.size - o.filled);
    }
  }

  /** Chiusura manuale dall'interfaccia di Kraken (nessun cliOrdId del bot). */
  externalClose(symbol: string): void {
    const pos = this.positions.get(symbol);
    if (!pos || pos.size === 0) throw new Error(`Fake: nessuna posizione su ${symbol}`);
    const order: FakeOrder = this.newOrder({ symbol, side: pos.size > 0 ? 'sell' : 'buy', type: 'mkt', size: Math.abs(pos.size), cliOrdId: null, reduceOnly: true });
    this.executeMarket(order, order.size);
  }

  /** Apre una posizione "a mano" (per la politica delle posizioni sconosciute). */
  externalOpen(symbol: string, side: 'buy' | 'sell', size: number): void {
    const order = this.newOrder({ symbol, side, type: 'mkt', size, cliOrdId: null, reduceOnly: false });
    this.executeMarket(order, size);
  }

  /** Uno stop sparisce senza traccia (es. cancellato a mano). */
  dropOrder(cliOrdId: string): void {
    const o = [...this.orders.values()].find((x) => x.cliOrdId === cliOrdId && x.status === 'open');
    if (!o) throw new Error(`Fake: nessun ordine aperto ${cliOrdId}`);
    o.status = 'cancelled';
    o.updatedAt = this.now();
  }

  positionSize(symbol: string): number {
    return this.positions.get(symbol)?.size ?? 0;
  }

  openOrdersFor(symbol: string): FakeOrder[] {
    return [...this.orders.values()].filter((o) => o.symbol === symbol && o.status === 'open');
  }

  /** Ordini creati sull'exchange per un cliOrdId (per verificare l'assenza di duplicati). */
  ordersWithCliOrdId(cliOrdId: string): FakeOrder[] {
    return [...this.orders.values()].filter((o) => o.cliOrdId === cliOrdId);
  }

  private newOrder(p: { symbol: string; side: 'buy' | 'sell'; type: FakeOrder['type']; size: number; cliOrdId: string | null; reduceOnly: boolean; limitPrice?: number; stopPrice?: number; triggerSignal?: FakeOrder['triggerSignal'] }): FakeOrder {
    const order: FakeOrder = {
      orderId: `fake-${++this.seq}`,
      cliOrdId: p.cliOrdId,
      symbol: p.symbol,
      side: p.side,
      type: p.type,
      size: p.size,
      filled: 0,
      limitPrice: p.limitPrice ?? null,
      stopPrice: p.stopPrice ?? null,
      reduceOnly: p.reduceOnly,
      triggerSignal: p.triggerSignal ?? 'mark',
      status: 'open',
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.orders.set(order.orderId, order);
    return order;
  }

  private applyFill(order: FakeOrder, size: number, price: number): FuturesFill {
    const signed = order.side === 'buy' ? size : -size;
    const pos = this.positions.get(order.symbol) ?? { size: 0, price: 0, fillTime: this.now() };
    const newSize = Number((pos.size + signed).toFixed(10));
    if (pos.size === 0 || Math.sign(pos.size) === Math.sign(signed)) {
      pos.price = (Math.abs(pos.size) * pos.price + size * price) / Math.abs(newSize);
    } else if (newSize !== 0 && Math.sign(newSize) !== Math.sign(pos.size)) {
      pos.price = price; // inversione
    }
    pos.size = newSize;
    pos.fillTime = this.now();
    if (pos.size === 0) this.positions.delete(order.symbol);
    else this.positions.set(order.symbol, pos);
    order.filled = Number((order.filled + size).toFixed(10));
    order.updatedAt = this.now();
    if (order.filled >= order.size) order.status = 'filled';
    const fill: FuturesFill = {
      cliOrdId: order.cliOrdId,
      fillTime: iso(this.now()),
      fillType: 'taker',
      fill_id: `fill-${++this.seq}`,
      order_id: order.orderId,
      price,
      side: order.side,
      size,
      symbol: order.symbol,
    };
    this.fills.push(fill);
    this.logEntry({ info: 'futures trade', contract: order.symbol.toLowerCase(), execution: fill.fill_id, fee: size * price * 0.0005, trade_price: price });
    return fill;
  }

  /** Deposito (importo > 0) o prelievo (< 0) sul conto, fatto fuori dal bot. */
  externalTransfer(amount: number): FuturesAccountLogEntry {
    return this.logEntry({ info: amount > 0 ? 'cross-account transfer in' : 'cross-account transfer out' }, amount);
  }

  /** Voce dell'account log (forma: FuturesAccountLogEntry). */
  logEntry(p: Partial<FuturesAccountLogEntry> & { info: string }, extraBalanceChange = 0): FuturesAccountLogEntry {
    const prev = this.accountLogEntries.at(-1)?.new_balance ?? 10_000;
    const delta = (p.realized_pnl ?? 0) + (p.realized_funding ?? 0) - (p.fee ?? 0) + extraBalanceChange;
    const entry: FuturesAccountLogEntry = {
      asset: 'usd', booking_uid: `bk-${++this.seq}`, collateral: null, contract: null, date: iso(this.now()), execution: null, fee: null,
      funding_rate: null, id: this.accountLogEntries.length + 1, margin_account: 'flex', mark_price: null, new_average_entry_price: null,
      new_balance: prev + delta, old_average_entry_price: null, old_balance: prev, realized_funding: null, realized_pnl: null, trade_price: null,
      ...p,
    };
    this.accountLogEntries.push(entry);
    return entry;
  }

  /** Esecuzione a mercato limitata dalla liquidità (e dal limite, se presente). */
  private executeMarket(order: FakeOrder, wanted: number): FuturesFill[] {
    let size = wanted;
    if (order.reduceOnly) {
      const pos = this.positionSize(order.symbol);
      const reducible = (order.side === 'sell' && pos > 0) || (order.side === 'buy' && pos < 0) ? Math.abs(pos) : 0;
      size = Math.min(size, reducible);
    }
    const liquidity = this.liquidity.get(order.symbol);
    if (liquidity !== undefined) size = Math.min(size, liquidity);
    const slip = this.slippageBps / 10_000;
    const price = this.mark(order.symbol) * (order.side === 'buy' ? 1 + slip : 1 - slip);
    if (order.limitPrice !== null && (order.side === 'buy' ? price > order.limitPrice : price < order.limitPrice)) size = 0;
    const fills = size > 0 ? [this.applyFill(order, size, price)] : [];
    if (order.status === 'open' && order.type !== 'lmt') {
      order.status = 'cancelled'; // resto di IOC / mercato / stop scattato cancellato
      order.updatedAt = this.now();
    }
    return fills;
  }

  private statusOf(order: FakeOrder): FuturesOrderStatusInfo['status'] {
    if (order.status === 'open') return order.type === 'stp' ? 'TRIGGER_PLACED' : 'ENTERED_BOOK';
    if (order.status === 'filled') return 'FULLY_EXECUTED';
    if (order.status === 'rejected') return 'REJECTED';
    return 'CANCELLED';
  }

  private orderJson(o: FakeOrder): FuturesOrderJson {
    return {
      orderId: o.orderId,
      cliOrdId: o.cliOrdId,
      type: o.type === 'mkt' ? 'ioc' : (o.type as FuturesOrderJson['type']),
      symbol: o.symbol,
      side: o.side,
      quantity: o.size,
      filled: o.filled,
      limitPrice: o.limitPrice ?? 0,
      reduceOnly: o.reduceOnly,
      timestamp: iso(o.createdAt),
      lastUpdateTimestamp: iso(o.updatedAt),
    };
  }

  // --- API ---------------------------------------------------------------------------------

  getInstruments() {
    return this.call('getInstruments', null, () => this.ok({ instruments: structuredClone(this.instruments) }));
  }

  getTickers() {
    return this.call('getTickers', null, () =>
      this.ok({ tickers: [...this.marks.entries()].map(([symbol, markPrice]) => ({ symbol, markPrice, last: markPrice }) as unknown as FuturesTicker) }),
    );
  }

  submitOrder(params: FuturesSendOrderParams) {
    return this.call('submitOrder', params, () => {
      const now = this.now();
      const reply = (status: FuturesSendOrderStatus['status'], order?: FakeOrder, events: FuturesOrderEvent[] = []) =>
        this.ok({ sendStatus: { status, cliOrdId: params.cliOrdId, order_id: order?.orderId, receivedTime: iso(now), orderEvents: events } as FuturesSendOrderStatus });
      if (params.processBefore && now > Date.parse(params.processBefore)) return reply('wouldProcessAfterSpecifiedTime');
      if (params.cliOrdId && [...this.orders.values()].some((o) => o.cliOrdId === params.cliOrdId)) return reply('clientOrderIdAlreadyExist');
      const inst = this.instrument(params.symbol);
      if (!inst || !inst.tradeable) return reply('marketInactive');
      const step = 10 ** -(inst.contractValueTradePrecision ?? 0);
      const tick = inst.tickSize ?? 0;
      const onGrid = (value: number, unit: number) => Math.abs(value / unit - Math.round(value / unit)) < 1e-7;
      if (!(params.size > 0) || !onGrid(params.size, step)) return reply('invalidSize');
      for (const price of [params.limitPrice, params.stopPrice]) if (price !== undefined && (!(price > 0) || !onGrid(price, tick))) return reply('invalidPrice');
      const pos = this.positionSize(params.symbol);
      if (params.reduceOnly && !((params.side === 'sell' && pos > 0) || (params.side === 'buy' && pos < 0))) return reply('wouldNotReducePosition');
      const after = Math.abs(pos + (params.side === 'buy' ? params.size : -params.size));
      if (!params.reduceOnly && inst.maxPositionSize !== undefined && after > inst.maxPositionSize) return reply('maxPositionViolation');
      if ((params.orderType === 'lmt' || params.orderType === 'ioc') && params.limitPrice === undefined) return reply('invalidPrice');
      if (params.orderType === 'stp' && params.stopPrice === undefined) return reply('invalidPrice');

      const order = this.newOrder({
        symbol: params.symbol,
        side: params.side,
        type: params.orderType,
        size: params.reduceOnly ? Math.min(params.size, Math.abs(pos)) : params.size,
        cliOrdId: params.cliOrdId ?? null,
        reduceOnly: params.reduceOnly === true,
        limitPrice: params.limitPrice,
        stopPrice: params.stopPrice,
        triggerSignal: params.triggerSignal,
      });
      const place: FuturesOrderEvent = { type: 'PLACE', order: this.orderJson(order) };
      if (params.orderType === 'stp') {
        const m = this.mark(params.symbol);
        const crossed = params.side === 'sell' ? m <= (params.stopPrice as number) : m >= (params.stopPrice as number);
        if (crossed) this.executeMarket(order, order.size);
        return reply('placed', order, [place]);
      }
      const before = this.orderJson(order);
      const fills = this.executeMarket(order, order.size);
      const events: FuturesOrderEvent[] = [
        place,
        ...fills.map((f): FuturesOrderEvent => ({ type: 'EXECUTION', executionId: f.fill_id, price: f.price, amount: f.size, orderPriorEdit: before, orderPriorExecution: { ...before, takerReducedQuantity: null } })),
      ];
      if (params.orderType === 'ioc' && fills.length === 0) return reply('iocWouldNotExecute', order);
      return reply('placed', order, events);
    });
  }

  editOrder(params: FuturesEditOrderParams) {
    return this.call('editOrder', params, () => {
      const o = [...this.orders.values()].find((x) => x.status === 'open' && ((params.orderId && x.orderId === params.orderId) || (params.cliOrdId && x.cliOrdId === params.cliOrdId)));
      const base = { orderId: o?.orderId ?? params.orderId ?? null, cliOrdId: o?.cliOrdId ?? params.cliOrdId ?? null, receivedTime: iso(this.now()), orderEvents: [] as FuturesOrderEvent[] };
      if (!o) return this.ok({ editStatus: { ...base, status: 'orderForEditNotFound' as const } });
      const tick = this.instrument(o.symbol)?.tickSize ?? 0;
      if (params.stopPrice !== undefined && Math.abs(params.stopPrice / tick - Math.round(params.stopPrice / tick)) > 1e-7) return this.ok({ editStatus: { ...base, status: 'invalidPrice' as const } });
      if (params.stopPrice !== undefined) o.stopPrice = params.stopPrice;
      if (params.limitPrice !== undefined) o.limitPrice = params.limitPrice;
      if (params.size !== undefined) o.size = params.size;
      o.updatedAt = this.now();
      if (o.type === 'stp') this.setMark(o.symbol, this.mark(o.symbol));
      return this.ok({ editStatus: { ...base, status: 'edited' as const } });
    });
  }

  cancelOrder(params: FuturesCancelOrderParams) {
    return this.call('cancelOrder', params, () => {
      const o = [...this.orders.values()].find((x) => (params.order_id && x.orderId === params.order_id) || (params.cliOrdId && x.cliOrdId === params.cliOrdId));
      const base = { order_id: o?.orderId ?? params.order_id, cliOrdId: o?.cliOrdId ?? params.cliOrdId ?? null, receivedTime: iso(this.now()) };
      if (!o) return this.ok({ cancelStatus: { ...base, status: 'notFound' as const } });
      if (o.status === 'filled') return this.ok({ cancelStatus: { ...base, status: 'filled' as const } });
      if (o.status !== 'open') return this.ok({ cancelStatus: { ...base, status: 'notFound' as const } });
      o.status = 'cancelled';
      o.updatedAt = this.now();
      return this.ok({ cancelStatus: { ...base, status: 'cancelled' as const } });
    });
  }

  cancelAllOrders(params?: { symbol?: string }) {
    return this.call('cancelAllOrders', params, () => {
      const cancelled = [...this.orders.values()].filter((o) => o.status === 'open' && (!params?.symbol || o.symbol === params.symbol));
      for (const o of cancelled) {
        o.status = 'cancelled';
        o.updatedAt = this.now();
      }
      return this.ok({
        cancelStatus: {
          cancelOnly: params?.symbol ?? 'all',
          cancelledOrders: cancelled.map((o) => ({ order_id: o.orderId, cliOrdId: o.cliOrdId })),
          orderEvents: [],
          receivedTime: iso(this.now()),
          status: cancelled.length ? ('cancelled' as const) : ('noOrdersToCancel' as const),
        },
      });
    });
  }

  getOpenOrders() {
    return this.call('getOpenOrders', null, () =>
      this.ok({
        openOrders: [...this.orders.values()]
          .filter((o) => o.status === 'open')
          .map((o): FuturesOpenOrder => ({
            order_id: o.orderId,
            ...(o.cliOrdId ? { cliOrdId: o.cliOrdId } : {}),
            status: o.filled > 0 ? 'partiallyFilled' : 'untouched',
            side: o.side,
            orderType: o.type === 'stp' ? 'stop' : 'lmt',
            symbol: o.symbol,
            ...(o.limitPrice !== null ? { limitPrice: o.limitPrice } : {}),
            ...(o.stopPrice !== null ? { stopPrice: o.stopPrice } : {}),
            filledSize: o.filled,
            unfilledSize: o.size - o.filled,
            reduceOnly: o.reduceOnly,
            ...(o.type === 'stp' ? { triggerSignal: o.triggerSignal === 'index' ? 'spot' : o.triggerSignal } : {}),
            lastUpdateTime: iso(o.updatedAt),
            receivedTime: iso(o.createdAt),
          })),
      }),
    );
  }

  getOrderStatus(params?: { orderIds?: string[]; cliOrdIds?: string[] }) {
    return this.call('getOrderStatus', params, () => {
      const now = this.now();
      const orders = [...this.orders.values()]
        .filter((o) => params?.orderIds?.includes(o.orderId) || (o.cliOrdId !== null && params?.cliOrdIds?.includes(o.cliOrdId)))
        .filter((o) => o.status === 'open' || now - o.updatedAt <= 5_000)
        .map((o): FuturesOrderStatusInfo => ({
          order: {
            type: o.type === 'stp' ? 'TRIGGER_ORDER' : 'ORDER',
            orderId: o.orderId,
            cliOrdId: o.cliOrdId,
            symbol: o.symbol,
            side: o.side,
            quantity: o.size,
            filled: o.filled,
            limitPrice: o.limitPrice,
            reduceOnly: o.reduceOnly,
            timestamp: iso(o.createdAt),
            lastUpdateTimestamp: iso(o.updatedAt),
          },
          status: this.statusOf(o),
          updateReason: o.status === 'filled' ? 'FULL_FILL' : o.status === 'cancelled' ? 'CANCELLED_BY_USER' : 'NEW_USER_ORDER',
        }));
      return this.ok({ orders });
    });
  }

  getOpenPositions() {
    return this.call('getOpenPositions', null, () =>
      this.ok({
        openPositions: [...this.positions.entries()].map(([symbol, p]): FuturesOpenPosition => ({
          symbol,
          side: p.size > 0 ? 'long' : 'short',
          size: Math.abs(p.size),
          price: p.price,
          fillTime: iso(p.fillTime),
          unrealizedFunding: null,
          maxFixedLeverage: this.leverage.get(symbol) ?? null,
        })),
      }),
    );
  }

  getFills(params?: { lastFillTime?: string }) {
    return this.call('getFills', params, () => {
      const before = params?.lastFillTime ? Date.parse(params.lastFillTime) : Infinity;
      const fills = this.fills.filter((f) => Date.parse(f.fillTime) < before).sort((a, b) => Date.parse(b.fillTime) - Date.parse(a.fillTime)).slice(0, 100);
      return this.ok({ fills: structuredClone(fills) });
    });
  }

  getAccounts() {
    return this.call('getAccounts', null, () =>
      this.ok({
        accounts: {
          cash: { type: 'cashAccount' as const, balances: {} },
          flex: {
            type: 'multiCollateralMarginAccount' as const,
            currencies: { USD: { quantity: 10_000, value: 10_000, collateral: 10_000 } },
            available: 10_000,
            initialMargin: 0,
            initialMarginWithOrders: 0,
            maintenanceMargin: 0,
            balanceValue: 10_000,
            portfolioValue: 10_000,
            collateralValue: 10_000,
            pnl: 0,
            unrealizedFunding: 0,
            totalUnrealized: 0,
            totalUnrealizedAsMargin: 0,
            availableMargin: 10_000,
            marginEquity: 10_000,
          },
        },
      }),
    );
  }

  getLeverageSettings() {
    return this.call('getLeverageSettings', null, () => this.ok({ leveragePreferences: [...this.leverage.entries()].map(([symbol, maxLeverage]) => ({ symbol, maxLeverage })) }));
  }

  setLeverageSettings(params: { symbol: string; maxLeverage?: number }) {
    return this.call('setLeverageSettings', params, () => {
      if (!this.ignoreLeverageFor.has(params.symbol)) {
        if (params.maxLeverage === undefined) this.leverage.delete(params.symbol);
        else this.leverage.set(params.symbol, params.maxLeverage);
      }
      return this.ok({} as Record<string, never>);
    });
  }

  getAccountLog(params?: FuturesGetAccountLogParams) {
    return this.call('getAccountLog', params, () => {
      const from = params?.from ?? 1;
      const logs = this.accountLogEntries.filter((e) => e.id >= from).slice(0, params?.count ?? 500);
      return { result: 'success' as const, serverTime: iso(this.now()), accountUid: 'fake-account', logs: structuredClone(logs) };
    });
  }

  submitWalletTransfer(params: FuturesInitiateWalletTransferParams) {
    return this.call('submitWalletTransfer', params, () => {
      this.transfers.push(params);
      return this.ok({} as Record<string, never>);
    });
  }
}
