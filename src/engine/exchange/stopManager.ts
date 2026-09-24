// StopManager: ogni posizione ha uno stop nativo su Kraken (F3, invariante I7).
//
// Lo stop è un ordine `stp` reduceOnly sul mark price (triggerSignal 'mark') con size pari alla
// posizione, al livello del backstop deciso dal core (STOP_MODEL della sezione 2). `ensure` è
// idempotente e si chiama dopo ogni ingresso, a ogni aggiornamento (chiusura 1H) e a ogni ciclo
// di protezione: verifica lo stop sugli ordini aperti di Kraken, lo corregge con editorder e
// RILEGGE il risultato; se la modifica non va a buon fine lo sostituisce; se non riesce a
// proteggere la posizione lo segnala (il chiamante chiude la posizione: chiusura d'emergenza).
// Uno stop fuori livello resta comunque una protezione: non si chiude una posizione protetta.
import type { FuturesOpenOrder } from '@siebly/kraken-api';
import { type AlertSink, makeAlert } from '../ops/alerts';
import { type InstrumentRegistry, roundToTick } from './instruments';
import type { KrakenAdapter } from './krakenAdapter';
import type { OrderManager } from './orderManager';
import type { OrderRecord } from './orders';

export interface StopTarget {
  positionId: string;
  /** Contratto Kraken (es. PF_XBTUSD). */
  symbol: string;
  direction: 'LONG' | 'SHORT';
  /** Size della posizione su Kraken. */
  size: number;
  /** Livello desiderato dello stop (backstop del core). */
  level: number;
}

export type ProtectionStatus =
  | { status: 'PROTECTED'; stop: OrderRecord; stale: boolean }
  | { status: 'PENDING'; reason: string }
  | { status: 'NO_POSITION'; reason: string }
  | { status: 'FAILED'; reason: string };

export interface StopManagerOptions {
  now: () => number;
  /** Rifiuti consecutivi dopo i quali la protezione è dichiarata fallita. */
  maxConsecutiveFailures?: number;
  /** Finestra di elaborazione degli ordini di protezione (breve: l'esito serve subito). */
  processWindowMs?: number;
}

export class StopManager {
  private readonly maxFailures: number;
  private readonly processWindowMs: number;

  constructor(
    private readonly orders: OrderManager,
    private readonly adapter: KrakenAdapter,
    private readonly instruments: InstrumentRegistry,
    private readonly alerts: AlertSink,
    private readonly options: StopManagerOptions,
  ) {
    this.maxFailures = options.maxConsecutiveFailures ?? 3;
    this.processWindowMs = options.processWindowMs ?? 5_000;
  }

  private async alert(level: 'info' | 'warning' | 'critical', code: Parameters<typeof makeAlert>[2], message: string, context: Record<string, unknown>): Promise<void> {
    await this.alerts.send(makeAlert(this.options.now(), level, code, message, context));
  }

  /** Prezzo dello stop sul tick del contratto, mai più vicino al prezzo di quanto richiesto. */
  async stopPrice(target: StopTarget): Promise<number> {
    const spec = await this.instruments.get(target.symbol);
    return roundToTick(target.level, spec.tickSize, target.direction === 'LONG' ? 'down' : 'up');
  }

  private async stopRecords(positionId: string): Promise<OrderRecord[]> {
    return (await this.orders.store.byIntent(positionId)).filter((r) => r.purpose === 'STOP').sort((a, b) => a.attempt - b.attempt);
  }

  private matches(live: FuturesOpenOrder, price: number, size: number, side: 'buy' | 'sell'): boolean {
    const unfilled = live.unfilledSize ?? null;
    return live.orderType === 'stop' && live.reduceOnly && live.side === side && live.stopPrice === price && unfilled === size;
  }

  async ensure(target: StopTarget, openOrders?: FuturesOpenOrder[]): Promise<ProtectionStatus> {
    const price = await this.stopPrice(target);
    const side = target.direction === 'LONG' ? 'sell' : 'buy';
    const records = await this.stopRecords(target.positionId);
    let latest = records.length ? records[records.length - 1] : null;

    if (latest && (latest.state === 'UNKNOWN' || latest.state === 'SUBMITTED' || latest.state === 'INTENT_CREATED')) {
      latest = await this.orders.reconcile(latest.cliOrdId, 'protective');
      if (latest.state === 'UNKNOWN' || latest.state === 'SUBMITTED') return { status: 'PENDING', reason: `esito dello stop ${latest.cliOrdId} in riconciliazione` };
    }

    if (latest && latest.state === 'CANCELED') {
      // Lo stop risulta chiuso senza che il bot lo abbia sostituito: eseguito o sparito.
      if (latest.filledSize > 0) return { status: 'PENDING', reason: `stop ${latest.cliOrdId} eseguito: posizione in chiusura` };
      await this.alert('critical', 'STOP_MISSING', `Stop mancante su ${target.symbol}: viene ripristinato`, { positionId: target.positionId, stop: latest.cliOrdId });
    }

    let open = openOrders ?? (await this.adapter.openOrders('protective'));
    if (latest && (latest.state === 'ACKNOWLEDGED' || latest.state === 'PARTIAL')) {
      const current: OrderRecord = latest;
      const live = open.find((o) => o.cliOrdId === current.cliOrdId || (current.exchangeOrderId !== null && o.order_id === current.exchangeOrderId));
      if (live && this.matches(live, price, target.size, side)) return { status: 'PROTECTED', stop: current, stale: false };
      if (live) {
        const edit = await this.adapter.editOrder({ orderId: live.order_id, stopPrice: price, size: target.size }, 'protective');
        if (edit.outcome === 'ok' && edit.value.status === 'edited') {
          open = await this.adapter.openOrders('protective');
          const check = open.find((o) => o.order_id === live.order_id);
          if (check && this.matches(check, price, target.size, side)) {
            current.stopPrice = price;
            current.size = target.size;
            current.history.push({ at: new Date(this.options.now()).toISOString(), state: current.state, note: `stop spostato a ${price}, size ${target.size}` });
            await this.orders.store.save(current);
            return { status: 'PROTECTED', stop: current, stale: false };
          }
        }
        // Modifica non riuscita o non verificata: si sostituisce lo stop.
        const cancel = await this.adapter.cancelOrder({ order_id: live.order_id }, 'protective');
        const afterCancel = await this.orders.reconcile(current.cliOrdId, 'protective');
        if (cancel.outcome === 'failed' || afterCancel.state === 'ACKNOWLEDGED' || afterCancel.state === 'PARTIAL') {
          await this.alert('warning', 'STOP_PLACEMENT_FAILED', `Stop ${current.cliOrdId} non aggiornato: resta attivo al livello precedente`, { positionId: target.positionId, wanted: price, current: live.stopPrice });
          return { status: 'PROTECTED', stop: afterCancel, stale: true };
        }
        if (afterCancel.filledSize > 0) return { status: 'PENDING', reason: 'lo stop è stato eseguito durante l aggiornamento: posizione in chiusura' };
      } else {
        const gone = await this.orders.reconcile(current.cliOrdId, 'protective');
        if (gone.filledSize > 0) return { status: 'PENDING', reason: `stop ${gone.cliOrdId} eseguito: posizione in chiusura` };
        if (gone.state === 'ACKNOWLEDGED' || gone.state === 'PARTIAL') return { status: 'PENDING', reason: `stop ${gone.cliOrdId} non visibile tra gli ordini aperti, in verifica` };
        await this.alert('critical', 'STOP_MISSING', `Stop mancante su ${target.symbol}: viene ripristinato`, { positionId: target.positionId, stop: gone.cliOrdId });
      }
    }

    // Nessuno stop attivo: se ne piazza uno nuovo.
    const all = await this.stopRecords(target.positionId);
    const lastGood = all.map((r) => r.state === 'ACKNOWLEDGED' || r.state === 'PARTIAL' || r.state === 'CANCELED').lastIndexOf(true);
    const failures = all.slice(lastGood + 1).filter((r) => r.state === 'REJECTED').length;
    if (failures >= this.maxFailures) return { status: 'FAILED', reason: `${failures} rifiuti consecutivi dello stop` };
    const attempt = (all.length ? all[all.length - 1].attempt : 0) + 1;
    if (attempt > 99) return { status: 'FAILED', reason: 'limite di tentativi dello stop raggiunto' };
    const record = await this.orders.submit(
      { intentKey: target.positionId, purpose: 'STOP', symbol: target.symbol, side, orderType: 'stp', size: target.size, stopPrice: price, reduceOnly: true, triggerSignal: 'mark' },
      attempt,
      'protective',
      this.processWindowMs,
    );
    if (record.state === 'ACKNOWLEDGED') {
      const live = (await this.adapter.openOrders('protective')).find((o) => o.cliOrdId === record.cliOrdId);
      if (live && this.matches(live, price, target.size, side)) {
        if (attempt > 1) await this.alert('info', 'STOP_RESTORED', `Stop su ${target.symbol} attivo a ${price}`, { positionId: target.positionId, stop: record.cliOrdId });
        return { status: 'PROTECTED', stop: record, stale: false };
      }
      return { status: 'PENDING', reason: `stop ${record.cliOrdId} accettato ma non verificato tra gli ordini aperti` };
    }
    if (record.filledSize > 0) return { status: 'PENDING', reason: `stop ${record.cliOrdId} eseguito subito: prezzo già oltre il livello` };
    if (record.state === 'UNKNOWN') return { status: 'PENDING', reason: `esito dello stop ${record.cliOrdId} incerto` };
    if (record.lastError === 'wouldNotReducePosition') return { status: 'NO_POSITION', reason: 'Kraken non ha una posizione da proteggere' };
    await this.alert('warning', 'STOP_PLACEMENT_FAILED', `Stop su ${target.symbol} rifiutato (${record.lastError})`, { positionId: target.positionId, stop: record.cliOrdId });
    return failures + 1 >= this.maxFailures
      ? { status: 'FAILED', reason: `${failures + 1} rifiuti consecutivi dello stop (ultimo: ${record.lastError})` }
      : { status: 'PENDING', reason: `stop rifiutato (${record.lastError}), nuovo tentativo al prossimo ciclo` };
  }

  /** Cancella gli stop attivi della posizione (dopo la chiusura). */
  async remove(positionId: string): Promise<void> {
    for (const record of await this.stopRecords(positionId)) {
      if (record.state !== 'ACKNOWLEDGED' && record.state !== 'PARTIAL' && record.state !== 'UNKNOWN') continue;
      await this.adapter.cancelOrder({ cliOrdId: record.cliOrdId }, 'protective');
      await this.orders.reconcile(record.cliOrdId, 'protective');
    }
  }

  /** Chiusura d'emergenza reduceOnly a mercato di una posizione che non si riesce a proteggere. */
  async emergencyClose(target: StopTarget, reason: string): Promise<OrderRecord> {
    const previous = (await this.orders.store.byIntent(target.positionId)).filter((r) => r.purpose === 'EMERGENCY_CLOSE');
    const attempt = previous.length + 1;
    await this.alert('critical', 'EMERGENCY_CLOSE', `Chiusura d'emergenza di ${target.symbol}: ${reason}`, { positionId: target.positionId, size: target.size });
    return this.orders.submit(
      { intentKey: target.positionId, purpose: 'EMERGENCY_CLOSE', symbol: target.symbol, side: target.direction === 'LONG' ? 'sell' : 'buy', orderType: 'mkt', size: target.size, reduceOnly: true },
      attempt,
      'protective',
      this.processWindowMs,
    );
  }
}
