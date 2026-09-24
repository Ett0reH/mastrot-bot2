// Confronto tra modello legacy e modello di esecuzione realistico (F2 Fase B).
// Esegue tutti gli scenari sulle finestre disponibili e scrive il report in
// docs/phase_reports/F2_backtest_comparison.md.
// Uso: npm run backtest:compare [-- --window 2022H1] [--full]
import { writeFileSync } from 'node:fs';
import { type BacktestProfile, CONSTANT_FUNDING_HOURLY, LEGACY_PROFILE, REALISTIC_PROFILE } from '../../src/engine/backtest/profiles';
import { type Metrics, computeMetrics, fmt, groupBy } from '../../src/engine/backtest/report';
import { type BacktestResult, loadBacktestData, runBacktest } from '../../src/engine/backtest/runner';
import { FULL_REFERENCE_WINDOW, GOLDEN_WINDOWS, type GoldenWindow } from '../golden/windows';
import { assertCompleteDataset } from './fullDataset';

const SCENARIOS: BacktestProfile[] = [
  LEGACY_PROFILE,
  { ...REALISTIC_PROFILE, id: 'backstop', label: 'Solo backstop 3% (0 bps)', execution: { ...REALISTIC_PROFILE.execution, slippageBps: 0 } },
  REALISTIC_PROFILE,
  { ...REALISTIC_PROFILE, id: 'slip10', label: 'Stress: slippage 10 bps', execution: { ...REALISTIC_PROFILE.execution, slippageBps: 10 } },
  { ...REALISTIC_PROFILE, id: 'fee2x', label: 'Stress: fee ×2 (0,10%) + 5 bps', execution: { ...REALISTIC_PROFILE.execution, feeRate: 0.001 } },
  { ...REALISTIC_PROFILE, id: 'funding', label: 'Realistico + funding 0,01%/8h', funding: { kind: 'constant', hourlyRate: CONSTANT_FUNDING_HOURLY } },
  { ...REALISTIC_PROFILE, id: 'intrabar', label: 'Alternativa native_intrabar (5 bps)', backstop: { model: 'native_intrabar', bufferPct: 0 } },
];

interface Row { window: GoldenWindow; profile: BacktestProfile; result: BacktestResult; metrics: Metrics }

function run(window: GoldenWindow, profile: BacktestProfile, data: ReturnType<typeof loadBacktestData>): Row {
  const config = { symbols: window.symbols, start: window.start, end: window.end, warmupDays: 50, initialEquity: 10000, execution: profile.execution, backstop: profile.backstop, funding: profile.funding };
  const result = runBacktest(config, data);
  return { window, profile, result, metrics: computeMetrics(result, 10000, window.start, window.end) };
}

/** Rendimento per anno solare dalla curva di equity (per il gate "anno con perdita > 10%"). */
function yearlyReturns(row: Row): { year: string; returnPct: number }[] {
  const out: { year: string; returnPct: number }[] = [];
  let startEq = 10000;
  let currentYear = '';
  let lastEq = 10000;
  for (const p of row.result.equityCurve) {
    const year = new Date(p.t - 1).toISOString().slice(0, 4);
    if (year !== currentYear) {
      if (currentYear) out.push({ year: currentYear, returnPct: (lastEq / startEq - 1) * 100 });
      currentYear = year;
      startEq = lastEq;
    }
    lastEq = p.equity;
  }
  if (currentYear) out.push({ year: currentYear, returnPct: (lastEq / startEq - 1) * 100 });
  return out;
}

function main(): void {
  const args = process.argv.slice(2);
  const only = args.includes('--window') ? args[args.indexOf('--window') + 1] : undefined;
  const windows = args.includes('--full') ? [FULL_REFERENCE_WINDOW] : GOLDEN_WINDOWS.filter((w) => !only || w.id === only);
  const rows: Row[] = [];
  for (const window of windows) {
    const data = loadBacktestData({ symbols: window.symbols, start: window.start, end: window.end, warmupDays: 50, initialEquity: 10000, execution: LEGACY_PROFILE.execution, backstop: LEGACY_PROFILE.backstop, funding: LEGACY_PROFILE.funding });
    if (args.includes('--full')) assertCompleteDataset(data, Date.parse(window.start) - 50 * 86_400_000, Date.parse(window.end));
    for (const profile of SCENARIOS) {
      const row = run(window, profile, data);
      rows.push(row);
      const m = row.metrics;
      console.log(`${window.id.padEnd(8)} ${profile.label.padEnd(40)} trade ${String(m.trades).padStart(3)}  PnL ${fmt.usd(m.netPnL).padStart(11)}  DD ${m.maxDrawdownPct.toFixed(2)}%  PF ${fmt.pf(m.profitFactor)}  WR ${m.winRatePct.toFixed(1)}%`);
    }
  }

  const lines: string[] = [];
  lines.push('# F2 — Confronto modello legacy vs modello di esecuzione realistico', '');
  lines.push('> Generato da `npm run backtest:compare`. Dati: finestre del golden (dataset parziale, vedi F0).');
  lines.push('> Il confronto out-of-sample 2022-2024 vs 2025-2026 richiede il dataset completo: `npm run data:download`, poi `npm run backtest:compare -- --full`.', '');
  for (const window of windows) {
    lines.push(`## Finestra ${window.id} (${window.start.slice(0, 10)} → ${window.end.slice(0, 10)}, ${window.symbols.join(', ')})`, '');
    lines.push('| Scenario | Trade | PnL netto | Rend. | Max DD | PF | Win rate | Fee | Funding | Sharpe (giorn.) |');
    lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const row of rows.filter((r) => r.window.id === window.id)) {
      const m = row.metrics;
      lines.push(`| ${row.profile.label} | ${m.trades} | ${fmt.usd(m.netPnL)} | ${fmt.pct(m.totalReturnPct)} | ${m.maxDrawdownPct.toFixed(2)}% | ${fmt.pf(m.profitFactor)} | ${m.winRatePct.toFixed(1)}% | ${m.fees.toFixed(2)} $ | ${m.funding.toFixed(2)} $ | ${fmt.num(m.sharpe)} |`);
    }
    lines.push('');
    for (const profileId of ['legacy', 'realistic']) {
      const row = rows.find((r) => r.window.id === window.id && r.profile.id === profileId);
      if (!row) continue;
      lines.push(`**${row.profile.label} — per anno, periodo (2022-2024 vs 2025-2026), motore, simbolo e motivo di uscita**`, '');
      lines.push('| Gruppo | Trade | PnL | PF | Win rate |', '|---|---:|---:|---:|---:|');
      const groups = [
        ...groupBy(row.result.trades, (t) => `anno ${t.exitTime.slice(0, 4)}`),
        ...groupBy(row.result.trades, (t) => `periodo ${t.entryTime < '2025' ? '2022-2024' : '2025-2026'}`),
        ...groupBy(row.result.trades, (t) => `motore ${t.engine}`),
        ...groupBy(row.result.trades, (t) => `simbolo ${t.symbol.split('/')[0]}`),
        ...groupBy(row.result.trades, (t) => `uscita ${t.reason}`),
      ];
      for (const g of groups) {
        lines.push(`| ${g.key} | ${g.trades} | ${fmt.usd(g.netPnL)} | ${fmt.pf(g.profitFactor)} | ${g.winRatePct.toFixed(1)}% |`);
      }
      lines.push('');
    }
    const realistic = rows.find((r) => r.window.id === window.id && r.profile.id === 'realistic');
    if (realistic) {
      const years = yearlyReturns(realistic);
      const m = realistic.metrics;
      const pfFail = m.profitFactor !== null && m.profitFactor < 1.1;
      const ddFail = m.maxDrawdownPct > 20;
      const yearFail = years.some((y) => y.returnPct < -10);
      lines.push(`**Gate F2 sul profilo realistico:** PF ${fmt.pf(m.profitFactor)} ${pfFail ? '❌ (< 1,10)' : '✅'} · max DD ${m.maxDrawdownPct.toFixed(2)}% ${ddFail ? '❌ (> 20%)' : '✅'} · anni solari ${years.map((y) => `${y.year} ${fmt.pct(y.returnPct)}`).join(', ')} ${yearFail ? '❌ (perdita > 10%)' : '✅'}`, '');
    }
  }
  writeFileSync('docs/phase_reports/F2_backtest_comparison.md', lines.join('\n') + '\n');
  console.log('\nReport scritto in docs/phase_reports/F2_backtest_comparison.md');
}

main();
