// Criteri misurabili del go-live (GO_LIVE_CHECKLIST.md, F8) dai report giornalieri del bot in demo.
//
//   ADMIN_TOKEN=... npm run golive:check -- --url https://<bot-demo> [--days 14] [--to YYYY-MM-DD] [--out golive.md]
//
// Legge GET /api/reports/daily dal bot demo e valuta gli ultimi N giorni UTC completi (fino a ieri,
// o fino a --to): giorni consecutivi in demo, zero posizioni senza stop, zero desync, parità col
// backtest, slippage entro il modello. Esce con 0 se tutti i criteri sono superati, 1 altrimenti,
// 2 se i report non si possono leggere. Gli altri punti della checklist si verificano a mano.
import { writeFileSync } from 'node:fs';
import type { DailyReport } from '../../src/engine/ops/dailyReport';
import { evaluateGoLive, formatGoLive, GO_LIVE_MIN_DAYS } from '../../src/engine/ops/goLive';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const url = arg('--url', process.env.BOT_URL ?? 'http://localhost:3000').replace(/\/$/, '');
  const days = Math.max(1, Number(arg('--days', String(GO_LIVE_MIN_DAYS))));
  const token = process.env.ADMIN_TOKEN;
  if (!token) {
    console.error('ADMIN_TOKEN mancante: serve per leggere i report dal bot');
    process.exit(2);
  }
  const to = arg('--to', new Date(Date.now() - 86_400_000).toISOString().slice(0, 10));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    console.error(`--to non valido: ${to} (usare YYYY-MM-DD)`);
    process.exit(2);
  }
  const res = await fetch(`${url}/api/reports/daily?limit=90`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    console.error(`Report non letti (HTTP ${res.status}): ${await res.text()}`);
    process.exit(2);
  }
  const reports = (await res.json()) as DailyReport[];
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  // Il minimo di 14 giorni vale sempre: con --days più corto il controllo mostra gli altri criteri
  // ma non può essere superato.
  const evaluation = evaluateGoLive(reports, from, to, GO_LIVE_MIN_DAYS);
  const text = formatGoLive(evaluation);
  console.log(text);
  const out = arg('--out', '');
  if (out) writeFileSync(out, `${text}\n`);
  process.exit(evaluation.ok ? 0 : 1);
}

await main();
