// RiskGuard (F5): ultimo controllo prima di ogni ordine che AUMENTA l'esposizione (gli ingressi).
// Uscite, stop e chiusure d'emergenza riducono il rischio e non passano di qui: sono reduceOnly
// per costruzione (execution layer, F3).
//
// Limiti della sezione 2 del prompt (config.limits): leva massima, nozionale massimo per
// posizione, numero massimo di posizioni, margine totale entro l'equity del bot (cap + PnL),
// perdita giornaliera (blocco fino al giorno UTC successivo), drawdown oltre soglia (REDUCE_ONLY,
// finché una persona non riprende). Principio: nel golden backtest non devono mai scattare.
import type { RiskLimits } from '../config/config';
import type { CorePosition, OpenIntent } from '../core/types';
import { exchangeLeverage } from '../exchange/leverage';

/** Stato operativo: RUNNING normale; REDUCE_ONLY solo uscite; HALTING kill switch in corso; HALTED fermo. */
export type OperationalState = 'RUNNING' | 'REDUCE_ONLY' | 'HALTING' | 'HALTED';

export type GuardCode = 'HALTED' | 'REDUCE_ONLY' | 'DAILY_LOSS' | 'MAX_LEVERAGE' | 'MAX_NOTIONAL' | 'MAX_OPEN_POSITIONS' | 'CAPITAL';

// Discriminante stringa: la config legacy (strict disattivato) non restringe le union su booleani.
export type GuardResult = { outcome: 'allowed' } | { outcome: 'denied'; code: GuardCode; reason: string };

export interface GuardContext {
  state: OperationalState;
  /** Ingressi bloccati per la perdita giornaliera fino a questo istante (null = nessun blocco). */
  dailyLossBlockUntil: number | null;
  openPositions: readonly CorePosition[];
  /** Ingressi già approvati nello stesso ciclo (contano per posizioni e margine). */
  approved: readonly OpenIntent[];
  /** Equity del bot (CAPITAL_CAP_USD + PnL), limitata dal collateral del conto quando è noto. */
  equity: number;
  now: number;
}

const margin = (size: number, price: number, leverage: number) => (size * price) / leverage;

export function checkEntry(intent: OpenIntent, ctx: GuardContext, limits: RiskLimits): GuardResult {
  const deny = (code: GuardCode, reason: string): GuardResult => ({ outcome: 'denied', code, reason });
  if (ctx.state === 'HALTED' || ctx.state === 'HALTING') return deny('HALTED', 'bot fermato (kill switch)');
  if (ctx.state === 'REDUCE_ONLY') return deny('REDUCE_ONLY', 'modalità REDUCE_ONLY: solo uscite');
  if (ctx.dailyLossBlockUntil !== null && ctx.now < ctx.dailyLossBlockUntil) {
    return deny('DAILY_LOSS', `perdita giornaliera oltre ${limits.maxDailyLossPct}%: ingressi bloccati fino a ${new Date(ctx.dailyLossBlockUntil).toISOString()}`);
  }
  // Valori non finiti renderebbero falsi tutti i confronti (NaN > x): si rifiuta esplicitamente.
  if (!Number.isFinite(intent.leverage) || intent.leverage <= 0) return deny('MAX_LEVERAGE', `leva non valida: ${intent.leverage}`);
  // Conta la leva impostata su Kraken (isolated, intero superiore a quella della strategia).
  const leverage = exchangeLeverage(intent.leverage);
  if (leverage > limits.maxLeverage + 1e-9) return deny('MAX_LEVERAGE', `leva ${intent.leverage}x (${leverage}x isolated su Kraken) oltre il massimo ${limits.maxLeverage}x`);
  const notional = intent.size * intent.referencePrice;
  if (!Number.isFinite(notional) || notional <= 0) return deny('MAX_NOTIONAL', `nozionale non valido: ${intent.size} × ${intent.referencePrice}`);
  if (notional > limits.maxPositionNotionalUsd + 1e-9) return deny('MAX_NOTIONAL', `nozionale ${notional.toFixed(2)} $ oltre il massimo ${limits.maxPositionNotionalUsd} $`);
  const positions = ctx.openPositions.length + ctx.approved.length + 1;
  if (positions > limits.maxOpenPositions) return deny('MAX_OPEN_POSITIONS', `${positions} posizioni oltre il massimo ${limits.maxOpenPositions}`);
  const used =
    ctx.openPositions.reduce((a, p) => a + margin(p.trade.size, p.trade.entryPrice, p.trade.leverage), 0) +
    ctx.approved.reduce((a, o) => a + margin(o.size, o.referencePrice, o.leverage), 0);
  const total = used + margin(intent.size, intent.referencePrice, intent.leverage);
  if (!(total <= ctx.equity + 1e-9)) return deny('CAPITAL', `margine totale ${total.toFixed(2)} $ oltre l'equity del bot ${ctx.equity.toFixed(2)} $`);
  return { outcome: 'allowed' };
}

export interface EquityWatch {
  /** Equity alla prima osservazione del giorno UTC corrente. */
  dayStart: { day: string; equity: number } | null;
}

export interface EquityEvaluation {
  dayStart: { day: string; equity: number };
  dailyLossPct: number;
  drawdownPct: number;
  /** Se la perdita giornaliera supera il limite: blocco fino alla mezzanotte UTC successiva. */
  dailyLossBlockUntil: number | null;
  drawdownBreached: boolean;
}

export function evaluateEquity(watch: EquityWatch, equity: { trueEquity: number; maxHistoricalEquity: number }, now: number, limits: RiskLimits): EquityEvaluation {
  const day = new Date(now).toISOString().slice(0, 10);
  const dayStart = watch.dayStart && watch.dayStart.day === day ? watch.dayStart : { day, equity: equity.trueEquity };
  const dailyLossPct = dayStart.equity > 0 ? ((dayStart.equity - equity.trueEquity) / dayStart.equity) * 100 : 0;
  const drawdownPct = equity.maxHistoricalEquity > 0 ? ((equity.maxHistoricalEquity - equity.trueEquity) / equity.maxHistoricalEquity) * 100 : 0;
  const nextMidnight = Date.parse(`${day}T00:00:00Z`) + 86_400_000;
  return {
    dayStart,
    dailyLossPct,
    drawdownPct,
    dailyLossBlockUntil: dailyLossPct >= limits.maxDailyLossPct ? nextMidnight : null,
    drawdownBreached: drawdownPct >= limits.drawdownReduceOnlyPct,
  };
}
