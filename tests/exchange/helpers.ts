// Ambiente di test dell'execution layer: orologio virtuale, Kraken simulato, adapter, ordini.
import { KrakenAdapter } from '../../src/engine/exchange/krakenAdapter';
import { OrderManager } from '../../src/engine/exchange/orderManager';
import { InMemoryOrderStore } from '../../src/engine/exchange/orders';
import { FAKE_INSTRUMENTS, FakeKrakenFutures } from '../../src/engine/sim/fakeKraken';

export const T0 = Date.UTC(2026, 8, 24, 12, 0, 0);

export function exchangeEnv(marks: Record<string, number> = { PF_XBTUSD: 60_000, PF_ETHUSD: 3_000, PF_SOLUSD: 150, PF_XRPUSD: 0.6, PF_DOGEUSD: 0.2 }) {
  const clock = { t: T0 };
  const now = () => clock.t;
  const sleep = async (ms: number) => {
    clock.t += ms;
  };
  const fake = new FakeKrakenFutures({ now, instruments: FAKE_INSTRUMENTS, marks });
  const logs: { level: string; message: string }[] = [];
  const adapter = new KrakenAdapter(fake, { now, sleep, timeoutMs: 1_000, log: (e) => logs.push(e) });
  const store = new InMemoryOrderStore();
  const orders = new OrderManager(adapter, store, { now, processWindowMs: 15_000, graceMs: 5_000 });
  return { clock, now, sleep, fake, adapter, store, orders, logs };
}

export type ExchangeEnv = ReturnType<typeof exchangeEnv>;
