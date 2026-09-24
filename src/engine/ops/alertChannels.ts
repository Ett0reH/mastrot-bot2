// Canali degli alert (F6): Telegram e webhook, oltre al log strutturato sempre attivo.
//
// - Telegram: Bot API `sendMessage` (POST https://api.telegram.org/bot<token>/sendMessage con
//   `chat_id` e `text`, documentazione ufficiale core.telegram.org/bots/api#sendmessage). Testo
//   semplice, senza parse_mode (niente problemi di escape), tagliato sotto il limite di 4096
//   caratteri. Non verificato da questo ambiente (rete bloccata): va provato con
//   `POST /api/alerts/test` prima del live.
// - Webhook: POST JSON { source, mode, level, code, message, at, context }.
// - Un canale che fallisce non blocca gli altri né il bot: l'errore finisce nel log.
// - Gli alert identici (stesso codice e messaggio) ripetuti entro la finestra di deduplica non
//   vengono reinviati sul canale; il primo invio dopo la finestra riporta quante volte si sono
//   ripetuti. Il log li riceve sempre tutti.
import type { EngineConfig, TradingMode } from '../config/config';
import type { Alert, AlertSink } from './alerts';
import type { Logger } from './logger';

export interface HttpResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type HttpPost = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<HttpResponseLike>;

const LEVEL_TAG: Record<Alert['level'], string> = { info: 'INFO', warning: 'WARNING', critical: 'CRITICAL' };
const TELEGRAM_MAX = 3_900;

export function formatAlertText(alert: Alert, mode: TradingMode): string {
  const ids = ['positionId', 'cliOrdId'].map((k) => (typeof alert.context?.[k] === 'string' ? `${k}: ${alert.context[k]}` : null)).filter(Boolean);
  const text = [`[${LEVEL_TAG[alert.level]}] ${alert.code} · ${mode.toUpperCase()}`, alert.message, ...ids, alert.at].join('\n');
  return text.length > TELEGRAM_MAX ? `${text.slice(0, TELEGRAM_MAX - 1)}…` : text;
}

async function post(http: HttpPost, url: string, body: unknown, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await http(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  } finally {
    clearTimeout(timer);
  }
}

export class TelegramAlertSink implements AlertSink {
  constructor(
    private readonly target: { botToken: string; chatId: string },
    private readonly mode: TradingMode,
    private readonly http: HttpPost = fetch as unknown as HttpPost,
    private readonly timeoutMs = 10_000,
  ) {}

  async send(alert: Alert): Promise<void> {
    await post(this.http, `https://api.telegram.org/bot${this.target.botToken}/sendMessage`, { chat_id: this.target.chatId, text: formatAlertText(alert, this.mode), disable_web_page_preview: true }, this.timeoutMs);
  }
}

export class WebhookAlertSink implements AlertSink {
  constructor(
    private readonly url: string,
    private readonly mode: TradingMode,
    private readonly http: HttpPost = fetch as unknown as HttpPost,
    private readonly timeoutMs = 10_000,
  ) {}

  async send(alert: Alert): Promise<void> {
    await post(this.http, this.url, { source: 'mastrot-bot', mode: this.mode, level: alert.level, code: alert.code, message: alert.message, at: alert.at, context: alert.context ?? {} }, this.timeoutMs);
  }
}

/** Non reinvia alert identici entro la finestra; poi riporta quante volte sono stati soppressi. */
export class DedupAlertSink implements AlertSink {
  private readonly last = new Map<string, { sentAt: number; suppressed: number }>();

  constructor(private readonly inner: AlertSink, private readonly windowMs: number, private readonly now: () => number) {}

  async send(alert: Alert): Promise<void> {
    const key = `${alert.code}|${alert.message}`;
    const t = this.now();
    const seen = this.last.get(key);
    if (seen && t - seen.sentAt < this.windowMs) {
      seen.suppressed++;
      return;
    }
    const repeated = seen?.suppressed ?? 0;
    this.last.set(key, { sentAt: t, suppressed: 0 });
    if (this.last.size > 500) this.last.delete(this.last.keys().next().value as string);
    await this.inner.send(repeated > 0 ? { ...alert, message: `${alert.message} (ripetuto altre ${repeated} volte)` } : alert);
  }
}

/** Invia a tutti i canali; un canale che fallisce non ferma gli altri. */
export class FanoutAlertSink implements AlertSink {
  constructor(private readonly sinks: readonly { name: string; sink: AlertSink }[], private readonly logger: Logger) {}

  async send(alert: Alert): Promise<void> {
    await Promise.all(
      this.sinks.map(async ({ name, sink }) => {
        try {
          await sink.send(alert);
        } catch (err) {
          this.logger.error(`Alert ${alert.code} non inviato su ${name}: ${(err as Error).message}`, { alertCode: alert.code });
        }
      }),
    );
  }
}

/** Canale esterno configurato (null con ALERT_CHANNEL=none). */
export function channelSink(config: EngineConfig, now: () => number, http?: HttpPost): { name: string; sink: AlertSink } | null {
  const dedupMs = 10 * 60_000;
  if (config.alerts.channel === 'telegram' && config.alerts.telegram) {
    return { name: 'telegram', sink: new DedupAlertSink(new TelegramAlertSink(config.alerts.telegram, config.mode, http), dedupMs, now) };
  }
  if (config.alerts.channel === 'webhook' && config.alerts.webhookUrl) {
    return { name: 'webhook', sink: new DedupAlertSink(new WebhookAlertSink(config.alerts.webhookUrl, config.mode, http), dedupMs, now) };
  }
  return null;
}
