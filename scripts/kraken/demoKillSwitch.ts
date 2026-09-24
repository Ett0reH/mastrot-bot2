// Prova del kill switch su Kraken Futures DEMO (gate F5).
//
//   TRADING_MODE=demo KRAKEN_DEMO_API_KEY=... KRAKEN_DEMO_API_SECRET=... npm run kraken:demo-kill -- --yes
//   opzioni: --symbols PF_XBTUSD,PF_ETHUSD (default)  --out report.json
//
// Prepara il conto demo come lo troverebbe il kill switch durante l'operatività: una posizione
// della size minima per simbolo (leva isolated 1x) con il suo stop nativo reduceOnly, più un ordine
// limite non protettivo lontano dal mercato. Poi esegue la procedura del bot (la stessa usata dal
// runtime) finché il conto non risulta flat, e verifica: ordini non protettivi cancellati, posizioni
// chiuse reduceOnly con cliOrdId `mt-k-…`, conto flat, nessun ordine residuo.
// ATTENZIONE: chiude TUTTE le posizioni del conto demo. Senza `--yes` non parte.
// Rifiuta di partire se l'ambiente non è la demo: questo script non tocca MAI un conto reale.
import { writeFileSync } from 'node:fs';
import { loadConfig } from '../../src/engine/config/config';
import { floorToStep, InstrumentRegistry, roundToTick } from '../../src/engine/exchange/instruments';
import { createKrakenFuturesApi } from '../../src/engine/exchange/krakenApi';
import { KrakenAdapter } from '../../src/engine/exchange/krakenAdapter';
import { FundingFromLedgerPending, KrakenExecutionPort } from '../../src/engine/exchange/krakenExecutionPort';
import { ensureIsolatedLeverage } from '../../src/engine/exchange/leverage';
import { OrderManager } from '../../src/engine/exchange/orderManager';
import { InMemoryOrderStore } from '../../src/engine/exchange/orders';
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
    console.error(`RIFIUTATO: la prova del kill switch gira solo in demo (modalità attuale: ${config.mode}, ambiente: ${config.kraken.tradingEnvironment ?? 'nessuno'})`);
    process.exit(2);
  }
  if (!process.argv.includes('--yes')) {
    console.error('La prova chiude TUTTE le posizioni del conto DEMO e cancella tutti gli ordini. Rilanciare con --yes per confermare.');
    process.exit(2);
  }
  const symbols = arg('--symbols', 'PF_XBTUSD,PF_ETHUSD').split(',').map((s) => s.trim()).filter(Boolean);
  const now = () => Date.now();
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const adapter = new KrakenAdapter(createKrakenFuturesApi(config), { now, sleep, log: (e) => console.log(`[adapter] ${e.level} ${e.message}`) });
  const store = new InMemoryOrderStore();
  const orders = new OrderManager(adapter, store, { now });
  const alerts = new MemoryAlertSink();
  const instruments = new InstrumentRegistry(() => adapter.instruments(), now);
  const stops = new StopManager(orders, adapter, instruments, alerts, { now });
  const port = new KrakenExecutionPort({ mode: 'demo', adapter, orders, stops, instruments, alerts, funding: new FundingFromLedgerPending(), now });
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
  const tag = new Date().toISOString();
  const runId = tag.replace(/[^0-9]/g, '').slice(0, 14);

  let prepared = true;
  for (const symbol of symbols) {
    prepared &&= await run(`posizione di prova su ${symbol} con stop nativo`, async () => {
      const spec = await instruments.get(symbol);
      const size = floorToStep(spec.sizeStep, spec);
      const mark = (await adapter.tickers()).find((t) => t.symbol === symbol)?.markPrice;
      if (!mark) throw new Error('ticker mancante');
      const leverage = await ensureIsolatedLeverage(adapter, symbol, 1);
      if (leverage.outcome === 'failed') throw new Error(leverage.reason);
      const entry = await orders.submit({ intentKey: `kill-test-${tag}-${symbol}`, purpose: 'ENTRY', symbol, side: 'buy', orderType: 'ioc', size, limitPrice: roundToTick(mark * 1.01, spec.tickSize, 'up'), reduceOnly: false });
      if (entry.state !== 'FILLED') throw new Error(`ingresso ${entry.state} (${entry.lastError})`);
      const stop = await stops.ensure({ positionId: `kill-test-${tag}-${symbol}`, symbol, direction: 'LONG', size, level: mark * 0.9 });
      if (stop.status !== 'PROTECTED') throw new Error(`stop ${stop.status}`);
      return `long ${size} con stop a ${stop.stop.stopPrice}`;
    });
  }
  prepared &&= await run('ordine limite non protettivo lontano dal mercato', async () => {
    const symbol = symbols[0];
    const spec = await instruments.get(symbol);
    const mark = (await adapter.tickers()).find((t) => t.symbol === symbol)?.markPrice as number;
    const r = await orders.submit({ intentKey: `kill-test-${tag}-resting`, purpose: 'ENTRY', symbol, side: 'buy', orderType: 'lmt', size: floorToStep(spec.sizeStep, spec), limitPrice: roundToTick(mark * 0.5, spec.tickSize, 'down'), reduceOnly: false });
    if (r.state !== 'ACKNOWLEDGED') throw new Error(`stato ${r.state} (${r.lastError})`);
    return `${r.cliOrdId} a riposo`;
  });

  // Il kill switch va eseguito comunque (anche se la preparazione è fallita a metà): il conto deve finire flat.
  let flat = false;
  for (let attempt = 1; attempt <= 5 && !flat; attempt++) {
    await run(`kill switch, passaggio ${attempt}`, async () => {
      const r = await port.killSwitch(runId);
      flat = r.flat;
      return `${r.flat ? 'FLAT' : 'non ancora flat'} — ${r.steps.join(' | ')}`;
    });
    if (!flat) await sleep(10_000);
  }
  await run('verifica: nessuna posizione e nessun ordine sul conto', async () => {
    const [positions, open] = await Promise.all([adapter.openPositions('protective'), adapter.openOrders('protective')]);
    if (positions.length || open.length) throw new Error(`posizioni ${positions.length}, ordini ${open.length}: CONTROLLARE A MANO`);
    return 'flat, nessun ordine';
  });
  await run('verifica: chiusure reduceOnly con cliOrdId del kill switch', async () => {
    const own = (await Promise.all(symbols.map((s) => store.byIntent(`kill-${runId}-${s}`)))).flat();
    if (own.length === 0) throw new Error('nessuna chiusura del kill switch registrata');
    const bad = own.filter((r) => !r.reduceOnly || !r.cliOrdId.startsWith('mt-k-'));
    if (bad.length) throw new Error(`chiusure non conformi: ${bad.map((r) => r.cliOrdId).join(', ')}`);
    return own.map((r) => `${r.symbol} ${r.cliOrdId} ${r.state}`).join('; ');
  });

  const ok = prepared && steps.every((s) => s.ok || s.step.startsWith('kill switch, passaggio'));
  const report = { symbols, runId, at: new Date().toISOString(), ok: ok && flat, steps, alerts: alerts.alerts };
  const out = arg('--out', '');
  if (out) writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(report.ok ? '\nKILL SWITCH DEMO: PASS' : '\nKILL SWITCH DEMO: FAIL');
  process.exit(report.ok ? 0 : 1);
}

await main();
