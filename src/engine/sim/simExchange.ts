// Exchange simulato, usato dal backtest e dal replay del percorso live (F2).
//
// Modello di esecuzione:
// - OPEN / CLOSE a mercato al prezzo di riferimento (chiusura della candela 1H) con slippage
//   sfavorevole in punti base e fee sul nozionale;
// - backstop nativo: uno stop "a riposo" per ogni posizione, controllato su ogni candela 15m
//   successiva (minimo per i LONG, massimo per gli SHORT). Se la candela apre già oltre il
//   livello (gap) il fill avviene all'apertura, altrimenti al livello; poi slippage e fee;
// - il modello legacy (`LEGACY_EXECUTION`) non ha slippage né backstop: riproduce il backtest
//   di riferimento.
import type { Candle } from '../data/dataset';
import type { Direction, Fill, Intent } from '../core/types';

export interface ExecutionModel {
  feeRate: number;
  slippageBps: number;
  /** Se false gli stop nativi non vengono simulati (backtest legacy). */
  simulateBackstop: boolean;
}

export const LEGACY_EXECUTION: ExecutionModel = { feeRate: 0.0005, slippageBps: 0, simulateBackstop: false };

export interface RestingStop {
  positionId: string;
  symbol: string;
  direction: Direction;
  size: number;
  level: number;
}

export class SimExchange {
  private readonly stops = new Map<string, RestingStop>();

  constructor(readonly model: ExecutionModel, restingStops: readonly RestingStop[] = []) {
    for (const s of restingStops) this.stops.set(s.positionId, { ...s });
  }

  /** Stop a riposo, serializzabili (lo shadow li persiste tra un riavvio e l'altro). */
  snapshot(): RestingStop[] {
    return [...this.stops.values()].map((s) => ({ ...s }));
  }

  private slip(price: number, side: 'buy' | 'sell'): number {
    const s = this.model.slippageBps / 10_000;
    if (s === 0) return price;
    return side === 'buy' ? price * (1 + s) : price * (1 - s);
  }

  private fee(size: number, price: number): number {
    return size * price * this.model.feeRate;
  }

  /** Stop nativi scattati durante la candela 15m (da chiamare prima di passare la candela al core). */
  onCandles(slotTime: number, candles: Readonly<Record<string, Candle | undefined>>): Fill[] {
    if (!this.model.simulateBackstop) return [];
    const fills: Fill[] = [];
    for (const stop of [...this.stops.values()]) {
      const c = candles[stop.symbol];
      if (!c) continue;
      let trigger: number | null = null;
      if (stop.direction === 'LONG' && c.l <= stop.level) trigger = Math.min(stop.level, c.o);
      if (stop.direction === 'SHORT' && c.h >= stop.level) trigger = Math.max(stop.level, c.o);
      if (trigger === null) continue;
      const price = this.slip(trigger, stop.direction === 'LONG' ? 'sell' : 'buy');
      fills.push({
        kind: 'CLOSE',
        symbol: stop.symbol,
        positionId: stop.positionId,
        price,
        size: stop.size,
        fee: this.fee(stop.size, price),
        time: slotTime,
        exitType: 'BACKSTOP',
        source: 'sim',
      });
      this.stops.delete(stop.positionId);
    }
    return fills;
  }

  /** Esegue gli intenti di uno slot: tutti i fill avvengono al prezzo di riferimento (+ slippage). */
  execute(intents: readonly Intent[]): Fill[] {
    const fills: Fill[] = [];
    for (const intent of intents) {
      if (intent.kind === 'OPEN') {
        const price = this.slip(intent.referencePrice, intent.direction === 'LONG' ? 'buy' : 'sell');
        fills.push({ kind: 'OPEN', symbol: intent.symbol, positionId: intent.positionId, price, size: intent.size, fee: this.fee(intent.size, price), time: intent.slotTime, source: 'sim' });
        if (this.model.simulateBackstop) {
          this.stops.set(intent.positionId, { positionId: intent.positionId, symbol: intent.symbol, direction: intent.direction, size: intent.size, level: intent.backstop });
        }
      } else if (intent.kind === 'CLOSE') {
        const price = this.slip(intent.referencePrice, intent.direction === 'LONG' ? 'sell' : 'buy');
        fills.push({ kind: 'CLOSE', symbol: intent.symbol, positionId: intent.positionId, price, size: intent.size, fee: this.fee(intent.size, price), time: intent.slotTime, exitType: intent.exitType, source: 'sim' });
        this.stops.delete(intent.positionId);
      } else if (this.model.simulateBackstop) {
        const stop = this.stops.get(intent.positionId);
        if (stop) stop.level = intent.backstop;
      }
    }
    return fills;
  }

  restingStop(positionId: string): number | null {
    return this.stops.get(positionId)?.level ?? null;
  }
}
