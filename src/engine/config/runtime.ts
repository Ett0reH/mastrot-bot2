// Configurazione caricata una sola volta dal processo, per il codice legacy (liveEngine.ts)
// che non riceve la configurazione per parametro. Il codice nuovo la riceve esplicitamente.
import { type EngineConfig, loadConfig } from './config';

let current: EngineConfig | null = null;

export function initRuntimeConfig(env: Record<string, string | undefined> = process.env): { config: EngineConfig; warnings: string[] } {
  const loaded = loadConfig(env);
  current = loaded.config;
  return loaded;
}

export function getRuntimeConfig(): EngineConfig {
  if (!current) current = loadConfig(process.env).config;
  return current;
}

/** Solo per i test. */
export function setRuntimeConfig(config: EngineConfig | null): void {
  current = config;
}

/** In shadow non si inviano ordini e non si chiamano endpoint privati di Kraken. */
export function ordersEnabled(): boolean {
  return getRuntimeConfig().ordersEnabled;
}

/** Opzioni per DerivativesClient di @siebly/kraken-api coerenti con la modalità. */
export function krakenClientOptions(config: EngineConfig = getRuntimeConfig()): {
  apiKey?: string;
  apiSecret?: string;
  testnet: boolean;
  strictParamValidation: boolean;
} {
  const creds = config.kraken.credentials;
  return {
    ...(creds ? { apiKey: creds.apiKey, apiSecret: creds.apiSecret } : {}),
    testnet: config.kraken.tradingEnvironment === 'demo',
    strictParamValidation: true,
  };
}
