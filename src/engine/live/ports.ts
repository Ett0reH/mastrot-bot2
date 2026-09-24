// Porte del ciclo decisionale live (F2 Fase C): dati di mercato ed esecuzione.
//
// Il DecisionCycle usa solo queste interfacce. Il replay le implementa con dati storici,
// orologio simulato ed exchange simulato; il live (F3/F4) con Kraken. Così il codice che prende
// le decisioni è lo stesso in replay e in live.
import type { Direction, Fill, Intent } from '../core/types';
import type { Candle } from '../data/dataset';

/** Candele 15m di mercato (dati pubblici di produzione, gli stessi del backtest). */
export interface CandleSource {
  /**
   * Candele con `t` in [fromMs, toMs], in ordine di tempo. Una fonte reale può restituire anche
   * la candela ancora in formazione o candele fuori intervallo: il ciclo le scarta.
   */
  fetchCandles(symbol: string, fromMs: number, toMs: number): Promise<Candle[]>;
}

/** Posizione aperta con il prezzo di riferimento per il funding dell'ora. */
export interface FundingPosition {
  positionId: string;
  symbol: string;
  direction: Direction;
  size: number;
  markPrice: number;
}

/** Funding dell'ora per una posizione: positivo = costo pagato dal bot. */
export interface FundingCharge {
  symbol: string;
  positionId: string;
  amount: number;
}

export interface ExecutionReport {
  fills: Fill[];
  /** Intenti che l'exchange non ha eseguito (con il motivo). */
  rejected: { positionId: string; reason: string }[];
}

export interface ExecutionPort {
  /**
   * Stop nativi eseguiti dall'exchange durante lo slot, da applicare prima che il core elabori lo
   * slot. `candles` sono le candele dello slot: servono agli exchange simulati; quello reale le
   * ignora e legge i fill da Kraken.
   */
  protectiveFills(slotTime: number, candles: Readonly<Record<string, Candle | undefined>>): Promise<Fill[]>;
  /** Funding dell'ora che si chiude con lo slot `hourCloseSlot`. */
  funding(hourCloseSlot: number, positions: readonly FundingPosition[]): Promise<FundingCharge[]>;
  /** Esegue gli intenti di una chiusura oraria. Un intento né eseguito né rifiutato resta pendente. */
  execute(intents: readonly Intent[]): Promise<ExecutionReport>;
}
