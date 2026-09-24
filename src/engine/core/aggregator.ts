// Aggregazione 15m → 1H / 4H a bucket UTC (invariante I1 del prompt).
//
// - Una candela 1H contiene le candele 15m della stessa ora UTC; una 4H quelle dello stesso
//   blocco di 4 ore UTC (00, 04, 08, 12, 16, 20).
// - Una candela aggregata viene emessa solo quando il suo intervallo è finito (`closeUntil`):
//   nessuna candela 1H/4H è visibile prima della sua chiusura (niente look-ahead).
// - Con un buco nei dati la candela aggregata contiene solo le 15m disponibili; un'ora senza
//   alcuna 15m non produce una candela 1H.
// Su dati senza buchi il risultato coincide con l'aggregazione del backtest legacy (che però,
// in presenza di buchi, univa ore diverse e dipendeva dal fuso del server: D07).
import type { Bar } from '../../server/core/architecture';
import type { Candle } from '../data/dataset';

export const HOUR_MS = 3_600_000;
export const FOUR_HOURS_MS = 4 * HOUR_MS;

export interface CloseResult {
  closed1H: boolean;
  closed4H: boolean;
}

export class CandleAggregator {
  readonly bars1H: Bar[] = [];
  readonly bars4H: Bar[] = [];
  /**
   * Numero di candele 4H chiuse da questo aggregatore. Dipende da quando è iniziato lo storico,
   * quindi NON è stabile tra un riavvio e l'altro: per lo stato persistito si usa
   * `lastClosed4HStart`.
   */
  closed4HCount = 0;
  /** Inizio (UTC) del blocco dell'ultima candela 4H chiusa; null se nessuna è ancora chiusa. */
  lastClosed4HStart: number | null = null;
  lastCandleTime: number | null = null;
  private cur1H: Bar | null = null;
  private cur1HStart = 0;
  private cur4H: Bar | null = null;
  private cur4HStart = 0;

  constructor(private readonly maxBars = 400) {}

  /** Aggiunge una candela 15m chiusa. Le candele devono arrivare in ordine di tempo. */
  addCandle(c: Candle): void {
    if (this.lastCandleTime !== null && c.t <= this.lastCandleTime) {
      throw new Error(`Candela fuori ordine: ${new Date(c.t).toISOString()} dopo ${new Date(this.lastCandleTime).toISOString()}`);
    }
    // Se un bucket precedente non è stato chiuso (closeUntil non chiamato), lo chiude ora.
    this.closeUntil(c.t);
    this.lastCandleTime = c.t;

    const hourStart = Math.floor(c.t / HOUR_MS) * HOUR_MS;
    if (!this.cur1H) {
      this.cur1H = { t: new Date(c.t).toISOString(), o: c.o, h: c.h, l: c.l, c: c.c, v: c.v };
      this.cur1HStart = hourStart;
    } else {
      this.cur1H.h = Math.max(this.cur1H.h, c.h);
      this.cur1H.l = Math.min(this.cur1H.l, c.l);
      this.cur1H.c = c.c;
      this.cur1H.v += c.v;
    }

    const fourStart = Math.floor(c.t / FOUR_HOURS_MS) * FOUR_HOURS_MS;
    if (!this.cur4H) {
      this.cur4H = { t: new Date(c.t).toISOString(), o: c.o, h: c.h, l: c.l, c: c.c, v: c.v };
      this.cur4HStart = fourStart;
    } else {
      this.cur4H.h = Math.max(this.cur4H.h, c.h);
      this.cur4H.l = Math.min(this.cur4H.l, c.l);
      this.cur4H.c = c.c;
      this.cur4H.v += c.v;
    }
  }

  /** Emette le candele 1H/4H il cui intervallo è terminato entro `timeMs`. */
  closeUntil(timeMs: number): CloseResult {
    const result: CloseResult = { closed1H: false, closed4H: false };
    if (this.cur1H && timeMs >= this.cur1HStart + HOUR_MS) {
      this.bars1H.push(this.cur1H);
      if (this.bars1H.length > this.maxBars) this.bars1H.splice(0, this.bars1H.length - this.maxBars);
      this.cur1H = null;
      result.closed1H = true;
    }
    if (this.cur4H && timeMs >= this.cur4HStart + FOUR_HOURS_MS) {
      this.bars4H.push(this.cur4H);
      if (this.bars4H.length > this.maxBars) this.bars4H.splice(0, this.bars4H.length - this.maxBars);
      this.cur4H = null;
      this.closed4HCount++;
      this.lastClosed4HStart = this.cur4HStart;
      result.closed4H = true;
    }
    return result;
  }
}

/** Fine dello slot 15m che inizia a `slotTime`. */
export function slotEnd(slotTime: number): number {
  return slotTime + 15 * 60_000;
}

/** true se lo slot 15m che inizia a `slotTime` è l'ultimo della sua ora (minuto 45). */
export function isHourCloseSlot(slotTime: number): boolean {
  return slotEnd(slotTime) % HOUR_MS === 0;
}
