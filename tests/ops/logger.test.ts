// Log strutturati (F6): formato, correlation id, oscuramento dei segreti, errori recenti.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../../src/engine/config/config';
import { configSecrets, CycleContext, Logger } from '../../src/engine/ops/logger';

const T = Date.UTC(2026, 8, 24, 10, 15, 45);

function capture(options: { secrets?: string[]; minLevel?: 'debug' | 'info' } = {}) {
  const lines: string[] = [];
  const cycle = new CycleContext();
  const logger = new Logger({ write: (l) => lines.push(l), now: () => T, cycle, ...options });
  return { lines, cycle, logger, parsed: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

test('una riga JSON per evento: campi fissi in testa, poi i correlation id, poi il contesto', () => {
  const { lines, cycle, logger } = capture();
  cycle.current = 'D-20260924T101545Z';
  logger.child({ positionId: 'SOL-2022-01-21T01:45:00.000Z' }).warn('ordine incerto', { cliOrdId: 'mt-e-0123456789abcdef-1', symbol: 'SOL' });
  assert.equal(lines.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(lines[0])), ['type', 'level', 'at', 'message', 'cycleId', 'positionId', 'cliOrdId', 'symbol']);
  assert.deepEqual(JSON.parse(lines[0]), {
    type: 'log', level: 'warn', at: '2026-09-24T10:15:45.000Z', message: 'ordine incerto',
    cycleId: 'D-20260924T101545Z', positionId: 'SOL-2022-01-21T01:45:00.000Z', cliOrdId: 'mt-e-0123456789abcdef-1', symbol: 'SOL',
  });
});

test('fuori da un ciclo niente cycleId; il contesto non sovrascrive i campi della riga', () => {
  const { parsed, logger } = capture();
  logger.info('avvio', { level: 'finto', message: 'finto', error: new Error('dettaglio') });
  const [r] = parsed();
  assert.equal(r.cycleId, undefined);
  assert.equal(r.level, 'info');
  assert.equal(r.message, 'avvio');
  assert.equal(r.ctx_level, 'finto');
  assert.equal(r.error, 'dettaglio', 'gli Error diventano il loro messaggio');
});

test('i segreti non finiscono mai nei log, neanche nel contesto o con l escape JSON', () => {
  const key = 'KEY-abcdef123456';
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIEv\n-----END PRIVATE KEY-----\n';
  const { lines, logger } = capture({ secrets: [key, pem, 'abc'] });
  logger.error(`chiamata fallita con ${key}`, { header: `Bearer ${key}`, sa: pem, short: 'abc' });
  assert.ok(!lines[0].includes(key));
  assert.ok(!lines[0].includes('MIIEv'));
  assert.equal(JSON.parse(lines[0]).header, 'Bearer [REDACTED]');
  assert.equal(JSON.parse(lines[0]).short, 'abc', 'i valori troppo corti non vengono cercati');
});

test('errori recenti: solo warning ed errori, dal più recente, con limite', () => {
  const { logger } = capture();
  logger.info('ok');
  for (let i = 0; i < 60; i++) logger.warn(`w${i}`);
  logger.error('boom');
  const recent = logger.recentProblems(5);
  assert.deepEqual(recent.map((r) => r.message), ['boom', 'w59', 'w58', 'w57', 'w56']);
  assert.equal(logger.recentProblems(1_000).length, 50, 'ne restano al massimo 50');
});

test('livello minimo: debug scartato di default', () => {
  const quiet = capture();
  quiet.logger.debug('dettaglio');
  assert.equal(quiet.lines.length, 0);
  const verbose = capture({ minLevel: 'debug' });
  verbose.logger.debug('dettaglio');
  assert.equal(verbose.lines.length, 1);
});

test('configSecrets: chiavi Kraken, token, bot Telegram, webhook e chiave del service account', () => {
  const sa = JSON.stringify({ type: 'service_account', private_key: '-----BEGIN PRIVATE KEY-----\nXYZXYZ\n-----END PRIVATE KEY-----\n', private_key_id: 'kid-0123456789' });
  const { config } = loadConfig({
    TRADING_MODE: 'demo', KRAKEN_DEMO_API_KEY: 'demo-key-0001', KRAKEN_DEMO_API_SECRET: 'demo-secret-0001',
    ADMIN_TOKEN: 'a'.repeat(32), CRON_TOKEN: 'c'.repeat(32), ALERT_CHANNEL: 'telegram', TELEGRAM_BOT_TOKEN: '123:tok-tok-tok', TELEGRAM_CHAT_ID: '42',
    FIREBASE_SERVICE_ACCOUNT_JSON: sa,
  });
  const secrets = configSecrets(config);
  for (const s of ['demo-key-0001', 'demo-secret-0001', 'a'.repeat(32), 'c'.repeat(32), '123:tok-tok-tok', 'kid-0123456789']) assert.ok(secrets.includes(s), s);
  assert.ok(secrets.some((s) => s.includes('XYZXYZ')));
  const { lines, logger } = capture({ secrets });
  logger.info('config', { raw: sa });
  assert.ok(!lines[0].includes('XYZXYZ') && !lines[0].includes('kid-0123456789'));
});
