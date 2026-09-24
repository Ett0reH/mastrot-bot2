// Invarianti del sistema dopo uno scenario di caos (F7). Valgono in ogni istante in cui il ciclo di
// protezione ha appena girato: sono la definizione operativa di "il bot ha il controllo".
import assert from 'node:assert/strict';
import { KRAKEN_NATIVE_SYMBOLS } from '../../src/engine/data/dataset';
import type { TradeRecord } from '../../src/engine/core/types';
import type { Instance, World } from '../runtime/world';

/**
 * 1. posizioni del core = posizioni su Kraken (simbolo, verso, size);
 * 2. ogni posizione su Kraken ha esattamente uno stop nativo reduceOnly, dal lato giusto e della size giusta;
 * 3. nessun ordine aperto che non sia uno stop di protezione, nessuno stop su un simbolo senza posizione;
 * 4. nessun ingresso eseguito due volte; per uscite e chiusure d'emergenza (che possono servire più
 *    ordini dopo un fill parziale) mai più della size della posizione;
 * 5. nessun ordine con esito incerto rimasto;
 * 6. PnL dei trade = equity realizzata − capitale;
 * 7. runtime in esecuzione con il lease.
 */
export async function assertInvariants(world: World, inst: Instance, label: string): Promise<void> {
  const core = inst.runtime.statusPayload().openPositions as { symbol: string; size: number; direction: string }[];
  const kraken = [...world.fake.positions.entries()].filter(([, p]) => p.size !== 0);
  assert.deepEqual(kraken.map(([s]) => s).sort(), core.map((p) => KRAKEN_NATIVE_SYMBOLS[p.symbol]).sort(), `${label}: posizioni su Kraken e nel core`);
  for (const p of core) {
    const k = world.fake.positions.get(KRAKEN_NATIVE_SYMBOLS[p.symbol])!;
    assert.equal(Math.abs(k.size), p.size, `${label}: size di ${p.symbol}`);
    assert.equal(k.size > 0 ? 'LONG' : 'SHORT', p.direction, `${label}: verso di ${p.symbol}`);
  }
  for (const [symbol, pos] of kraken) {
    const stops = world.fake.openOrdersFor(symbol).filter((o) => o.type === 'stp' && o.reduceOnly);
    assert.equal(stops.length, 1, `${label}: stop nativi su ${symbol}: ${stops.length}`);
    assert.equal(stops[0].side, pos.size > 0 ? 'sell' : 'buy', `${label}: lato dello stop su ${symbol}`);
    assert.equal(stops[0].size, Math.abs(pos.size), `${label}: size dello stop su ${symbol}`);
  }
  const leftovers = [...world.fake.orders.values()].filter((o) => o.status === 'open' && !(o.type === 'stp' && o.reduceOnly));
  assert.deepEqual(leftovers.map((o) => `${o.symbol} ${o.type} ${o.cliOrdId}`), [], `${label}: ordini non protettivi rimasti aperti`);
  // Uno stop rimasto su un simbolo senza posizione ridurrebbe la prossima posizione dello stesso verso.
  const orphanStops = [...world.fake.orders.values()].filter((o) => o.status === 'open' && (world.fake.positions.get(o.symbol)?.size ?? 0) === 0);
  assert.deepEqual(orphanStops.map((o) => `${o.symbol} ${o.type} ${o.cliOrdId}`), [], `${label}: stop rimasti su simboli senza posizione`);
  const executions = new Map<string, { count: number; filled: number; size: number }>();
  for (const o of world.fake.orders.values()) {
    if (!o.cliOrdId || o.filled <= 0 || !/^mt-[exk]-/.test(o.cliOrdId)) continue;
    const intent = o.cliOrdId.replace(/-\d+$/, '');
    const g = executions.get(intent) ?? { count: 0, filled: 0, size: 0 };
    executions.set(intent, { count: g.count + 1, filled: g.filled + o.filled, size: Math.max(g.size, o.size) });
  }
  const duplicated = [...executions.entries()].filter(([intent, g]) => (intent.startsWith('mt-e-') ? g.count > 1 : g.filled > g.size + 1e-9));
  assert.deepEqual(duplicated, [], `${label}: intenti eseguiti più del dovuto`);
  const uncertain = (await inst.orders!.store.active()).filter((r) => r.state === 'UNKNOWN');
  assert.deepEqual(uncertain.map((r) => r.cliOrdId), [], `${label}: ordini con esito incerto`);
  const check = inst.runtime.metrics().ledgerCheck;
  assert.ok(check.consistent, `${label}: PnL dei trade ${check.realizedFromTrades} ≠ equity realizzata ${check.realizedFromEquity}`);
  assert.equal(inst.runtime.status, 'RUNNING', `${label}: runtime ${inst.runtime.status} (${inst.runtime.lastError})`);
}

export function tradeKey(t: TradeRecord): string {
  return `${t.symbol}|${t.entryTime}|${t.type}|${t.reason}|${t.size}|${t.entryPrice}|${t.exitPrice}`;
}

/** Trade chiusi salvati nell'archivio (sopravvivono ai riavvii e al cambio di istanza). */
export async function persistedTrades(world: World, docs = world.docs): Promise<string[]> {
  return (await docs.query<TradeRecord>('trades', [])).map((d) => tradeKey(d.data)).sort();
}
