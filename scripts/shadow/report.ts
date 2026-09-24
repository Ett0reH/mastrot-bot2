// Report di un periodo di shadow (o demo) dai report giornalieri del bot (gate F7).
//
//   ADMIN_TOKEN=... npm run shadow:report -- --url https://<bot> --days 3 [--out shadow.md]
//
// Legge GET /api/reports/daily dal bot in esecuzione e valuta gli ultimi N giorni completi (fino a
// ieri, UTC): ogni giorno deve avere il report con il confronto col backtest calcolato e senza
// divergenze non spiegate. Esce con codice 0 se il periodo è superato, 1 altrimenti.
import { writeFileSync } from 'node:fs';
import type { DailyReport } from '../../src/engine/ops/dailyReport';
import { evaluateShadowRun, formatShadowRun } from '../../src/engine/ops/shadowRun';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const url = arg('--url', process.env.BOT_URL ?? 'http://localhost:3000').replace(/\/$/, '');
  const days = Math.max(1, Number(arg('--days', '3')));
  const token = process.env.ADMIN_TOKEN;
  if (!token) {
    console.error('ADMIN_TOKEN mancante: serve per leggere i report dal bot');
    process.exit(2);
  }
  const res = await fetch(`${url}/api/reports/daily?limit=90`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    console.error(`Report non letti (HTTP ${res.status}): ${await res.text()}`);
    process.exit(2);
  }
  const reports = (await res.json()) as DailyReport[];
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const from = new Date(Date.parse(`${yesterday}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const evaluation = evaluateShadowRun(reports, from, yesterday);
  const text = formatShadowRun(evaluation);
  console.log(text);
  const out = arg('--out', '');
  if (out) writeFileSync(out, `${text}\n`);
  process.exit(evaluation.ok ? 0 : 1);
}

await main();
