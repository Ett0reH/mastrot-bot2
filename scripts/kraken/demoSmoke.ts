// Smoke test dell'execution layer su Kraken Futures DEMO (gate F3).
//
//   TRADING_MODE=demo KRAKEN_DEMO_API_KEY=... KRAKEN_DEMO_API_SECRET=... npm run kraken:demo-smoke
//   opzioni: --symbol PF_XBTUSD (default)  --out report.json
//
// Passi: specifiche del contratto → leva isolated 1x (impostata e riletta) → ingresso IOC della
// size minima → stop nativo reduceOnly sul mark price (verificato) → spostamento dello stop con
// editorder (verificato) → uscita a mercato reduceOnly → stop cancellato → confronto tra i record
// del bot e i fill di Kraken → conto flat. Verifica anche le ipotesi non controllabili senza rete
// (stop senza limitPrice = stop-market, processBefore, formato del cliOrdId, cliOrdId nei fill).
// Rifiuta di partire se l'ambiente non è la demo: questo script non tocca MAI un conto reale.
import { writeFileSync } from 'node:fs';
import { loadConfig } from '../../src/engine/config/config';
import { floorToStep, InstrumentRegistry, roundToTick } from '../../src/engine/exchange/instruments';
import { createKrakenFuturesApi } from '../../src/engine/exchange/krakenApi';
import { KrakenAdapter } from '../../src/engine/exchange/krakenAdapter';
import { ensureIsolatedLeverage } from '../../src/engine/exchange/leverage';
import { OrderManager } from '../../src/engine/exchange/orderManager';
import { averagePrice, InMemoryOrderStore } from '../../src/engine/exchange/orders';
import { StopManager } from '../../src/engine/exchange/stopManager';
import { MemoryAlertSink } from '../../src/engine/ops/alerts';

interface Step { step: string; ok: boolean; detail: string; ms: number }

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const { config } = loadConfig(process.env);
  if (config.mode !== 'demo' || config.kraken.tradingEnvironment !== 'demo') {
    console.error(`RIFIUTATO: lo smoke test gira solo in demo (modalità attuale: ${config.mode}, ambiente: ${config.kraken.tradingEnvironment ?? 'nessuno'})`);
    process.exit(2);
  }
  const symbol = arg('--symbol', 'PF_XBTUSD');
  const now = () => Date.now();
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const adapter = new KrakenAdapter(createKrakenFuturesApi(config), { now, sleep, log: (e) => console.log(`[adapter] ${e.level} ${e.message}`) });
  const store = new InMemoryOrderStore();
  const orders = new OrderManager(adapter, store, { now });
  const alerts = new MemoryAlertSink();
  const instruments = new InstrumentRegistry(() => adapter.instruments(), now);
  const stops = new StopManager(orders, adapter, instruments, alerts, { now });
  const steps: Step[] = [];
  const run = async (step: string, fn: () => Promise<string>): Promise<boolean> => {
    const t = now();
    try {
      const detail = await fn();
      steps.push({ step, ok: true, detail, ms: now() - t });
      console.log(`✔ ${step}: ${detail}`);
      return true;
    } catch (err) {
      steps.push({ step, ok: false, detail: (err as Error).message, ms: now() - t });
      console.error(`✖ ${step}: ${(err as Error).message}`);
      return false;
    }
  };
  const intentKey = `smoke-${new Date().toISOString()}`;
  const startedAt = new Date(now() - 5_000).toISOString();
  let size = 0;
  let mark = 0;

  const ok =
    (await run('conto flat all avvio', async () => {
      const positions = await adapter.openPositions();
      if (positions.some((p) => p.symbol === symbol)) throw new Error(`posizione già aperta su ${symbol}: chiudila prima`);
      return `${positions.length} posizioni su altri contratti`;
    })) &&
    (await run('specifiche del contratto', async () => {
      const spec = await instruments.get(symbol);
      size = floorToStep(spec.sizeStep, spec);
      const ticker = (await adapter.tickers()).find((t) => t.symbol === symbol);
      if (!ticker) throw new Error('ticker mancante');
      mark = ticker.markPrice;
      return `tick ${spec.tickSize}, passo ${spec.sizeStep}, max ${spec.maxPositionSize}, mark ${mark}, size di prova ${size}`;
    })) &&
    (await run('leva isolated 1x impostata e riletta', async () => {
      const r = await ensureIsolatedLeverage(adapter, symbol, 1);
      if (r.outcome === 'failed') throw new Error(r.reason);
      return `leva ${r.leverage}x (${r.changed ? 'impostata' : 'già presente'})`;
    })) &&
    (await run('ingresso IOC con cliOrdId e processBefore', async () => {
      const spec = await instruments.get(symbol);
      const record = await orders.submit({ intentKey, purpose: 'ENTRY', symbol, side: 'buy', orderType: 'ioc', size, limitPrice: roundToTick(mark * 1.01, spec.tickSize, 'up'), reduceOnly: false });
      if (record.state !== 'FILLED') throw new Error(`stato ${record.state} (${record.lastError})`);
      return `${record.cliOrdId} eseguito ${record.filledSize} a ${averagePrice(record.fills)}`;
    })) &&
    (await run('stop nativo stp reduceOnly su mark price', async () => {
      const r = await stops.ensure({ positionId: intentKey, symbol, direction: 'LONG', size, level: mark * 0.9 });
      if (r.status !== 'PROTECTED') throw new Error(`${r.status}: ${'reason' in r ? r.reason : ''}`);
      return `stop ${r.stop.cliOrdId} a ${r.stop.stopPrice}`;
    })) &&
    (await run('spostamento dello stop con editorder e verifica', async () => {
      const r = await stops.ensure({ positionId: intentKey, symbol, direction: 'LONG', size, level: mark * 0.92 });
      if (r.status !== 'PROTECTED' || r.stale) throw new Error(`${r.status}`);
      return `stop a ${r.stop.stopPrice}`;
    }));

  await run('uscita a mercato reduceOnly', async () => {
    const positions = await adapter.openPositions('protective');
    const pos = positions.find((p) => p.symbol === symbol);
    if (!pos) return 'nessuna posizione da chiudere';
    const record = await orders.submit({ intentKey, purpose: 'EXIT', symbol, side: pos.side === 'long' ? 'sell' : 'buy', orderType: 'mkt', size: pos.size, reduceOnly: true }, 1, 'protective');
    if (record.state !== 'FILLED') throw new Error(`stato ${record.state} (${record.lastError})`);
    return `${record.cliOrdId} eseguito ${record.filledSize} a ${averagePrice(record.fills)}`;
  });
  await run('stop cancellato dopo la chiusura', async () => {
    await stops.remove(intentKey);
    const left = (await adapter.openOrders('protective')).filter((o) => o.symbol === symbol && o.reduceOnly);
    if (left.length) throw new Error(`${left.length} ordini residui`);
    return 'nessun ordine residuo';
  });
  await run('ledger del bot = fill di Kraken', async () => {
    const fills = await orders.fillsSince(startedAt);
    const records = await store.byIntent(intentKey);
    const problems: string[] = [];
    for (const r of records.filter((x) => x.filledSize > 0)) {
      const own = fills.filter((f) => f.cliOrdId === r.cliOrdId || f.order_id === r.exchangeOrderId);
      if (own.length === 0) problems.push(`${r.cliOrdId}: nessun fill con questo cliOrdId/order_id (ipotesi "cliOrdId nei fill" da rivedere)`);
      const size = own.reduce((a, f) => a + f.size, 0);
      if (Math.abs(size - r.filledSize) > 1e-12) problems.push(`${r.cliOrdId}: size bot ${r.filledSize} ≠ Kraken ${size}`);
    }
    if (problems.length) throw new Error(problems.join('; '));
    return `${records.length} ordini, ${fills.length} fill verificati`;
  });
  await run('conto flat alla fine', async () => {
    const pos = (await adapter.openPositions('protective')).find((p) => p.symbol === symbol);
    if (pos) throw new Error(`posizione residua ${pos.side} ${pos.size}: CHIUDERLA A MANO`);
    return 'flat';
  });

  const out = arg('--out', '');
  const report = { symbol, at: new Date().toISOString(), ok: ok && steps.every((s) => s.ok), steps, orders: await store.byIntent(intentKey), alerts: alerts.alerts };
  if (out) writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(report.ok ? '\nSMOKE TEST DEMO: PASS' : '\nSMOKE TEST DEMO: FAIL');
  process.exit(report.ok ? 0 : 1);
}

await main();
