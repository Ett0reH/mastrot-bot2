// Audit dei guardrail su un backtest (F5): quante volte i limiti della sezione 2 sarebbero
// scattati. Sul golden backtest il risultato atteso è zero (principio della sezione 2).
import type { RiskLimits } from '../config/config';
import { type BacktestConfig, loadBacktestData, runBacktest } from '../backtest/runner';
import type { Candle } from '../data/dataset';
import type { OpenIntent } from '../core/types';
import { checkEntry, evaluateEquity, type EquityWatch, type GuardCode } from './riskGuard';

export interface GuardAudit {
  entries: number;
  violations: Record<GuardCode, number>;
  examples: { slot: string; symbol: string; code: GuardCode; reason: string }[];
  /** Ingressi che il guardrail avrebbe bloccato (per valutarne l'impatto sui trade del backtest). */
  blocked: { positionId: string; code: GuardCode }[];
  breachDays: string[];
  maxDailyLossPct: number;
  maxDrawdownPct: number;
  dailyLossBreaches: number;
  drawdownBreached: boolean;
  maxLeverage: number;
  maxNotional: number;
  maxOpenPositions: number;
}

export function auditGuardrails(config: BacktestConfig, limits: RiskLimits, data: Record<string, Candle[]> = loadBacktestData(config)): GuardAudit {
  const out: GuardAudit = {
    entries: 0,
    violations: { HALTED: 0, REDUCE_ONLY: 0, DAILY_LOSS: 0, MAX_LEVERAGE: 0, MAX_NOTIONAL: 0, MAX_OPEN_POSITIONS: 0, CAPITAL: 0 },
    examples: [],
    blocked: [],
    breachDays: [],
    maxDailyLossPct: 0,
    maxDrawdownPct: 0,
    dailyLossBreaches: 0,
    drawdownBreached: false,
    maxLeverage: 0,
    maxNotional: 0,
    maxOpenPositions: 0,
  };
  const watch: EquityWatch = { dayStart: null };
  let breachedDay = '';
  let blockUntil: number | null = null;
  runBacktest(
    {
      ...config,
      audit: (slot, result, core) => {
        if (result.equity) {
          const e = evaluateEquity(watch, { trueEquity: result.equity.trueEquity, maxHistoricalEquity: result.equity.maxHistoricalEquity }, slot + 15 * 60_000, limits);
          watch.dayStart = e.dayStart;
          out.maxDailyLossPct = Math.max(out.maxDailyLossPct, e.dailyLossPct);
          out.maxDrawdownPct = Math.max(out.maxDrawdownPct, e.drawdownPct);
          if (e.dailyLossBlockUntil !== null && breachedDay !== e.dayStart.day) {
            breachedDay = e.dayStart.day;
            out.dailyLossBreaches++;
            out.breachDays.push(e.dayStart.day);
            blockUntil = e.dailyLossBlockUntil;
          }
          if (e.drawdownBreached) out.drawdownBreached = true;
        }
        const approved: OpenIntent[] = [];
        const open = core.openPositions().filter((p) => !core.state.pendingCloses[p.id]);
        for (const intent of result.intents) {
          if (intent.kind !== 'OPEN') continue;
          out.entries++;
          out.maxLeverage = Math.max(out.maxLeverage, intent.leverage);
          out.maxNotional = Math.max(out.maxNotional, intent.size * intent.referencePrice);
          out.maxOpenPositions = Math.max(out.maxOpenPositions, open.length + approved.length + 1);
          const verdict = checkEntry(intent, { state: 'RUNNING', dailyLossBlockUntil: blockUntil, openPositions: open, approved, equity: core.state.capital?.trueEquity ?? core.state.realizedEquity, now: slot + 15 * 60_000 }, limits);
          if (verdict.outcome === 'allowed') approved.push(intent);
          else {
            out.violations[verdict.code]++;
            if (out.examples.length < 10) out.examples.push({ slot: new Date(slot).toISOString(), symbol: intent.symbol, code: verdict.code, reason: verdict.reason });
            out.blocked.push({ positionId: intent.positionId, code: verdict.code });
            approved.push(intent); // l'audit non cambia il backtest: si continua come se fosse passato
          }
        }
      },
    },
    data,
  );
  return out;
}
