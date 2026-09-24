// Configurazione del bot, tipizzata e validata all'avvio (fail fast).
//
// Principi (PROMPT_LIVE_READY_KRAKEN.md, sezioni 2 e 4):
// - il default è sempre sicuro: senza TRADING_MODE il bot gira in `shadow` e non invia ordini;
// - le chiavi demo e live sono variabili separate; in live non si usano mai le chiavi legacy;
// - `live` richiede la frase di conferma, i limiti espliciti, gli alert e il token admin;
// - le variabili legacy (LIVE_TRADING_ENABLED, KRAKEN_SANDBOX, KRAKEN_API_KEY) non decidono più
//   nulla: producono solo avvisi (le chiavi legacy restano accettate in demo per la migrazione).
import { KRAKEN_NATIVE_SYMBOLS } from '../data/dataset';

export type TradingMode = 'shadow' | 'demo' | 'live';
export type AlertChannel = 'none' | 'telegram' | 'webhook';
export type StopModel = 'close_based_plus_native_backstop' | 'native_intrabar';
export type KrakenEnvironment = 'demo' | 'production';

export const LIVE_CONFIRM_PHRASE = 'I_ACCEPT_REAL_MONEY_RISK';
export const MIN_TOKEN_LENGTH = 24;

export interface RiskLimits {
  capitalCapUsd: number;
  maxLeverage: number;
  maxPositionNotionalUsd: number;
  maxOpenPositions: number;
  maxDailyLossPct: number;
  drawdownReduceOnlyPct: number;
}

export interface KrakenCredentials {
  apiKey: string;
  apiSecret: string;
}

export interface EngineConfig {
  mode: TradingMode;
  /** true solo in demo e live: in shadow nessun ordine e nessuna chiamata privata a Kraken. */
  ordersEnabled: boolean;
  kraken: {
    /** Ambiente su cui si inviano ordini e si leggono i conti (null in shadow). */
    tradingEnvironment: KrakenEnvironment | null;
    credentials: KrakenCredentials | null;
    /** I dati di mercato per le decisioni vengono sempre dalla produzione, come nel backtest. */
    marketDataEnvironment: 'production';
  };
  symbols: string[];
  limits: RiskLimits;
  stopModel: StopModel;
  backstopBufferPct: number;
  alerts: {
    channel: AlertChannel;
    telegram: { botToken: string; chatId: string } | null;
    webhookUrl: string | null;
  };
  auth: {
    adminToken: string | null;
    cronToken: string | null;
  };
  firebase: {
    serviceAccountJson: string | null;
  };
  persistence: {
    /** Scritture giornaliere massime su Firestore (oltre, si sospendono journal ed equity). */
    dailyWriteBudget: number;
  };
}

/** Limiti di default (sezione 2 del prompt). In live vanno impostati esplicitamente. */
export const DEFAULT_LIMITS: Readonly<RiskLimits> = {
  capitalCapUsd: 1000,
  maxLeverage: 3,
  maxPositionNotionalUsd: 1000,
  maxOpenPositions: 8,
  maxDailyLossPct: 5,
  drawdownReduceOnlyPct: 15,
};

export const DEFAULT_SYMBOLS: readonly string[] = ['BTC', 'ETH', 'SOL', 'AVAX', 'XRP', 'DOGE', 'LINK', 'ADA'];

const LIMIT_ENV: Record<keyof RiskLimits, string> = {
  capitalCapUsd: 'CAPITAL_CAP_USD',
  maxLeverage: 'MAX_LEVERAGE',
  maxPositionNotionalUsd: 'MAX_POSITION_NOTIONAL_USD',
  maxOpenPositions: 'MAX_OPEN_POSITIONS',
  maxDailyLossPct: 'MAX_DAILY_LOSS_PCT',
  drawdownReduceOnlyPct: 'DRAWDOWN_REDUCE_ONLY_PCT',
};

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Configurazione non valida:\n- ${problems.join('\n- ')}`);
  }
}

type Env = Record<string, string | undefined>;

function read(env: Env, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  // I pannelli dei segreti a volte aggiungono virgolette: le togliamo.
  const value = raw.trim().replace(/^["']|["']$/g, '').trim();
  return value === '' ? undefined : value;
}

function parseNumber(env: Env, key: string, fallback: number, problems: string[], check: (n: number) => boolean, rule: string): number {
  const raw = read(env, key);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !check(n)) {
    problems.push(`${key}=${raw} non valido: ${rule}`);
    return fallback;
  }
  return n;
}

function readToken(env: Env, key: string, problems: string[]): string | null {
  const value = read(env, key);
  if (value === undefined) return null;
  if (value.length < MIN_TOKEN_LENGTH) {
    problems.push(`${key} troppo corto: servono almeno ${MIN_TOKEN_LENGTH} caratteri casuali`);
    return null;
  }
  return value;
}

export function loadConfig(env: Env): { config: EngineConfig; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];

  const modeRaw = (read(env, 'TRADING_MODE') ?? 'shadow').toLowerCase();
  const mode: TradingMode = modeRaw === 'demo' || modeRaw === 'live' || modeRaw === 'shadow' ? modeRaw : 'shadow';
  if (mode !== modeRaw) problems.push(`TRADING_MODE=${modeRaw} non valido: usa shadow, demo o live`);

  // --- Variabili legacy: non decidono più nulla ---
  if (read(env, 'LIVE_TRADING_ENABLED') !== undefined) {
    warnings.push('LIVE_TRADING_ENABLED è ignorata: la modalità si sceglie con TRADING_MODE (shadow | demo | live)');
  }
  if (read(env, 'KRAKEN_SANDBOX') !== undefined) {
    warnings.push('KRAKEN_SANDBOX è deprecata: l\'ambiente Kraken deriva da TRADING_MODE');
  }

  // --- Credenziali Kraken ---
  let credentials: KrakenCredentials | null = null;
  let tradingEnvironment: KrakenEnvironment | null = null;
  if (mode === 'demo') {
    tradingEnvironment = 'demo';
    const apiKey = read(env, 'KRAKEN_DEMO_API_KEY');
    const apiSecret = read(env, 'KRAKEN_DEMO_API_SECRET');
    if (apiKey && apiSecret) {
      credentials = { apiKey, apiSecret };
    } else if (read(env, 'KRAKEN_SANDBOX') === 'true' && read(env, 'KRAKEN_API_KEY') && read(env, 'KRAKEN_SECRET_KEY')) {
      credentials = { apiKey: read(env, 'KRAKEN_API_KEY')!, apiSecret: read(env, 'KRAKEN_SECRET_KEY')! };
      warnings.push('Uso le chiavi legacy KRAKEN_API_KEY/KRAKEN_SECRET_KEY come chiavi demo (KRAKEN_SANDBOX=true): rinominale in KRAKEN_DEMO_API_KEY/KRAKEN_DEMO_API_SECRET');
    } else {
      problems.push('TRADING_MODE=demo richiede KRAKEN_DEMO_API_KEY e KRAKEN_DEMO_API_SECRET (chiavi create su demo-futures.kraken.com)');
    }
  } else if (mode === 'live') {
    tradingEnvironment = 'production';
    const apiKey = read(env, 'KRAKEN_LIVE_API_KEY');
    const apiSecret = read(env, 'KRAKEN_LIVE_API_SECRET');
    if (apiKey && apiSecret) credentials = { apiKey, apiSecret };
    else problems.push('TRADING_MODE=live richiede KRAKEN_LIVE_API_KEY e KRAKEN_LIVE_API_SECRET (le chiavi legacy non sono accettate in live)');
    if (read(env, 'LIVE_TRADING_CONFIRM') !== LIVE_CONFIRM_PHRASE) {
      problems.push(`TRADING_MODE=live richiede LIVE_TRADING_CONFIRM=${LIVE_CONFIRM_PHRASE}`);
    }
  } else if (read(env, 'KRAKEN_API_KEY') || read(env, 'KRAKEN_LIVE_API_KEY') || read(env, 'KRAKEN_DEMO_API_KEY')) {
    warnings.push('Modalità shadow: le chiavi Kraken presenti non vengono usate (nessun ordine, nessuna chiamata privata)');
  }

  // --- Simboli ---
  const symbolsRaw = read(env, 'SYMBOLS');
  const symbols = symbolsRaw ? symbolsRaw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : [...DEFAULT_SYMBOLS];
  for (const s of symbols) if (!KRAKEN_NATIVE_SYMBOLS[s]) problems.push(`SYMBOLS: simbolo non supportato ${s}`);
  if (new Set(symbols).size !== symbols.length) problems.push('SYMBOLS contiene duplicati');
  if (symbols.length === 0) problems.push('SYMBOLS è vuoto');

  // --- Limiti di rischio ---
  const limits: RiskLimits = {
    capitalCapUsd: parseNumber(env, LIMIT_ENV.capitalCapUsd, DEFAULT_LIMITS.capitalCapUsd, problems, (n) => n > 0, 'deve essere > 0'),
    maxLeverage: parseNumber(env, LIMIT_ENV.maxLeverage, DEFAULT_LIMITS.maxLeverage, problems, (n) => n >= 1 && n <= 5, 'deve essere tra 1 e 5'),
    maxPositionNotionalUsd: parseNumber(env, LIMIT_ENV.maxPositionNotionalUsd, DEFAULT_LIMITS.maxPositionNotionalUsd, problems, (n) => n > 0, 'deve essere > 0'),
    maxOpenPositions: parseNumber(env, LIMIT_ENV.maxOpenPositions, Math.min(DEFAULT_LIMITS.maxOpenPositions, symbols.length || 1), problems, (n) => Number.isInteger(n) && n >= 1, 'deve essere un intero ≥ 1'),
    maxDailyLossPct: parseNumber(env, LIMIT_ENV.maxDailyLossPct, DEFAULT_LIMITS.maxDailyLossPct, problems, (n) => n > 0 && n < 100, 'deve essere tra 0 e 100 (esclusi)'),
    drawdownReduceOnlyPct: parseNumber(env, LIMIT_ENV.drawdownReduceOnlyPct, DEFAULT_LIMITS.drawdownReduceOnlyPct, problems, (n) => n > 0 && n < 100, 'deve essere tra 0 e 100 (esclusi)'),
  };
  if (mode === 'live') {
    const missing = Object.values(LIMIT_ENV).filter((key) => read(env, key) === undefined);
    if (missing.length) problems.push(`TRADING_MODE=live richiede limiti espliciti: manca ${missing.join(', ')}`);
  }

  // --- Modello di stop ---
  const stopModelRaw = read(env, 'STOP_MODEL') ?? 'close_based_plus_native_backstop';
  const stopModel: StopModel = stopModelRaw === 'native_intrabar' ? 'native_intrabar' : 'close_based_plus_native_backstop';
  if (stopModel !== stopModelRaw) problems.push(`STOP_MODEL=${stopModelRaw} non valido: usa close_based_plus_native_backstop o native_intrabar`);
  const backstopBufferPct = parseNumber(env, 'BACKSTOP_BUFFER_PCT', 3, problems, (n) => n > 0 && n <= 50, 'deve essere tra 0 e 50');

  // --- Alert ---
  const channelRaw = (read(env, 'ALERT_CHANNEL') ?? 'none').toLowerCase();
  const channel: AlertChannel = channelRaw === 'telegram' || channelRaw === 'webhook' || channelRaw === 'none' ? channelRaw : 'none';
  if (channel !== channelRaw) problems.push(`ALERT_CHANNEL=${channelRaw} non valido: usa none, telegram o webhook`);
  let telegram: EngineConfig['alerts']['telegram'] = null;
  let webhookUrl: string | null = null;
  if (channel === 'telegram') {
    const botToken = read(env, 'TELEGRAM_BOT_TOKEN');
    const chatId = read(env, 'TELEGRAM_CHAT_ID');
    if (botToken && chatId) telegram = { botToken, chatId };
    else problems.push('ALERT_CHANNEL=telegram richiede TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID');
  } else if (channel === 'webhook') {
    const url = read(env, 'ALERT_WEBHOOK_URL');
    if (url && /^https:\/\/\S+$/.test(url)) webhookUrl = url;
    else problems.push('ALERT_CHANNEL=webhook richiede ALERT_WEBHOOK_URL con https://');
  }
  if (mode === 'live' && channel === 'none') problems.push('TRADING_MODE=live richiede un canale di alert (ALERT_CHANNEL=telegram o webhook)');

  // --- Autenticazione API ---
  const adminToken = readToken(env, 'ADMIN_TOKEN', problems);
  const cronToken = readToken(env, 'CRON_TOKEN', problems);
  if (!adminToken && read(env, 'ADMIN_TOKEN') === undefined) {
    if (mode === 'live') problems.push('TRADING_MODE=live richiede ADMIN_TOKEN');
    else warnings.push('ADMIN_TOKEN non impostato: le API di controllo (start/stop/reset/stato) sono disabilitate');
  }
  if (!cronToken && read(env, 'CRON_TOKEN') === undefined) warnings.push('CRON_TOKEN non impostato: /api/cron/tick è disabilitato');

  const config: EngineConfig = {
    mode,
    ordersEnabled: mode !== 'shadow',
    kraken: { tradingEnvironment, credentials, marketDataEnvironment: 'production' },
    symbols,
    limits,
    stopModel,
    backstopBufferPct,
    alerts: { channel, telegram, webhookUrl },
    auth: { adminToken, cronToken },
    firebase: { serviceAccountJson: read(env, 'FIREBASE_SERVICE_ACCOUNT_JSON') ?? null },
    persistence: {
      dailyWriteBudget: parseNumber(env, 'FIRESTORE_DAILY_WRITE_BUDGET', 3_000, problems, (n) => Number.isInteger(n) && n >= 200, 'deve essere un intero ≥ 200'),
    },
  };
  if (problems.length > 0) throw new ConfigError(problems);
  return { config, warnings };
}

/** Riepilogo della configurazione senza segreti, da stampare all'avvio. */
export function describeConfig(config: EngineConfig): string {
  const l = config.limits;
  return [
    `modalità=${config.mode.toUpperCase()} ordini=${config.ordersEnabled ? 'SÌ' : 'NO'} ambiente Kraken=${config.kraken.tradingEnvironment ?? 'nessuno (solo dati pubblici)'}`,
    `simboli=${config.symbols.join(',')}`,
    `limiti: capitale ${l.capitalCapUsd}$, leva ≤ ${l.maxLeverage}x, nozionale ≤ ${l.maxPositionNotionalUsd}$, posizioni ≤ ${l.maxOpenPositions}, perdita giornaliera ≤ ${l.maxDailyLossPct}%, reduce-only da DD ${l.drawdownReduceOnlyPct}%`,
    `stop=${config.stopModel} (backstop ${config.backstopBufferPct}%) alert=${config.alerts.channel} admin=${config.auth.adminToken ? 'configurato' : 'disabilitato'} cron=${config.auth.cronToken ? 'configurato' : 'disabilitato'}`,
  ].join('\n');
}
