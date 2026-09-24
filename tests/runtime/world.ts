// Mondo simulato per i test del runtime (F4): archivio condiviso (come Firestore), Kraken
// simulato, dati reali 15m, orologio virtuale e istanze del bot che possono "morire" e ripartire.
import { loadConfig, type RiskLimits } from '../../src/engine/config/config';
import { REALISTIC_PROFILE } from '../../src/engine/backtest/profiles';
import { loadBacktestData } from '../../src/engine/backtest/runner';
import { BAR_15M_MS, type Candle, KRAKEN_NATIVE_SYMBOLS } from '../../src/engine/data/dataset';
import { AccountLedger } from '../../src/engine/exchange/accountLedger';
import { InstrumentRegistry } from '../../src/engine/exchange/instruments';
import { KrakenAdapter } from '../../src/engine/exchange/krakenAdapter';
import { FundingFromLedgerPending } from '../../src/engine/exchange/krakenExecutionPort';
import { OrderManager } from '../../src/engine/exchange/orderManager';
import { StopManager } from '../../src/engine/exchange/stopManager';
import { lastClosedSlot } from '../../src/engine/live/decisionCycle';
import { MemoryAlertSink } from '../../src/engine/ops/alerts';
import { BotStore, WriteBudget } from '../../src/engine/persistence/botStore';
import { MemoryDocumentStore } from '../../src/engine/persistence/documentStore';
import { ReplayCandleSource } from '../../src/engine/replay/replay';
import { BotRuntime } from '../../src/engine/runtime/botRuntime';
import { LeaseManager } from '../../src/engine/runtime/lease';
import { FAKE_INSTRUMENTS, FakeKrakenFutures } from '../../src/engine/sim/fakeKraken';
import { GOLDEN_WINDOWS } from '../../scripts/golden/windows';

export const SYMBOLS = GOLDEN_WINDOWS.find((w) => w.id === '2022H1')!.symbols;
// Cap di 10.000 $ come il golden; il nozionale massimo scala con il cap come nei default della
// sezione 2 (1.000 $ di nozionale per 1.000 $ di cap), gli altri limiti sono percentuali o conteggi.
const LIMITS_10K = { CAPITAL_CAP_USD: '10000', MAX_POSITION_NOTIONAL_USD: '10000' };
export const DEMO_CONFIG = loadConfig({ TRADING_MODE: 'demo', KRAKEN_DEMO_API_KEY: 'dk', KRAKEN_DEMO_API_SECRET: 'ds', ...LIMITS_10K }).config;
export const SHADOW_CONFIG = loadConfig(LIMITS_10K).config;
export const MIN = 60_000;

const dataCache = new Map<string, Record<string, Candle[]>>();

export function makeWorld(start = '2022-01-21T00:00:00Z', end = '2022-01-25T23:45:00Z') {
  const key = `${start}|${end}`;
  if (!dataCache.has(key)) {
    dataCache.set(key, loadBacktestData({ symbols: SYMBOLS, start, end, warmupDays: 50, initialEquity: 10000, execution: REALISTIC_PROFILE.execution, backstop: REALISTIC_PROFILE.backstop, funding: { kind: 'none' } }));
  }
  const data = dataCache.get(key)!;
  const startMs = Date.parse(start);
  const clock = { t: startMs };
  const now = () => clock.t;
  const sleep = async (ms: number) => {
    clock.t += ms;
  };
  const marks: Record<string, number> = {};
  for (const s of SYMBOLS) marks[KRAKEN_NATIVE_SYMBOLS[s]] = data[s].filter((c) => c.t < startMs).at(-1)!.c;
  const fake = new FakeKrakenFutures({ now, instruments: FAKE_INSTRUMENTS, marks });
  const docs = new MemoryDocumentStore();
  const bySymbol = Object.fromEntries(SYMBOLS.map((s) => [s, new Map(data[s].map((c) => [c.t, c]))]));
  let applied = startMs - BAR_15M_MS;
  /** Il mercato del fake avanza con le candele già chiuse: apertura, minimo/massimo, chiusura. */
  const drive = (upTo: number) => {
    for (let slot = applied + BAR_15M_MS; slot <= upTo; slot += BAR_15M_MS) {
      for (const s of SYMBOLS) {
        const c = bySymbol[s].get(slot);
        if (!c) continue;
        for (const p of c.c >= c.o ? [c.o, c.l, c.h, c.c] : [c.o, c.h, c.l, c.c]) fake.setMark(KRAKEN_NATIVE_SYMBOLS[s], p);
      }
      applied = slot;
    }
  };
  const calls: { instance: string; method: string; params: unknown }[] = [];
  return { data, startMs, clock, now, sleep, fake, docs, drive, calls };
}

export type World = ReturnType<typeof makeWorld>;

/** Kraken visto da un'istanza: ogni chiamata è attribuita; un'istanza "morta" non raggiunge più l'exchange. */
function reach(world: World, id: string, state: { alive: boolean }): FakeKrakenFutures {
  return new Proxy(world.fake, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (!state.alive) return Promise.reject(Object.assign(new Error('processo terminato'), { code: 'ECONNRESET' }));
        world.calls.push({ instance: id, method: String(prop), params: args[0] });
        return value.apply(target, args);
      };
    },
  });
}

export function makeInstance(world: World, id: string, options: { docs?: MemoryDocumentStore; mode?: 'demo' | 'shadow'; writeBudget?: number; limits?: Partial<RiskLimits> } = {}) {
  const docs = options.docs ?? world.docs;
  const base = options.mode === 'shadow' ? SHADOW_CONFIG : DEMO_CONFIG;
  const config = options.limits ? { ...base, limits: { ...base.limits, ...options.limits } } : base;
  const now = world.now;
  const budget = new WriteBudget(options.writeBudget ?? 5_000, now);
  const store = new BotStore(docs, budget, now);
  const lease = new LeaseManager(docs, id, { now, ttlMs: 60_000, safetyMarginMs: 20_000, onWrite: () => budget.recordWrite() });
  const alerts = new MemoryAlertSink();
  const state = { alive: true };
  const source = new ReplayCandleSource(world.data, now, () => 20_000);
  if (options.mode === 'shadow') {
    const runtime = new BotRuntime({ config, now, store, lease, source, alerts }, { startMs: world.startMs });
    return { id, runtime, store, lease, alerts, docs, state, orders: null };
  }
  const adapter = new KrakenAdapter(reach(world, id, state), { now, sleep: world.sleep, canWrite: () => lease.canWrite() });
  const orders = new OrderManager(adapter, store.orders, { now });
  const instruments = new InstrumentRegistry(() => adapter.instruments(), now);
  const stops = new StopManager(orders, adapter, instruments, alerts, { now });
  const runtime = new BotRuntime(
    { config, now, store, lease, source, alerts, kraken: { adapter, orders, stops, instruments, funding: new FundingFromLedgerPending(), ledger: new AccountLedger(adapter, docs, () => budget.recordWrite()) } },
    { startMs: world.startMs },
  );
  return { id, runtime, store, lease, alerts, docs, state, orders };
}

export type Instance = ReturnType<typeof makeInstance>;

/**
 * Un passo di 15 minuti: tick decisionale 60 s dopo la fine dello slot, poi cicli di protezione
 * ogni 20 s (tutti, come il runtime reale, se `everyProtection`; altrimenti solo il primo).
 */
export async function step(world: World, instances: Instance[], t: number, everyProtection = false): Promise<void> {
  world.clock.t = t;
  world.drive(lastClosedSlot(t));
  for (const i of instances) await i.runtime.decisionTick(t);
  const last = everyProtection ? t + 15 * MIN - 20_000 : t + 20_000;
  for (let p = t + 20_000; p <= last; p += 20_000) {
    world.clock.t = p;
    world.drive(lastClosedSlot(p));
    for (const i of instances) await i.runtime.protectionTick(p);
  }
}

/** Tempi dei tick decisionali: fine di ogni slot 15m + 60 s. */
export function tickTimes(from: number, to: number): number[] {
  const out: number[] = [];
  for (let t = Math.floor(from / (15 * MIN)) * 15 * MIN + 15 * MIN + 60_000; t <= to; t += 15 * MIN) out.push(t);
  return out;
}

export function ordersSentBy(world: World, instance: string): number {
  return world.calls.filter((c) => c.instance === instance && (c.method === 'submitOrder' || c.method === 'editOrder' || c.method === 'cancelOrder')).length;
}

export function stopsOn(world: World, native: string) {
  return world.fake.openOrdersFor(native).filter((o) => o.type === 'stp' && o.reduceOnly);
}
