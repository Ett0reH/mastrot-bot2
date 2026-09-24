// Effetto delle correzioni D07 e D08 sul backtest (F2 Fase B, "metriche prima e dopo").
//
// D07 — il backtest legacy aggrega 1H/4H con getHours() nel fuso del processo. Si confronta il
//       backtest legacy con TZ=Europe/Rome (un PC o server in Italia) e con TZ=UTC (golden).
// D08 — il backtest legacy avanza per indice di array: dopo un buco nei dati i simboli si
//       disallineano. Su 13 mesi sintetici CON buchi si confronta il legacy con il nuovo motore
//       (loop per timestamp, stesso modello di esecuzione legacy). Controllo: sugli stessi 13 mesi
//       SENZA buchi i due backtest devono essere identici (parità estesa oltre i dati reali).
//
// Uso: npm run backtest:fixes   (scrive docs/phase_reports/F2_d07_d08.md)
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LEGACY_PROFILE } from '../../src/engine/backtest/profiles';
import { fmt, profitFactor } from '../../src/engine/backtest/report';
import { legacyView, runBacktest } from '../../src/engine/backtest/runner';
import type { TradeRecord } from '../../src/engine/core/types';
import { writeSymbolCandles } from '../../src/engine/data/dataset';
import { generateSyntheticMarket, SYNTHETIC_PARITY_WINDOW } from '../../src/engine/sim/syntheticMarket';
import { canonicalHash } from '../../src/engine/util/canonical';
import { runLegacyBacktest } from '../golden/legacyRunner';
import { GOLDEN_WINDOWS, type GoldenWindow } from '../golden/windows';

interface Row { label: string; trades: number; netPnL: number; pf: number | null; hash: string }

function legacyRow(label: string, window: GoldenWindow, options: { tz?: string; datasetRoot?: string }): Row {
  const r = runLegacyBacktest(window, options);
  const trades = r.trades as unknown as TradeRecord[];
  return { label, trades: r.tradeCount, netPnL: r.netPnL, pf: profitFactor(trades), hash: r.tradesSha256 };
}

function engineRow(label: string, window: GoldenWindow, data: Parameters<typeof runBacktest>[1]): Row {
  const r = runBacktest({ symbols: window.symbols, start: window.start, end: window.end, warmupDays: 50, initialEquity: 10000, execution: LEGACY_PROFILE.execution, backstop: LEGACY_PROFILE.backstop, funding: LEGACY_PROFILE.funding }, data);
  return { label, trades: r.trades.length, netPnL: r.finalEquity - 10000, pf: profitFactor(r.trades), hash: canonicalHash(r.trades.map(legacyView)) };
}

function table(rows: Row[]): string[] {
  const base = rows[0].hash;
  return [
    '| Backtest | Trade | PnL netto | PF | Trade identici al primo |',
    '|---|---:|---:|---:|:---:|',
    ...rows.map((r) => `| ${r.label} | ${r.trades} | ${fmt.usd(r.netPnL)} | ${fmt.pf(r.pf)} | ${r.hash === base ? 'sì' : 'no'} |`),
  ];
}

function main(): void {
  const lines: string[] = ['# F2 — Effetto delle correzioni D07 (fuso orario) e D08 (loop per timestamp)', '', '> Generato da `npm run backtest:fixes`.', ''];

  lines.push('## D07 — aggregazione nel fuso locale', '');
  for (const window of GOLDEN_WINDOWS) {
    const rows = [legacyRow('Legacy, TZ=UTC (golden)', window, { tz: 'UTC' }), legacyRow('Legacy, TZ=Europe/Rome', window, { tz: 'Europe/Rome' })];
    lines.push(`**${window.id}**`, '', ...table(rows), '');
    console.log(`D07 ${window.id}: UTC ${rows[0].trades} trade ${fmt.usd(rows[0].netPnL)} | Europe/Rome ${rows[1].trades} trade ${fmt.usd(rows[1].netPnL)}`);
  }
  lines.push('Il nuovo motore aggrega sempre in UTC (test `aggregator.test.ts`: risultato indipendente da `TZ`).', '');

  lines.push('## D08 — loop per indice con buchi nei dati', '');
  const w = SYNTHETIC_PARITY_WINDOW;
  const window: GoldenWindow = { id: w.id, start: w.start, end: w.end, symbols: [...w.symbols], note: 'mercato sintetico' };
  const fromMs = Date.parse(w.start) - w.warmupDays * 24 * 3_600_000;
  for (const [label, gapSymbols] of [['senza buchi', []], ['con buchi su XRP e DOGE', ['XRP', 'DOGE']]] as const) {
    const data = generateSyntheticMarket({ seed: w.seed, fromMs, toMs: Date.parse(w.end) + 15 * 60_000, gapSymbols: [...gapSymbols] });
    const root = mkdtempSync(join(tmpdir(), 'synthetic-dataset-'));
    try {
      for (const s of window.symbols) writeSymbolCandles(root, s, data[s], 'synthetic');
      const rows = [legacyRow('Legacy (loop per indice)', window, { datasetRoot: root }), engineRow('Nuovo motore, modello legacy (loop per timestamp)', window, data)];
      lines.push(`**13 mesi sintetici ${label}**`, '', ...table(rows), '');
      console.log(`D08 ${label}: legacy ${rows[0].trades} trade ${fmt.usd(rows[0].netPnL)} | nuovo ${rows[1].trades} trade ${fmt.usd(rows[1].netPnL)} | identici: ${rows[0].hash === rows[1].hash}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  writeFileSync('docs/phase_reports/F2_d07_d08.md', lines.join('\n') + '\n');
  console.log('Report scritto in docs/phase_reports/F2_d07_d08.md');
}

main();
