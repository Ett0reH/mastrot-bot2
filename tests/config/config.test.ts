import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConfigError, DEFAULT_LIMITS, LIVE_CONFIRM_PHRASE, describeConfig, loadConfig } from '../../src/engine/config/config';
import { krakenClientOptions } from '../../src/engine/config/runtime';
import { firestoreTarget } from '../../src/engine/persistence/firebase';

const TOKEN = 'a'.repeat(32);
const CRON = 'c'.repeat(32);

function expectProblems(env: Record<string, string>, ...fragments: string[]) {
  try {
    loadConfig(env);
  } catch (err) {
    assert.ok(err instanceof ConfigError, 'deve essere un ConfigError');
    for (const f of fragments) assert.ok(err.problems.some((p) => p.includes(f)), `manca un problema con "${f}": ${err.problems.join(' | ')}`);
    return;
  }
  assert.fail('la configurazione doveva essere rifiutata');
}

const liveEnv = {
  TRADING_MODE: 'live',
  KRAKEN_LIVE_API_KEY: 'live-key',
  KRAKEN_LIVE_API_SECRET: 'live-secret',
  LIVE_TRADING_CONFIRM: LIVE_CONFIRM_PHRASE,
  CAPITAL_CAP_USD: '500',
  MAX_LEVERAGE: '2',
  MAX_POSITION_NOTIONAL_USD: '400',
  MAX_OPEN_POSITIONS: '4',
  MAX_DAILY_LOSS_PCT: '3',
  DRAWDOWN_REDUCE_ONLY_PCT: '15',
  ALERT_CHANNEL: 'telegram',
  TELEGRAM_BOT_TOKEN: 'bot-token',
  TELEGRAM_CHAT_ID: '12345',
  ADMIN_TOKEN: TOKEN,
};

test('default: shadow, nessun ordine, nessuna credenziale, limiti di default', () => {
  const { config, warnings } = loadConfig({});
  assert.equal(config.mode, 'shadow');
  assert.equal(config.ordersEnabled, false);
  assert.equal(config.kraken.credentials, null);
  assert.equal(config.kraken.tradingEnvironment, null);
  assert.deepEqual(config.limits, DEFAULT_LIMITS);
  assert.equal(config.stopModel, 'close_based_plus_native_backstop');
  assert.ok(warnings.some((w) => w.includes('ADMIN_TOKEN')));
});

test('shadow: il client Kraken non riceve chiavi e usa la produzione pubblica', () => {
  const { config } = loadConfig({ KRAKEN_API_KEY: 'k', KRAKEN_SECRET_KEY: 's', KRAKEN_SANDBOX: 'true' });
  const opts = krakenClientOptions(config);
  assert.equal(opts.apiKey, undefined);
  assert.equal(opts.apiSecret, undefined);
  assert.equal(opts.testnet, false);
});

test('le variabili legacy non abilitano gli ordini: LIVE_TRADING_ENABLED=true resta shadow', () => {
  const { config, warnings } = loadConfig({ LIVE_TRADING_ENABLED: 'true', KRAKEN_SANDBOX: 'false', KRAKEN_API_KEY: 'k', KRAKEN_SECRET_KEY: 's' });
  assert.equal(config.mode, 'shadow');
  assert.equal(config.ordersEnabled, false);
  assert.ok(warnings.some((w) => w.includes('LIVE_TRADING_ENABLED')));
});

test('TRADING_MODE non valido → errore', () => {
  expectProblems({ TRADING_MODE: 'paper' }, 'TRADING_MODE=paper');
});

test('demo: servono le chiavi demo; con quelle il client punta a demo-futures', () => {
  expectProblems({ TRADING_MODE: 'demo' }, 'KRAKEN_DEMO_API_KEY');
  const { config } = loadConfig({ TRADING_MODE: 'demo', KRAKEN_DEMO_API_KEY: 'dk', KRAKEN_DEMO_API_SECRET: 'ds' });
  assert.equal(config.ordersEnabled, true);
  assert.equal(config.kraken.tradingEnvironment, 'demo');
  assert.deepEqual(krakenClientOptions(config), { apiKey: 'dk', apiSecret: 'ds', testnet: true, strictParamValidation: true });
});

test('demo: le chiavi legacy sono accettate solo se KRAKEN_SANDBOX=true, con avviso', () => {
  expectProblems({ TRADING_MODE: 'demo', KRAKEN_API_KEY: 'k', KRAKEN_SECRET_KEY: 's' }, 'KRAKEN_DEMO_API_KEY');
  const { config, warnings } = loadConfig({ TRADING_MODE: 'demo', KRAKEN_API_KEY: 'k', KRAKEN_SECRET_KEY: 's', KRAKEN_SANDBOX: 'true' });
  assert.equal(config.kraken.credentials?.apiKey, 'k');
  assert.ok(warnings.some((w) => w.includes('chiavi legacy')));
});

test('live completo → accettato, ambiente produzione', () => {
  const { config } = loadConfig(liveEnv);
  assert.equal(config.mode, 'live');
  assert.equal(config.kraken.tradingEnvironment, 'production');
  assert.equal(krakenClientOptions(config).testnet, false);
  assert.equal(config.limits.capitalCapUsd, 500);
});

test('live senza frase di conferma → rifiutato', () => {
  expectProblems({ ...liveEnv, LIVE_TRADING_CONFIRM: 'yes' }, 'LIVE_TRADING_CONFIRM');
});

test('live con chiavi legacy invece delle chiavi live → rifiutato', () => {
  const { KRAKEN_LIVE_API_KEY: _k, KRAKEN_LIVE_API_SECRET: _s, ...rest } = liveEnv;
  expectProblems({ ...rest, KRAKEN_API_KEY: 'k', KRAKEN_SECRET_KEY: 's' }, 'KRAKEN_LIVE_API_KEY');
});

test('live senza limiti espliciti → rifiutato con l elenco dei mancanti', () => {
  const { CAPITAL_CAP_USD: _c, MAX_DAILY_LOSS_PCT: _d, ...rest } = liveEnv;
  expectProblems(rest, 'CAPITAL_CAP_USD', 'MAX_DAILY_LOSS_PCT');
});

test('live senza alert o senza ADMIN_TOKEN → rifiutato', () => {
  expectProblems({ ...liveEnv, ALERT_CHANNEL: 'none' }, 'canale di alert');
  const { ADMIN_TOKEN: _t, ...rest } = liveEnv;
  expectProblems(rest, 'ADMIN_TOKEN');
});

test('limiti fuori intervallo → errore', () => {
  expectProblems({ MAX_LEVERAGE: '10' }, 'MAX_LEVERAGE');
  expectProblems({ CAPITAL_CAP_USD: '-5' }, 'CAPITAL_CAP_USD');
  expectProblems({ MAX_OPEN_POSITIONS: '2.5' }, 'MAX_OPEN_POSITIONS');
  expectProblems({ MAX_DAILY_LOSS_PCT: 'abc' }, 'MAX_DAILY_LOSS_PCT');
});

test('token troppo corti → errore', () => {
  expectProblems({ ADMIN_TOKEN: 'short' }, 'ADMIN_TOKEN troppo corto');
  expectProblems({ CRON_TOKEN: 'short' }, 'CRON_TOKEN troppo corto');
});

test('simboli: solo quelli mappati su Kraken, niente duplicati', () => {
  expectProblems({ SYMBOLS: 'BTC,FOO' }, 'FOO');
  expectProblems({ SYMBOLS: 'BTC,BTC' }, 'duplicati');
  assert.deepEqual(loadConfig({ SYMBOLS: 'btc, eth' }).config.symbols, ['BTC', 'ETH']);
});

test('alert telegram/webhook richiedono le credenziali', () => {
  expectProblems({ ALERT_CHANNEL: 'telegram' }, 'TELEGRAM_BOT_TOKEN');
  expectProblems({ ALERT_CHANNEL: 'webhook', ALERT_WEBHOOK_URL: 'http://insecure' }, 'https://');
});

test('describeConfig non contiene segreti', () => {
  const { config } = loadConfig({ ...liveEnv, CRON_TOKEN: CRON });
  const text = describeConfig(config);
  for (const secret of ['live-key', 'live-secret', 'bot-token', TOKEN, CRON]) assert.ok(!text.includes(secret), `segreto nel riepilogo: ${secret}`);
  assert.match(text, /LIVE/);
});

test('le virgolette aggiunte dai pannelli dei segreti vengono tolte', () => {
  const { config } = loadConfig({ ADMIN_TOKEN: `"${TOKEN}"` });
  assert.equal(config.auth.adminToken, TOKEN);
});

test('FIRESTORE_DATABASE_ID: un database per modalità senza toccare il file del repository (D51)', () => {
  assert.equal(loadConfig({}).config.firebase.databaseId, null);
  const { config } = loadConfig({ FIRESTORE_DATABASE_ID: 'mastrot-demo' });
  assert.equal(config.firebase.databaseId, 'mastrot-demo');
  assert.match(describeConfig(config), /database Firestore=mastrot-demo/);
  assert.match(describeConfig(loadConfig({}).config), /database Firestore=quello di firebase-applet-config\.json/);
  expectProblems({ FIRESTORE_DATABASE_ID: 'nome con spazi' }, 'FIRESTORE_DATABASE_ID');
  expectProblems({ FIRESTORE_DATABASE_ID: 'a/b' }, 'FIRESTORE_DATABASE_ID');

  const dir = mkdtempSync(join(tmpdir(), 'firebase-'));
  try {
    writeFileSync(join(dir, 'firebase-applet-config.json'), JSON.stringify({ projectId: 'progetto', firestoreDatabaseId: 'dal-file' }));
    assert.deepEqual(firestoreTarget(loadConfig({}).config, dir), { projectId: 'progetto', databaseId: 'dal-file' });
    assert.deepEqual(firestoreTarget(config, dir), { projectId: 'progetto', databaseId: 'mastrot-demo' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
