// Dashboard su dati storici reali in replay (F6): il runtime in shadow gira con un orologio
// simulato sulle candele del dataset versionato, poi il server resta fermo alla fine del periodo.
// Serve a vedere (e fotografare) la dashboard con posizioni, trade, journal e report giornalieri
// quando la rete verso Kraken non c'è. La dashboard mostra il badge "REPLAY" accanto a SHADOW.
//
//   npm run build && npm run dashboard:replay -- --from 2022-01-20 --to 2022-01-23T12:00 --port 3100
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import express from 'express';
import { REALISTIC_PROFILE } from '../../src/engine/backtest/profiles';
import { loadBacktestData } from '../../src/engine/backtest/runner';
import { loadConfig } from '../../src/engine/config/config';
import { BAR_15M_MS } from '../../src/engine/data/dataset';
import { MemoryAlertSink } from '../../src/engine/ops/alerts';
import { CycleContext, Logger } from '../../src/engine/ops/logger';
import { BotStore, WriteBudget } from '../../src/engine/persistence/botStore';
import { MemoryDocumentStore } from '../../src/engine/persistence/documentStore';
import { ReplayCandleSource } from '../../src/engine/replay/replay';
import { BotRuntime } from '../../src/engine/runtime/botRuntime';
import { HeartbeatMonitor } from '../../src/engine/runtime/heartbeat';
import { LeaseManager } from '../../src/engine/runtime/lease';
import { createApp } from '../../src/server/app';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

/** YYYY-MM-DD oppure YYYY-MM-DDTHH:MM, in UTC. */
function parseUtc(text: string): number {
  const ms = Date.parse(text.length === 10 ? `${text}T00:00:00Z` : `${text}:00Z`);
  if (!Number.isFinite(ms)) throw new Error(`Data non valida: ${text}`);
  return ms;
}

const from = parseUtc(arg('--from', '2022-01-20'));
const to = parseUtc(arg('--to', '2022-01-23T12:00'));
const port = Number(arg('--port', '3100'));
const adminToken = process.env.ADMIN_TOKEN ?? randomBytes(24).toString('hex');
const { config } = loadConfig({ TRADING_MODE: 'shadow', ADMIN_TOKEN: adminToken });

const clock = { t: from };
const now = () => clock.t;
const data = loadBacktestData({ symbols: config.symbols, start: new Date(from).toISOString(), end: new Date(to + 2 * 86_400_000).toISOString(), warmupDays: 50, initialEquity: config.limits.capitalCapUsd, execution: REALISTIC_PROFILE.execution, backstop: REALISTIC_PROFILE.backstop, funding: { kind: 'none' } });
const docs = new MemoryDocumentStore();
const budget = new WriteBudget(config.persistence.dailyWriteBudget, now);
const store = new BotStore(docs, budget, now);
const cycle = new CycleContext();
const logger = new Logger({ cycle, now, write: () => undefined });
const alerts = new MemoryAlertSink();
const runtime = new BotRuntime(
  { config, now, store, lease: new LeaseManager(docs, 'replay', { now }), source: new ReplayCandleSource(data, now, () => 20_000), alerts, logger, cycle },
  { startMs: from, dataSourceLabel: `REPLAY ${new Date(from).toISOString().slice(0, 10)} → ${new Date(to).toISOString().slice(0, 16).replace('T', ' ')}` },
);
const heartbeat = new HeartbeatMonitor(from, (level, code, message) => runtime.raiseAlert(level, code, message));

await runtime.ensureRunning();
for (let t = from + BAR_15M_MS + 45_000; t <= to; t += BAR_15M_MS) {
  clock.t = t;
  await runtime.decisionTick(t);
  heartbeat.beatDecision(t);
  for (let p = t + 20_000; p < t + BAR_15M_MS; p += 5 * 60_000) {
    clock.t = p;
    await runtime.protectionTick(p);
    heartbeat.beatProtection(p);
  }
}
await runtime.flushReports();
// L'orologio resta fermo qui: un ultimo ciclo di protezione rinnova il lease.
clock.t = to + 60_000;
await runtime.protectionTick(clock.t);
heartbeat.beatProtection(clock.t);
console.log(`Replay completato: ${runtime.allTrades.length} trade chiusi, ${(await runtime.dailyReports()).length} report giornalieri`);

const app = createApp({
  config,
  engine: {
    status: async () => runtime.statusPayload(),
    start: async () => (await runtime.resume(), runtime.statusPayload()),
    stop: async () => (await runtime.pause(), runtime.statusPayload()),
    reset: async () => (await runtime.reset(), runtime.statusPayload()),
    cronTick: async () => ({ isActive: runtime.statusPayload().isActive === true, ...(await heartbeat.check(now())) }),
    health: async () => runtime.health(await heartbeat.check(now())),
    testAlert: async () => {
      throw new Error('Replay: nessun canale di alert configurato');
    },
    dailyReports: (limit) => runtime.dailyReports(limit),
    dailyReport: (day) => runtime.dailyReport(day),
    killSwitch: (source) => runtime.killSwitch(source),
    resumeRisk: async (confirmation) => ({ operationalState: await runtime.resumeRisk(confirmation) }),
  },
  krakenAdmin: {
    debugAccounts: async () => ({}),
    emergencyCloseAndTransfer: async () => ({ logs: [] }),
  },
  readBacktestReport: () => null,
});
const dist = path.join(process.cwd(), 'dist');
app.use(express.static(dist));
app.get('*all', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
app.listen(port, '127.0.0.1', () => {
  console.log(`Dashboard in replay su http://127.0.0.1:${port} (ADMIN_TOKEN: ${process.env.ADMIN_TOKEN ? 'dall ambiente' : adminToken})`);
});
