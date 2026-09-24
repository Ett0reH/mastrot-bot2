// Audit dei guardrail sul golden backtest (F5).
//
//   npm run risk:audit                 limiti dall'ambiente (default della sezione 2)
//   npm run risk:audit -- --out f.json salva anche il risultato
//
// Principio della sezione 2: i guardrail non devono mai scattare nel golden. Il backtest gira con
// equity iniziale = CAPITAL_CAP_USD, come il bot in live; l'audit osserva ogni slot senza cambiare
// nulla e conta quante volte ogni limite sarebbe scattato e quali ingressi avrebbe bloccato.
import { writeFileSync } from 'node:fs';
import { REALISTIC_PROFILE } from '../../src/engine/backtest/profiles';
import { loadConfig } from '../../src/engine/config/config';
import { auditGuardrails } from '../../src/engine/risk/guardAudit';
import { SYNTHETIC_PARITY_WINDOW, syntheticParityData } from '../../src/engine/sim/syntheticMarket';
import { GOLDEN_WINDOWS } from '../golden/windows';

const { config } = loadConfig(process.env);
const limits = config.limits;
const base = { warmupDays: 50, initialEquity: limits.capitalCapUsd, execution: REALISTIC_PROFILE.execution, backstop: REALISTIC_PROFILE.backstop, funding: { kind: 'none' as const } };

const results = GOLDEN_WINDOWS.map((w) => ({ id: w.id, golden: true, audit: auditGuardrails({ ...base, symbols: w.symbols, start: w.start, end: w.end }, limits) }));
const s = SYNTHETIC_PARITY_WINDOW;
results.push({ id: `SINTETICO (seed ${s.seed})`, golden: false, audit: auditGuardrails({ ...base, symbols: [...s.symbols], start: s.start, end: s.end }, limits, syntheticParityData()) });

console.log('Limiti:', JSON.stringify(limits));
for (const { id, golden, audit: a } of results) {
  const violations = Object.entries(a.violations).filter(([, n]) => n > 0).map(([c, n]) => `${c}=${n}`).join(' ') || 'nessuna';
  console.log(`\n${id}${golden ? ' (golden)' : ' (non golden: mercato sintetico)'}`);
  console.log(`  ingressi ${a.entries}; ingressi respinti: ${violations}`);
  console.log(`  leva max ${a.maxLeverage}x, nozionale max ${a.maxNotional.toFixed(2)} $, posizioni aperte max ${a.maxOpenPositions}`);
  console.log(`  perdita giornaliera max ${a.maxDailyLossPct.toFixed(2)}% (limite ${limits.maxDailyLossPct}%), superamenti ${a.dailyLossBreaches}${a.breachDays.length ? ` il ${a.breachDays.join(', ')}` : ''}`);
  console.log(`  drawdown max ${a.maxDrawdownPct.toFixed(2)}% (soglia REDUCE_ONLY ${limits.drawdownReduceOnlyPct}%)${a.drawdownBreached ? ' → SUPERATA' : ''}`);
}
const golden = results.filter((r) => r.golden).map((r) => r.audit);
const fired = golden.some((a) => a.blocked.length > 0 || a.dailyLossBreaches > 0 || a.drawdownBreached);
console.log(`\nEsito sul golden: ${fired ? 'i guardrail SCATTANO: vanno riportati (troppo stretti o da modellare nel backtest)' : 'nessun guardrail scatta'}`);
const i = process.argv.indexOf('--out');
if (i >= 0) writeFileSync(process.argv[i + 1], JSON.stringify({ limits, results }, null, 2));
