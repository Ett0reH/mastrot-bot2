// Backtest del nuovo motore (DecisionCore + exchange simulato).
//
//   npm run backtest                          → profilo realistico sulle finestre del golden
//   npm run backtest -- --profile legacy      → modello di esecuzione legacy (= golden legacy)
//   npm run backtest -- --window 2022H1       → una sola finestra
//   npm run backtest -- --full                → 2022-01-01 → 2026-05-09 (richiede npm run data:download)
//   npm run backtest -- --funding constant    → funding 0,01%/8h (in attesa dello storico reale)
//   npm run backtest -- --out report.json     → salva trade e metriche
import { writeFileSync } from 'node:fs';
import { CONSTANT_FUNDING_HOURLY, LEGACY_PROFILE, REALISTIC_PROFILE } from '../../src/engine/backtest/profiles';
import { computeMetrics, fmt, groupBy } from '../../src/engine/backtest/report';
import { loadBacktestData, runBacktest } from '../../src/engine/backtest/runner';
import { canonicalStringify } from '../../src/engine/util/canonical';
import { FULL_REFERENCE_WINDOW, GOLDEN_WINDOWS } from '../golden/windows';
import { assertCompleteDataset } from './fullDataset';

function arg(name: string): string | undefined {
  const args = process.argv.slice(2);
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function main(): void {
  const args = process.argv.slice(2);
  const profileId = arg('--profile') ?? 'realistic';
  const base = { legacy: LEGACY_PROFILE, realistic: REALISTIC_PROFILE }[profileId];
  if (!base) throw new Error(`Profilo sconosciuto: ${profileId} (legacy | realistic)`);
  const fundingArg = arg('--funding') ?? 'none';
  if (!['none', 'constant'].includes(fundingArg)) throw new Error(`Funding sconosciuto: ${fundingArg} (none | constant)`);
  const funding = fundingArg === 'constant' ? { kind: 'constant' as const, hourlyRate: CONSTANT_FUNDING_HOURLY } : base.funding;
  const only = arg('--window');
  const windows = args.includes('--full') ? [FULL_REFERENCE_WINDOW] : GOLDEN_WINDOWS.filter((w) => !only || w.id === only);
  if (windows.length === 0) throw new Error(`Finestra sconosciuta: ${only}`);
  const out: Record<string, unknown> = {};
  for (const w of windows) {
    const config = { symbols: w.symbols, start: w.start, end: w.end, warmupDays: 50, initialEquity: 10000, execution: base.execution, backstop: base.backstop, funding };
    const data = loadBacktestData(config);
    if (args.includes('--full')) assertCompleteDataset(data, Date.parse(w.start) - 50 * 86_400_000, Date.parse(w.end));
    const result = runBacktest(config, data);
    const m = computeMetrics(result, 10000, w.start, w.end);
    console.log(`${w.id} [${base.label}${fundingArg === 'constant' ? ' + funding' : ''}]`);
    console.log(`  trade ${m.trades} · PnL ${fmt.usd(m.netPnL)} (${fmt.pct(m.totalReturnPct)}) · max DD ${m.maxDrawdownPct.toFixed(2)}% · PF ${fmt.pf(m.profitFactor)} · win rate ${m.winRatePct.toFixed(1)}% · Sharpe ${fmt.num(m.sharpe)}`);
    for (const g of groupBy(result.trades, (t) => t.engine)) console.log(`  ${g.key.padEnd(8)} ${String(g.trades).padStart(4)} trade · PnL ${fmt.usd(g.netPnL)} · PF ${fmt.pf(g.profitFactor)}`);
    out[w.id] = { profile: base.id, funding: fundingArg, metrics: m, trades: result.trades };
  }
  const file = arg('--out');
  if (file) {
    writeFileSync(file, canonicalStringify(out, 2) + '\n');
    console.log(`Report scritto in ${file}`);
  }
}

main();
