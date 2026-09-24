// Garanzie della modalità shadow e dell'unico percorso verso Kraken (F1 D01/D02, F4).
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { BotRuntime } from '../../src/engine/runtime/botRuntime';
import { makeInstance, makeWorld, SHADOW_CONFIG, step, tickTimes } from '../runtime/world';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry) ? [full] : [];
  });
}

const SRC = [...sourceFiles('src'), 'server.ts'];

test('il motore legacy (loopTick) non è più in src/ e il server non lo importa', () => {
  assert.equal(existsSync('src/server/liveEngine.ts'), false);
  assert.doesNotMatch(readFileSync('server.ts', 'utf8'), /liveEngine/);
});

test('nessun file forza LIVE_TRADING_ENABLED o legge variabili Kraken fuori dalla configurazione', () => {
  const offenders = SRC.filter((f) => /process\.env\.(LIVE_TRADING_ENABLED|KRAKEN_SANDBOX|KRAKEN_(API|SECRET)_KEY|KRAKEN_(DEMO|LIVE)_API_(KEY|SECRET))/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, []);
});

test('un solo punto crea il client Kraken, con ambiente e chiavi dalla configurazione', () => {
  const creators = SRC.filter((f) => /new DerivativesClient\(/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(creators, [join('src', 'engine', 'exchange', 'krakenApi.ts')]);
  assert.match(readFileSync(creators[0], 'utf8'), /new DerivativesClient\(krakenClientOptions\(config\)/);
  // ccxt resta solo nel backtest legacy del golden e nelle utility legacy, non raggiungibili dal server.
  const ccxtUsers = SRC.filter((f) => /from ['"]ccxt['"]/.test(readFileSync(f, 'utf8'))).sort();
  assert.deepEqual(ccxtUsers, [join('src', 'server', 'backtest', 'run_kraken.ts'), join('src', 'server', 'liveEngineUtils.ts')]);
  assert.deepEqual(SRC.filter((f) => /liveEngineUtils/.test(readFileSync(f, 'utf8')) && !f.endsWith('liveEngineUtils.ts')), [], 'utility legacy non importate dal codice di produzione');
});

test('in shadow il runtime non riceve l execution layer Kraken e non invia nulla', async () => {
  const world = makeWorld();
  const kraken = makeInstance(world, 'K').runtime as unknown as { deps: { kraken: unknown } };
  assert.throws(() => new BotRuntime({ ...(kraken.deps as object), config: SHADOW_CONFIG } as never), /shadow/);
  const shadow = makeInstance(world, 'S', { mode: 'shadow' });
  assert.equal(await shadow.runtime.ensureRunning(), 'RUNNING');
  for (const t of tickTimes(world.startMs, world.startMs + 12 * 3_600_000)) await step(world, [shadow], t);
  assert.ok((shadow.runtime.statusPayload().openPositions as unknown[]).length > 0 || shadow.runtime.recentTrades.length > 0, 'lo shadow ha operato (fill simulati)');
  assert.equal(world.calls.filter((c) => c.instance === 'S').length, 0, 'nessuna chiamata a Kraken');
  assert.equal(world.fake.orders.size, 0);
});

test('lo stato persistito non contiene segreti', async () => {
  const world = makeWorld();
  const a = makeInstance(world, 'A');
  await a.runtime.ensureRunning();
  for (const t of tickTimes(world.startMs, world.startMs + 3 * 3_600_000)) await step(world, [a], t);
  for (const path of world.docs.paths()) {
    const doc = JSON.stringify(await world.docs.get(path));
    assert.doesNotMatch(doc, /apiKey|apiSecret|secret|password|botSecret/i, path);
  }
});

test('nessuno script manuale con default sandbox divergenti resta in src/', () => {
  const offenders = ['server.ts', 'src/server/app.ts', 'src/server/krakenAdmin.ts']
    .filter((f) => /KRAKEN_SANDBOX|LIVE_TRADING_ENABLED/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, []);
});
