// Profili di esecuzione del backtest.
// - legacy: riproduce il backtest di riferimento (fill alla chiusura, niente slippage né stop nativi);
// - realistic: modello di esecuzione del live (sezione 2 del prompt): stop della strategia alla
//   chiusura 1H più backstop nativo al 3% oltre lo stop, slippage 5 bps per fill, fee 0,05%.
//   Il funding va aggiunto quando è disponibile lo storico (npm run data:download).
import type { BackstopModel } from '../core/decisionCore';
import { type ExecutionModel, LEGACY_EXECUTION } from '../sim/simExchange';
import type { FundingModel } from './runner';

export interface BacktestProfile {
  id: string;
  label: string;
  execution: ExecutionModel;
  backstop: { model: BackstopModel; bufferPct: number };
  funding: FundingModel;
}

export const LEGACY_PROFILE: BacktestProfile = {
  id: 'legacy',
  label: 'Legacy (riferimento)',
  execution: LEGACY_EXECUTION,
  backstop: { model: 'none', bufferPct: 0 },
  funding: { kind: 'none' },
};

export const REALISTIC_PROFILE: BacktestProfile = {
  id: 'realistic',
  label: 'Realistico (backstop 3%, slippage 5 bps)',
  execution: { feeRate: 0.0005, slippageBps: 5, simulateBackstop: true },
  backstop: { model: 'close_based_plus_native_backstop', bufferPct: 3 },
  funding: { kind: 'none' },
};

/** 0,01% ogni 8 ore pagato dai LONG (livello tipico di mercato rialzista), in forma oraria. */
export const CONSTANT_FUNDING_HOURLY = 0.0001 / 8;
