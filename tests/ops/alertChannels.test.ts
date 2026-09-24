// Canali degli alert (F6): Telegram, webhook, deduplica, fanout, riga di log.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../../src/engine/config/config';
import { channelSink, DedupAlertSink, FanoutAlertSink, formatAlertText, type HttpPost, TelegramAlertSink, WebhookAlertSink } from '../../src/engine/ops/alertChannels';
import { type Alert, LogAlertSink, makeAlert, MemoryAlertSink } from '../../src/engine/ops/alerts';
import { CycleContext, Logger } from '../../src/engine/ops/logger';

const T = Date.UTC(2026, 8, 24, 10);

function fakeHttp(status = 200) {
  const requests: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const http: HttpPost = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) as Record<string, unknown>, headers: init.headers });
    return { ok: status >= 200 && status < 300, status, text: async () => (status === 200 ? '{"ok":true}' : '{"ok":false,"description":"Bad Request: chat not found"}') };
  };
  return { http, requests };
}

const stopMissing = makeAlert(T, 'critical', 'STOP_MISSING', 'Stop assente su PF_SOLUSD: ripristino in corso', { positionId: 'SOL-2022-01-21T01:45:00.000Z', cliOrdId: 'mt-s-0123456789abcdef-1' });

test('Telegram: sendMessage del Bot API con chat_id e testo semplice (livello, codice, modalità, id)', async () => {
  const { http, requests } = fakeHttp();
  await new TelegramAlertSink({ botToken: '123:abc', chatId: '-10042' }, 'demo', http).send(stopMissing);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.telegram.org/bot123:abc/sendMessage');
  assert.equal(requests[0].headers['Content-Type'], 'application/json');
  assert.equal(requests[0].body.chat_id, '-10042');
  assert.equal(requests[0].body.parse_mode, undefined, 'niente markdown: nessun problema di escape');
  const text = requests[0].body.text as string;
  assert.match(text, /^\[CRITICAL\] STOP_MISSING · DEMO\n/);
  assert.match(text, /positionId: SOL-2022-01-21T01:45:00.000Z/);
  assert.match(text, /cliOrdId: mt-s-0123456789abcdef-1/);
});

test('Telegram: testo sotto il limite dei messaggi anche con messaggi lunghi', () => {
  const long = formatAlertText(makeAlert(T, 'warning', 'DESYNC', 'x'.repeat(10_000)), 'live');
  assert.ok(long.length <= 3_900);
  assert.ok(long.endsWith('…'));
});

test('webhook: JSON con modalità, livello, codice, messaggio, istante e contesto', async () => {
  const { http, requests } = fakeHttp();
  await new WebhookAlertSink('https://hooks.example/alert', 'live', http).send(stopMissing);
  assert.deepEqual(requests[0].body, { source: 'mastrot-bot', mode: 'live', level: 'critical', code: 'STOP_MISSING', message: stopMissing.message, at: stopMissing.at, context: stopMissing.context });
});

test('errore del canale: lanciato dal canale, ma il fanout lo registra e consegna agli altri', async () => {
  const failing = fakeHttp(400);
  await assert.rejects(() => new TelegramAlertSink({ botToken: 't', chatId: 'c' }, 'demo', failing.http).send(stopMissing), /HTTP 400.*chat not found/);
  const lines: string[] = [];
  const memory = new MemoryAlertSink();
  const fanout = new FanoutAlertSink(
    [
      { name: 'telegram', sink: new TelegramAlertSink({ botToken: 't', chatId: 'c' }, 'demo', failing.http) },
      { name: 'memoria', sink: memory },
    ],
    new Logger({ write: (l) => lines.push(l), now: () => T }),
  );
  await fanout.send(stopMissing);
  assert.equal(memory.alerts.length, 1, 'gli altri canali ricevono comunque');
  assert.match(JSON.parse(lines[0]).message, /STOP_MISSING non inviato su telegram: HTTP 400/);
});

test('deduplica: alert identici entro 10 minuti inviati una volta; poi il conteggio dei ripetuti', async () => {
  const clock = { t: T };
  const memory = new MemoryAlertSink();
  const dedup = new DedupAlertSink(memory, 10 * 60_000, () => clock.t);
  const a = makeAlert(T, 'warning', 'STALE_DATA', 'Dati fermi da 31 minuti');
  await dedup.send(a);
  for (let i = 0; i < 3; i++) {
    clock.t += 60_000;
    await dedup.send(a);
  }
  await dedup.send(makeAlert(T, 'warning', 'STALE_DATA', 'Dati di nuovo aggiornati'));
  assert.deepEqual(memory.alerts.map((x) => x.message), ['Dati fermi da 31 minuti', 'Dati di nuovo aggiornati'], 'messaggi diversi passano sempre');
  clock.t += 10 * 60_000;
  await dedup.send(a);
  assert.equal(memory.alerts.at(-1)?.message, 'Dati fermi da 31 minuti (ripetuto altre 3 volte)');
});

test('riga di log dell alert: correlation id in cima, ciclo in corso, segreti oscurati', async () => {
  const lines: string[] = [];
  const cycle = new CycleContext();
  cycle.current = 'P-20260924T100020Z';
  const logger = new Logger({ write: () => undefined, secrets: ['SECRET-TOKEN-123'] });
  const sink = new LogAlertSink((l) => lines.push(l), { cycle, redact: (t) => logger.redact(t) });
  const alert: Alert = { ...stopMissing, message: `${stopMissing.message} (token SECRET-TOKEN-123)` };
  await sink.send(alert);
  const r = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(r).slice(0, 8), ['type', 'level', 'code', 'at', 'message', 'cycleId', 'positionId', 'cliOrdId']);
  assert.equal(r.cycleId, 'P-20260924T100020Z');
  assert.ok(!lines[0].includes('SECRET-TOKEN-123'));
});

test('canale dalla configurazione: telegram, webhook o nessuno', () => {
  const tg = loadConfig({ ALERT_CHANNEL: 'telegram', TELEGRAM_BOT_TOKEN: '1:x', TELEGRAM_CHAT_ID: '2' }).config;
  const wh = loadConfig({ ALERT_CHANNEL: 'webhook', ALERT_WEBHOOK_URL: 'https://hooks.example/x' }).config;
  const none = loadConfig({}).config;
  assert.equal(channelSink(tg, () => T)?.name, 'telegram');
  assert.equal(channelSink(wh, () => T)?.name, 'webhook');
  assert.equal(channelSink(none, () => T), null);
});
