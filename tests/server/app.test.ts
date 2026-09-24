import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, test } from 'node:test';
import { loadConfig } from '../../src/engine/config/config';
import { createApp, tokensMatch } from '../../src/server/app';

const ADMIN = 'A'.repeat(40);
const CRON = 'C'.repeat(40);

function startApp(env: Record<string, string>, overrides: { failWith?: Error; unhealthy?: boolean } = {}) {
  const { config } = loadConfig(env);
  const calls: string[] = [];
  const act = (name: string) => async () => {
    calls.push(name);
    if (overrides.failWith) throw overrides.failWith;
    return { isActive: true, name };
  };
  const app = createApp({
    config,
    engine: {
      status: act('status'), start: act('start'), stop: act('stop'), reset: act('reset'),
      cronTick: async () => (await act('cron')(), overrides.unhealthy ? { isActive: true, healthy: false, issues: ['ciclo di protezione fermo da 120 s'] } : { isActive: true, healthy: true, issues: [] }),
      health: act('health'),
      testAlert: act('alert-test'),
      dailyReports: async (limit: number) => (await act(`reports:${limit}`)(), [{ day: '2026-09-23' }]),
      dailyReport: async (day: string) => (await act(`report:${day}`)(), day === '2026-09-23' ? { day } : null),
      killSwitch: async (source: string) => (await act(`kill:${source}`)(), { opState: 'HALTED', steps: [] }),
      resumeRisk: async (confirmation: string) => (await act(`resume:${confirmation}`)(), { operationalState: 'RUNNING' }),
    },
    krakenAdmin: { debugAccounts: act('debug'), emergencyCloseAndTransfer: async () => { calls.push('emergency'); return { logs: ['ok'] }; } },
    readBacktestReport: () => ({ tradeCount: 1 }),
    logError: () => {},
  });
  return new Promise<{ server: Server; base: string; calls: string[] }>((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, base: `http://127.0.0.1:${port}`, calls });
    });
  });
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let shadow: Awaited<ReturnType<typeof startApp>>;
let demo: Awaited<ReturnType<typeof startApp>>;
let noAdmin: Awaited<ReturnType<typeof startApp>>;
let failing: Awaited<ReturnType<typeof startApp>>;
let stalled: Awaited<ReturnType<typeof startApp>>;

before(async () => {
  stalled = await startApp({ ADMIN_TOKEN: ADMIN, CRON_TOKEN: CRON }, { unhealthy: true });
  shadow = await startApp({ ADMIN_TOKEN: ADMIN, CRON_TOKEN: CRON });
  demo = await startApp({ TRADING_MODE: 'demo', KRAKEN_DEMO_API_KEY: 'k', KRAKEN_DEMO_API_SECRET: 's', ADMIN_TOKEN: ADMIN });
  noAdmin = await startApp({});
  failing = await startApp({ ADMIN_TOKEN: ADMIN }, { failWith: new Error('boom interno') });
});

after(() => {
  for (const s of [shadow, demo, noAdmin, failing, stalled]) s.server.close();
});

const protectedRoutes: [string, string][] = [
  ['GET', '/api/paper-trading/status'],
  ['POST', '/api/paper-trading/start'],
  ['POST', '/api/paper-trading/stop'],
  ['POST', '/api/paper-trading/reset'],
  ['GET', '/api/debug-kraken'],
  ['POST', '/api/emergency-kraken-transfer'],
  ['POST', '/api/kill-switch'],
  ['POST', '/api/risk/resume'],
  ['GET', '/api/health/details'],
  ['POST', '/api/alerts/test'],
  ['GET', '/api/reports/daily'],
  ['GET', '/api/reports/daily/2026-09-23'],
];

test('le API di controllo senza token rispondono 401 e non toccano il motore', async () => {
  for (const [method, path] of protectedRoutes) {
    const res = await fetch(shadow.base + path, { method });
    assert.equal(res.status, 401, `${method} ${path}`);
    assert.equal((await res.json()).code, 'UNAUTHORIZED');
  }
  assert.deepEqual(shadow.calls, []);
});

test('token sbagliato → 401', async () => {
  const res = await fetch(shadow.base + '/api/paper-trading/start', { method: 'POST', headers: auth('B'.repeat(40)) });
  assert.equal(res.status, 401);
  assert.deepEqual(shadow.calls, []);
});

test('token corretto → il motore viene chiamato', async () => {
  const res = await fetch(shadow.base + '/api/paper-trading/start', { method: 'POST', headers: auth(ADMIN) });
  assert.equal(res.status, 200);
  assert.ok(shadow.calls.includes('start'));
});

test('kill switch e ripresa (F5): solo con token admin; la frase di conferma arriva al motore', async () => {
  const kill = await fetch(shadow.base + '/api/kill-switch', { method: 'POST', headers: auth(ADMIN) });
  assert.equal(kill.status, 200);
  assert.equal((await kill.json()).opState, 'HALTED');
  const resume = await fetch(shadow.base + '/api/risk/resume', { method: 'POST', headers: { ...auth(ADMIN), 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: 'CONFERMO_RIPRESA' }) });
  assert.equal(resume.status, 200);
  const empty = await fetch(shadow.base + '/api/risk/resume', { method: 'POST', headers: auth(ADMIN) });
  assert.equal(empty.status, 200, 'senza corpo la conferma è vuota: decide il motore (che la rifiuta)');
  assert.deepEqual(shadow.calls.filter((c) => c.startsWith('kill') || c.startsWith('resume')), ['kill:api', 'resume:CONFERMO_RIPRESA', 'resume:']);
});

test('senza ADMIN_TOKEN configurato le API di controllo sono disabilitate (503), non aperte', async () => {
  for (const [method, path] of protectedRoutes) {
    const res = await fetch(noAdmin.base + path, { method, headers: auth('whatever-token-value-000000000') });
    assert.equal(res.status, 503, `${method} ${path}`);
  }
  assert.deepEqual(noAdmin.calls, []);
});

test('cron: senza token 401, con token in header o query 200; senza CRON_TOKEN configurato 503', async () => {
  assert.equal((await fetch(shadow.base + '/api/cron/tick')).status, 401);
  assert.equal((await fetch(shadow.base + '/api/cron/tick', { headers: auth(CRON) })).status, 200);
  assert.equal((await fetch(`${shadow.base}/api/cron/tick?token=${CRON}`)).status, 200);
  assert.equal((await fetch(shadow.base + '/api/cron/tick', { headers: auth(ADMIN) })).status, 401);
  assert.equal((await fetch(noAdmin.base + '/api/cron/tick')).status, 503);
});

test('cron: heartbeat mancante → 503 con i problemi (anche il servizio di cron lo vede)', async () => {
  const res = await fetch(stalled.base + '/api/cron/tick', { headers: auth(CRON) });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.healthy, false);
  assert.deepEqual(body.issues, ['ciclo di protezione fermo da 120 s']);
  const ok = await fetch(shadow.base + '/api/cron/tick', { headers: auth(CRON) });
  assert.equal((await ok.json()).healthy, true);
});

test('health dettagliato e alert di prova solo con token admin (F6)', async () => {
  assert.equal((await fetch(shadow.base + '/api/health/details')).status, 401);
  const res = await fetch(shadow.base + '/api/health/details', { headers: auth(ADMIN) });
  assert.equal(res.status, 200);
  assert.equal((await fetch(shadow.base + '/api/alerts/test', { method: 'POST', headers: auth(ADMIN) })).status, 200);
  assert.ok(shadow.calls.includes('health') && shadow.calls.includes('alert-test'));
});

test('report giornalieri (F6): elenco con limite, giorno valido, 404 se manca, 400 se il formato è sbagliato', async () => {
  const list = await fetch(shadow.base + '/api/reports/daily?limit=500', { headers: auth(ADMIN) });
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), [{ day: '2026-09-23' }]);
  assert.ok(shadow.calls.includes('reports:90'), 'limite massimo 90');
  assert.equal((await fetch(shadow.base + '/api/reports/daily/2026-09-23', { headers: auth(ADMIN) })).status, 200);
  assert.equal((await fetch(shadow.base + '/api/reports/daily/2026-09-22', { headers: auth(ADMIN) })).status, 404);
  assert.equal((await fetch(shadow.base + '/api/reports/daily/ieri', { headers: auth(ADMIN) })).status, 400);
});

test('in shadow le operazioni Kraken sono rifiutate (409) anche con token valido', async () => {
  for (const [method, path] of [['GET', '/api/debug-kraken'], ['POST', '/api/emergency-kraken-transfer']] as const) {
    const res = await fetch(shadow.base + path, { method, headers: auth(ADMIN) });
    assert.equal(res.status, 409);
  }
  assert.ok(!shadow.calls.includes('debug') && !shadow.calls.includes('emergency'));
});

test('in demo le operazioni Kraken sono consentite con token valido', async () => {
  const res = await fetch(demo.base + '/api/emergency-kraken-transfer', { method: 'POST', headers: auth(ADMIN) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true, logs: ['ok'] });
});

test('gli errori non espongono lo stack trace', async () => {
  const res = await fetch(failing.base + '/api/paper-trading/status', { headers: auth(ADMIN) });
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.deepEqual(Object.keys(body), ['error']);
  assert.equal(body.error, 'boom interno');
});

test('rotte pubbliche e rimosse', async () => {
  assert.equal((await fetch(shadow.base + '/api/health')).status, 200);
  assert.equal((await fetch(shadow.base + '/api/system/backtest')).status, 200);
  // /api/system/state restituiva dati finti (D31): rimosso.
  for (const path of ['/api/generate', '/api/admin/toggle-degraded', '/api/firebase-status', '/api/data/BTC.json', '/api/system/state']) {
    const res = await fetch(shadow.base + path, { method: path === '/api/generate' ? 'POST' : 'GET' });
    assert.equal(res.status, 404, path);
  }
});

test('tokensMatch confronta in modo esatto', () => {
  assert.equal(tokensMatch(ADMIN, ADMIN), true);
  assert.equal(tokensMatch(ADMIN, ADMIN + 'x'), false);
  assert.equal(tokensMatch('', ADMIN), false);
});
