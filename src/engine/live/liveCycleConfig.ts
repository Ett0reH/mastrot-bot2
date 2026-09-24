// Configurazione del ciclo decisionale live a partire dalla configurazione validata (F1) e
// dalle decisioni della sezione 2 del prompt:
//   TAKE_PROFIT_3R_LIVE = remove            → il core non ha take profit (come il backtest)
//   RISK_TIERS_IN_LIVE = apply_as_backtest  → resolveRiskTier nel core, blocco TRANSITION incluso
//   NORMAL_TIER_PF_SEED = live_history      → profit factor dai NORMAL chiusi dal bot, parte da 1,0
//   EXPECTANCY_MATRIX = empty_like_backtest → matrice vuota: rischio ×0,5 come nel backtest
//   EXIT_FEATURES = per_symbol              → uscite con feature e regime del simbolo
//   DECISION_CADENCE = on_1h_close          → decisioni alla chiusura 1H, NORMAL solo alla 4H
//   STOP_MODEL / BACKSTOP_BUFFER_PCT        → dalla configurazione
// Equity iniziale del bot = CAPITAL_CAP_USD (poi cap + PnL netto del bot).
import type { EngineConfig } from '../config/config';
import type { CoreConfig } from '../core/decisionCore';
import { type DecisionCycleConfig, LIVE_CYCLE_DEFAULTS } from './decisionCycle';

/** Fee taker stimata per PnL flottante e statistiche provvisorie; le fee reali arrivano dai fill. */
export const ESTIMATED_FEE_RATE = 0.0005;

export function coreConfigFromEngine(config: EngineConfig): CoreConfig {
  return {
    symbols: [...config.symbols],
    initialEquity: config.limits.capitalCapUsd,
    feeRate: ESTIMATED_FEE_RATE,
    backstop: { model: config.stopModel, bufferPct: config.backstopBufferPct },
    expectancyMatrix: {},
  };
}

export function liveCycleConfig(config: EngineConfig, startMs: number): DecisionCycleConfig {
  return { core: coreConfigFromEngine(config), startMs, ...LIVE_CYCLE_DEFAULTS };
}
