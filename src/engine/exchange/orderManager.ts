// OrderManager idempotente (F3: D17, D18; invarianti I8 e I9).
//
// 1. Il record dell'ordine, con cliOrdId deterministico, viene salvato PRIMA dell'invio.
// 2. L'invio è un solo tentativo con `processBefore`: oltre quell'istante Kraken non elabora più
//    l'ordine (status wouldProcessAfterSpecifiedTime), quindi dopo la scadenza l'assenza di
//    tracce è una prova e non un'ipotesi.
// 3. Se l'esito è incerto (timeout, errore di rete, 5xx) l'ordine è UNKNOWN. La riconciliazione
//    legge lo stato per cliOrdId, gli ordini aperti e i fill; un ordine UNKNOWN non diventa mai
//    eseguito o chiuso per default.
// 4. Un nuovo tentativo (nuovo cliOrdId, attempt + 1) è ammesso solo per un ordine che la
//    riconciliazione ha dimostrato senza effetti (REJECTED, o CANCELED senza fill).
import type { FuturesFill, FuturesOpenOrder, FuturesOrderStatusInfo, FuturesSendOrderParams, FuturesSendOrderStatus } from '@siebly/kraken-api';
import type { KrakenAdapter, Priority } from './krakenAdapter';
import {
  assertTransition,
  makeCliOrdId,
  type OrderFill,
  type OrderPurpose,
  type OrderRecord,
  type OrderSide,
  type OrderState,
  type OrderStore,
  type OrderType,
  TERMINAL_STATES,
} from './orders';

export interface OrderRequest {
  intentKey: string;
  purpose: OrderPurpose;
  symbol: string;
  side: OrderSide;
  orderType: OrderType;
  size: number;
  limitPrice?: number;
  stopPrice?: number;
  reduceOnly: boolean;
  triggerSignal?: 'mark' | 'last' | 'index';
}

export interface OrderManagerOptions {
  now: () => number;
  /** Finestra entro cui Kraken può elaborare l'ordine (processBefore = invio + finestra). */
  processWindowMs?: number;
  /** Margine dopo processBefore prima di concludere che un ordine senza tracce non è stato elaborato. */
  graceMs?: number;
}

/** Status di sendorder che confermano l'accettazione (FuturesSendOrderStatus.status). */
const ACCEPTED = new Set(['placed', 'partiallyFilled', 'filled']);

export class OrderManager {
  private readonly processWindowMs: number;
  private readonly graceMs: number;

  constructor(
    private readonly adapter: KrakenAdapter,
    readonly store: OrderStore,
    private readonly options: OrderManagerOptions,
  ) {
    this.processWindowMs = options.processWindowMs ?? 15_000;
    this.graceMs = options.graceMs ?? 5_000;
  }

  private iso(ms: number): string {
    return new Date(ms).toISOString();
  }

  private async transition(record: OrderRecord, to: OrderState, note: string): Promise<void> {
    assertTransition(record.state, to);
    record.state = to;
    record.updatedAt = this.iso(this.options.now());
    record.history.push({ at: record.updatedAt, state: to, note });
    await this.store.save(record);
  }

  private mergeFills(record: OrderRecord, fills: readonly OrderFill[]): void {
    const known = new Set(record.fills.map((f) => f.fillId));
    for (const f of fills) if (!known.has(f.fillId)) record.fills.push(f);
    record.filledSize = record.fills.reduce((a, f) => a + f.size, 0);
  }

  /** Invia un ordine nuovo. Il record è salvato prima dell'invio; l'esito incerto è UNKNOWN. */
  async submit(request: OrderRequest, attempt = 1, priority: Priority = 'normal', processWindowMs = this.processWindowMs): Promise<OrderRecord> {
    if (!(request.size > 0)) throw new Error(`Size non valida per ${request.intentKey}: ${request.size}`);
    const cliOrdId = makeCliOrdId(request.intentKey, request.purpose, attempt);
    if (await this.store.get(cliOrdId)) throw new Error(`cliOrdId già usato, un ordine non si reinvia: ${cliOrdId}`);
    const now = this.options.now();
    const record: OrderRecord = {
      cliOrdId,
      intentKey: request.intentKey,
      purpose: request.purpose,
      attempt,
      symbol: request.symbol,
      side: request.side,
      orderType: request.orderType,
      size: request.size,
      limitPrice: request.limitPrice ?? null,
      stopPrice: request.stopPrice ?? null,
      reduceOnly: request.reduceOnly,
      state: 'INTENT_CREATED',
      exchangeOrderId: null,
      filledSize: 0,
      fills: [],
      processBefore: this.iso(now + processWindowMs),
      createdAt: this.iso(now),
      updatedAt: this.iso(now),
      lastError: null,
      history: [{ at: this.iso(now), state: 'INTENT_CREATED', note: 'intento registrato' }],
    };
    await this.store.save(record);
    await this.transition(record, 'SUBMITTED', 'invio a Kraken');

    const params: FuturesSendOrderParams = {
      orderType: request.orderType,
      symbol: request.symbol,
      side: request.side,
      size: request.size,
      cliOrdId,
      reduceOnly: request.reduceOnly,
      processBefore: record.processBefore,
      ...(request.limitPrice !== undefined ? { limitPrice: request.limitPrice } : {}),
      ...(request.stopPrice !== undefined ? { stopPrice: request.stopPrice } : {}),
      ...(request.triggerSignal !== undefined ? { triggerSignal: request.triggerSignal } : {}),
    };
    const result = await this.adapter.sendOrder(params, priority);
    if (result.outcome === 'failed') {
      record.lastError = `${result.error.kind}: ${result.error.message}`;
      if (result.error.mayHaveReachedExchange) await this.transition(record, 'UNKNOWN', 'esito incerto: da riconciliare');
      else await this.transition(record, 'REJECTED', `non elaborato (${result.error.kind})`);
      return record;
    }
    await this.applySendStatus(record, result.value);
    return record;
  }

  private async applySendStatus(record: OrderRecord, status: FuturesSendOrderStatus): Promise<void> {
    record.exchangeOrderId = status.order_id ?? record.exchangeOrderId;
    const executions: OrderFill[] = [];
    for (const event of status.orderEvents ?? []) {
      if (event.type === 'EXECUTION') executions.push({ fillId: event.executionId, price: event.price, size: event.amount, time: status.receivedTime ?? record.updatedAt });
    }
    this.mergeFills(record, executions);
    const s = status.status;
    const immediate = record.orderType === 'ioc' || record.orderType === 'mkt';
    if (ACCEPTED.has(s)) {
      if (record.filledSize >= record.size) await this.transition(record, 'FILLED', `eseguito (${s})`);
      else if (immediate && record.filledSize > 0) await this.transition(record, 'CANCELED', `eseguito in parte, resto cancellato (${s})`);
      else if (immediate) await this.transition(record, 'UNKNOWN', `accettato senza esecuzioni nella risposta (${s}): da riconciliare`);
      else if (record.filledSize > 0) await this.transition(record, 'PARTIAL', `eseguito in parte (${s})`);
      else await this.transition(record, 'ACKNOWLEDGED', `accettato (${s})`);
      return;
    }
    record.lastError = s;
    if (s === 'iocWouldNotExecute' || s === 'cancelled') {
      await this.transition(record, 'CANCELED', record.filledSize > 0 ? `eseguito in parte (${s})` : `nessuna esecuzione (${s})`);
    } else if (s === 'clientOrderIdAlreadyExist') {
      await this.transition(record, 'UNKNOWN', 'cliOrdId già presente su Kraken: da riconciliare');
    } else {
      await this.transition(record, 'REJECTED', `rifiutato da Kraken (${s})`);
    }
  }

  /** Fill dell'account a partire da `sinceIso`, scorrendo le pagine di Kraken (100 per pagina). */
  async fillsSince(sinceIso: string, priority: Priority = 'normal'): Promise<FuturesFill[]> {
    const since = Date.parse(sinceIso);
    const out = new Map<string, FuturesFill>();
    let lastFillTime: string | undefined;
    for (let page = 0; page < 20; page++) {
      const batch = await this.adapter.fills(lastFillTime, priority);
      if (batch.length === 0) break;
      for (const f of batch) out.set(f.fill_id, f);
      const oldest = batch.reduce((min, f) => (Date.parse(f.fillTime) < Date.parse(min.fillTime) ? f : min), batch[0]);
      if (Date.parse(oldest.fillTime) < since || batch.length < 100 || oldest.fillTime === lastFillTime) break;
      lastFillTime = oldest.fillTime;
    }
    return [...out.values()].filter((f) => Date.parse(f.fillTime) >= since).sort((a, b) => Date.parse(a.fillTime) - Date.parse(b.fillTime));
  }

  /** Riconcilia gli ordini non terminali con Kraken. */
  async reconcileAll(priority: Priority = 'normal'): Promise<OrderRecord[]> {
    const active = await this.store.active();
    if (active.length === 0) return [];
    const ids = active.map((r) => r.cliOrdId);
    const since = active.reduce((min, r) => (r.createdAt < min ? r.createdAt : min), active[0].createdAt);
    const [statuses, openOrders, fills] = await Promise.all([
      this.adapter.orderStatus({ cliOrdIds: ids }, priority),
      this.adapter.openOrders(priority),
      this.fillsSince(this.iso(Date.parse(since) - 60_000), priority),
    ]);
    const out: OrderRecord[] = [];
    for (const record of active) out.push(await this.reconcileWith(record, { statuses, openOrders, fills }));
    return out;
  }

  async reconcile(cliOrdId: string, priority: Priority = 'normal'): Promise<OrderRecord> {
    const record = await this.store.get(cliOrdId);
    if (!record) throw new Error(`Ordine sconosciuto: ${cliOrdId}`);
    if (TERMINAL_STATES.has(record.state)) return record;
    const [statuses, openOrders, fills] = await Promise.all([
      this.adapter.orderStatus({ cliOrdIds: [cliOrdId] }, priority),
      this.adapter.openOrders(priority),
      this.fillsSince(this.iso(Date.parse(record.createdAt) - 60_000), priority),
    ]);
    return this.reconcileWith(record, { statuses, openOrders, fills });
  }

  private async reconcileWith(
    record: OrderRecord,
    snapshot: { statuses: FuturesOrderStatusInfo[]; openOrders: FuturesOpenOrder[]; fills: FuturesFill[] },
  ): Promise<OrderRecord> {
    const own = snapshot.fills.filter((f) => f.cliOrdId === record.cliOrdId || (record.exchangeOrderId !== null && f.order_id === record.exchangeOrderId));
    this.mergeFills(record, own.map((f) => ({ fillId: f.fill_id, price: f.price, size: f.size, time: f.fillTime })));
    if (own.length > 0 && record.exchangeOrderId === null) record.exchangeOrderId = own[0].order_id;

    const info = snapshot.statuses.find((s) => s.order.cliOrdId === record.cliOrdId);
    const open = snapshot.openOrders.find((o) => o.cliOrdId === record.cliOrdId || (record.exchangeOrderId !== null && o.order_id === record.exchangeOrderId));
    const full = record.filledSize >= record.size;
    const target = this.targetState(record, info ?? null, open ?? null, full);
    if (target === null) {
      await this.store.save(record);
      return record;
    }
    if (info?.order.orderId) record.exchangeOrderId = info.order.orderId;
    else if (open) record.exchangeOrderId = open.order_id;
    await this.transition(record, target.state, target.note);
    return record;
  }

  /** Stato dopo la riconciliazione; null = nessuna prova sufficiente, resta com'è. */
  private targetState(record: OrderRecord, info: FuturesOrderStatusInfo | null, open: FuturesOpenOrder | null, full: boolean): { state: OrderState; note: string } | null {
    if (full) return { state: 'FILLED', note: 'riconciliato: eseguito per intero' };
    if (info) {
      switch (info.status) {
        case 'FULLY_EXECUTED':
          // Lo stato dice eseguito ma i fill non sono ancora visibili: si aspetta di averli.
          return null;
        case 'CANCELLED':
          return { state: 'CANCELED', note: `riconciliato: cancellato (${info.updateReason})` };
        case 'REJECTED':
          return { state: 'REJECTED', note: `riconciliato: rifiutato (${info.updateReason})` };
        case 'TRIGGER_ACTIVATION_FAILURE':
          return { state: 'CANCELED', note: 'riconciliato: attivazione dello stop fallita' };
        case 'ENTERED_BOOK':
        case 'TRIGGER_PLACED':
          return record.filledSize > 0 ? { state: 'PARTIAL', note: 'riconciliato: aperto, eseguito in parte' } : { state: 'ACKNOWLEDGED', note: 'riconciliato: aperto' };
      }
    }
    if (open) return record.filledSize > 0 ? { state: 'PARTIAL', note: 'riconciliato: aperto, eseguito in parte' } : { state: 'ACKNOWLEDGED', note: 'riconciliato: aperto' };
    // Né aperto né visibile nello stato (che copre solo gli ultimi 5 secondi): si conclude solo
    // dopo processBefore, quando Kraken non può più elaborarlo.
    const deadlinePassed = this.options.now() > Date.parse(record.processBefore) + this.graceMs;
    if (!deadlinePassed) return null;
    if (record.filledSize > 0) return { state: 'CANCELED', note: 'riconciliato: non più aperto, eseguito in parte' };
    if (record.state === 'ACKNOWLEDGED' || record.state === 'PARTIAL') return { state: 'CANCELED', note: 'riconciliato: non più aperto e senza fill (cancellato o scaduto)' };
    return { state: 'REJECTED', note: 'riconciliato: nessuna traccia su Kraken dopo processBefore, mai elaborato' };
  }

  /**
   * Nuovo tentativo di un ordine che la riconciliazione ha dimostrato senza effetti.
   * Per qualsiasi altro stato lancia: un retry non deve mai poter creare un secondo ordine.
   */
  async retry(previous: OrderRecord, request: OrderRequest, priority: Priority = 'normal'): Promise<OrderRecord> {
    const current = await this.store.get(previous.cliOrdId);
    if (!current) throw new Error(`Ordine sconosciuto: ${previous.cliOrdId}`);
    const noEffect = current.state === 'REJECTED' || (current.state === 'CANCELED' && current.filledSize === 0);
    if (!noEffect) throw new Error(`Retry non ammesso per ${current.cliOrdId} in stato ${current.state} (fill ${current.filledSize})`);
    return this.submit(request, current.attempt + 1, priority);
  }
}
