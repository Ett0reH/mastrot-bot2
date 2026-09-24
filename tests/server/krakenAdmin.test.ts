// Chiusura d'emergenza tramite l'adapter unico (F3: D18, D33) su Kraken simulato.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../../src/engine/config/config';
import { FAKE_INSTRUMENTS, FakeKrakenFutures } from '../../src/engine/sim/fakeKraken';
import { createKrakenAdmin, transferableBalances } from '../../src/server/krakenAdmin';

const demo = loadConfig({ TRADING_MODE: 'demo', KRAKEN_DEMO_API_KEY: 'demo-key', KRAKEN_DEMO_API_SECRET: 'demo-secret' }).config;

function env() {
  const clock = { t: Date.UTC(2026, 8, 24, 12) };
  const now = () => clock.t;
  const sleep = async (ms: number) => {
    clock.t += ms;
  };
  const fake = new FakeKrakenFutures({ now, instruments: FAKE_INSTRUMENTS, marks: { PF_XBTUSD: 60_000, PF_ETHUSD: 3_000 } });
  fake.externalOpen('PF_XBTUSD', 'buy', 0.02);
  fake.externalOpen('PF_ETHUSD', 'sell', 1);
  return { clock, fake, admin: createKrakenAdmin(demo, { api: fake, now, sleep }) };
}

test('emergenza: ordini cancellati, posizioni chiuse reduceOnly con cliOrdId, conto flat, poi trasferimento', async () => {
  const { fake, admin } = env();
  await fake.submitOrder({ orderType: 'stp', symbol: 'PF_XBTUSD', side: 'sell', size: 0.02, stopPrice: 55_000, reduceOnly: true, cliOrdId: 'manual-stop' });
  const { logs } = await admin.emergencyCloseAndTransfer();
  assert.equal(fake.positions.size, 0);
  assert.equal([...fake.orders.values()].filter((o) => o.status === 'open').length, 0);
  const closes = fake.calls.filter((c) => c.method === 'submitOrder').map((c) => c.params as Record<string, unknown>).filter((p) => p.orderType === 'mkt');
  assert.equal(closes.length, 2);
  for (const c of closes) {
    assert.equal(c.reduceOnly, true);
    assert.match(String(c.cliOrdId), /^mt-k-/);
  }
  assert.deepEqual(fake.transfers, [{ fromAccount: 'flex', toAccount: 'cash', unit: 'USD', amount: 10_000 }]);
  assert.ok(logs.includes('Conto flat verificato.'));
});

test('emergenza: se il conto non risulta flat, nessun trasferimento', async () => {
  const { fake, admin } = env();
  fake.failNext('submitOrder', { kind: 'network' }, 10);
  const { logs } = await admin.emergencyCloseAndTransfer();
  assert.equal(fake.transfers.length, 0);
  assert.ok(logs.some((l) => /NON è flat/.test(l)));
});

test('in shadow le operazioni Kraken sono rifiutate', async () => {
  const shadow = createKrakenAdmin(loadConfig({}).config);
  await assert.rejects(() => shadow.emergencyCloseAndTransfer(), /shadow/);
  await assert.rejects(() => shadow.debugAccounts(), /shadow/);
});

test('saldi trasferibili: conto flex e conti margin, niente dal wallet cash', () => {
  const out = transferableBalances({
    cash: { type: 'cashAccount', balances: { usd: '5' } },
    fi_xbtusd: { type: 'marginAccount', currency: 'xbt', balances: { xbt: '0.5' }, auxiliary: { usd: 0, pv: 0, pnl: 0, af: 0, funding: 0 }, marginRequirements: { im: 0, mm: 0, lt: 0, tt: 0 }, triggerEstimates: { im: 0, mm: 0, lt: 0, tt: 0 } },
  });
  assert.deepEqual(out, [{ fromAccount: 'fi_xbtusd', unit: 'xbt', amount: 0.5 }]);
});
