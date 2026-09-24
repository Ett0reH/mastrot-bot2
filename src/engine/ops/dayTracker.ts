// Statistiche del giorno UTC per il report giornaliero e il confronto con il backtest (F6).
//
// Dai risultati dei tick del DecisionCycle raccoglie, per giorno: i fill applicati al core (con il
// prezzo di riferimento del modello, per lo slippage), l'esito di ogni ingresso deciso (eseguito,
// parziale, non eseguito, respinto dal guardrail, tardivo), gli intenti respinti (il replay del
// giorno li respinge allo stesso modo) e le candele mancanti al momento della decisione.
// Lo stato è JSON e sta nello snapshot del runtime: sopravvive ai riavvii.
import type { ExecutedFill, TickResult } from '../live/decisionCycle';

export type EntryStatus = 'PENDING' | 'FILLED' | 'PARTIAL' | 'UNFILLED' | 'REJECTED_GUARD' | 'STALE' | 'BLOCKED';

export interface EntryOutcome {
  positionId: string;
  symbol: string;
  slotTime: number;
  requestedSize: number;
  referencePrice: number;
  filledSize: number;
  status: EntryStatus;
  reason: string | null;
}

export interface Rejection {
  kind: 'OPEN' | 'CLOSE';
  positionId: string;
  slot: number;
  phase: 'settle' | 'execute';
  reason: string;
}

export interface DayStats {
  day: string;
  /** Fill ESEGUITI nel giorno (ora del fill, come l'account log di Kraken): fee e slippage. */
  fills: ExecutedFill[];
  entries: Record<string, EntryOutcome>;
  rejections: Rejection[];
  /** `${slot}|${symbol}`: candele non disponibili quando lo slot è stato elaborato. */
  missing: string[];
}

/** Prefisso dei rifiuti del guardrail (GatedExecutionPort). */
export const GUARD_REJECTION_PREFIX = 'ingresso bloccato:';
const MAX_MISSING = 500;
/**
 * Una candela mancante cambia le barre 1H/4H del bot finché resta nella finestra delle feature
 * (250 barre 4H ≈ 42 giorni): le candele mancanti restano in memoria per 45 giorni.
 */
export const MISSING_HISTORY_MS = 45 * 24 * 3_600_000;

export interface TrackerState {
  days: Record<string, DayStats>;
  /** `${slot}|${symbol}` delle candele mancanti negli ultimi 45 giorni. */
  recentMissing: string[];
}

export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function emptyDay(day: string): DayStats {
  return { day, fills: [], entries: {}, rejections: [], missing: [] };
}

export class DayTracker {
  readonly days: Record<string, DayStats>;
  recentMissing: string[];

  constructor(state: Partial<TrackerState> = {}) {
    this.days = structuredClone(state.days ?? {});
    this.recentMissing = [...(state.recentMissing ?? [])];
  }

  private day(day: string): DayStats {
    return (this.days[day] ??= emptyDay(day));
  }

  private entry(positionId: string): EntryOutcome | null {
    for (const d of Object.values(this.days)) if (d.entries[positionId]) return d.entries[positionId];
    return null;
  }

  record(result: TickResult, now: number): void {
    // Ogni giorno elaborato ha il suo report, anche senza operazioni.
    for (const e of result.equity) this.day(dayOf(e.slotTime));
    for (const intent of result.intents) {
      if (intent.kind !== 'OPEN') continue;
      this.day(dayOf(intent.slotTime)).entries[intent.positionId] = {
        positionId: intent.positionId,
        symbol: intent.symbol,
        slotTime: intent.slotTime,
        requestedSize: intent.size,
        referencePrice: intent.referencePrice,
        filledSize: 0,
        status: 'PENDING',
        reason: null,
      };
    }
    for (const event of result.events) {
      if (event.type === 'CANDLE_MISSING') {
        const d = this.day(dayOf(event.slot));
        for (const s of event.symbols) {
          if (d.missing.length < MAX_MISSING) d.missing.push(`${event.slot}|${s}`);
          this.recentMissing.push(`${event.slot}|${s}`);
        }
        this.recentMissing = this.recentMissing.filter((k) => Number(k.split('|')[0]) >= event.slot - MISSING_HISTORY_MS).slice(-2_000);
      } else if (event.type === 'INTENT_REJECTED') {
        this.day(dayOf(event.slot)).rejections.push({ kind: event.kind, positionId: event.positionId, slot: event.slot, phase: event.phase, reason: event.reason });
        const e = event.kind === 'OPEN' ? this.entry(event.positionId) : null;
        if (e && e.filledSize === 0) {
          e.status = event.reason.startsWith(GUARD_REJECTION_PREFIX) ? 'REJECTED_GUARD' : 'UNFILLED';
          e.reason = event.reason;
        }
      } else if (event.type === 'STALE_ENTRY_REJECTED' || event.type === 'ENTRY_BLOCKED') {
        const reason = event.type === 'STALE_ENTRY_REJECTED' ? `ingresso tardivo (${Math.round(event.delayMs / 60_000)} min)` : event.reason;
        this.day(dayOf(event.slot)).rejections.push({ kind: 'OPEN', positionId: event.positionId, slot: event.slot, phase: 'execute', reason });
        const e = this.entry(event.positionId);
        if (e) {
          e.status = event.type === 'STALE_ENTRY_REJECTED' ? 'STALE' : 'BLOCKED';
          e.reason = reason;
        }
      }
    }
    this.recordFills(result.fills, now);
  }

  recordFills(fills: readonly ExecutedFill[], now: number): void {
    for (const fill of fills) {
      // Giorno dell'esecuzione (un'uscita decisa alle 23:45 si esegue dopo mezzanotte), come Kraken.
      this.day(dayOf(Number.isFinite(fill.time) ? fill.time : now)).fills.push(fill);
      if (fill.kind !== 'OPEN') continue;
      const e = this.entry(fill.positionId);
      if (!e) continue;
      e.filledSize += fill.size;
      e.status = e.filledSize >= e.requestedSize * (1 - 1e-9) ? 'FILLED' : 'PARTIAL';
    }
  }

  /** Fill applicati al core negli slot di `day` (per il replay), da tutti i giorni in memoria. */
  fillsAppliedIn(day: string): ExecutedFill[] {
    return Object.values(this.days)
      .flatMap((d) => d.fills)
      .filter((f) => f.appliedAtSlot !== null && dayOf(f.appliedAtSlot) === day)
      .sort((a, b) => (a.appliedAtSlot as number) - (b.appliedAtSlot as number) || a.time - b.time);
  }

  /** Giorni conclusi (precedenti a `currentDay`), ancora da riportare. */
  completedBefore(currentDay: string): string[] {
    return Object.keys(this.days).filter((d) => d < currentDay).sort();
  }

  take(day: string): DayStats {
    const stats = this.days[day] ?? emptyDay(day);
    delete this.days[day];
    return stats;
  }

  snapshot(): TrackerState {
    return { days: structuredClone(this.days), recentMissing: [...this.recentMissing] };
  }
}
