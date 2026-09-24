// Specifiche dei contratti lette da Kraken (getInstruments), mai scritte nel codice (D19).
//
// Campi usati (FuturesInstrument di @siebly/kraken-api, endpoint derivatives/api/v3/instruments):
//   symbol, tradeable, tickSize (passo del prezzo), contractValueTradePrecision (decimali della
//   size: 4 → passo 0,0001; può essere negativo: -1 → passo 10), maxPositionSize.
// Un campo mancante o non valido per un simbolo usato dal bot è un errore, non un default.
import type { FuturesInstrument } from '@siebly/kraken-api';

export interface InstrumentSpec {
  symbol: string;
  tradeable: boolean;
  tickSize: number;
  sizeDecimals: number;
  sizeStep: number;
  maxPositionSize: number | null;
}

export class InstrumentError extends Error {}

function decimalsOf(value: number): number {
  const text = value.toString();
  if (text.includes('e-')) return Number(text.split('e-')[1]);
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

export function toSpec(raw: FuturesInstrument): InstrumentSpec {
  const { symbol, tickSize, contractValueTradePrecision: precision } = raw;
  if (typeof tickSize !== 'number' || !(tickSize > 0)) throw new InstrumentError(`${symbol}: tickSize mancante o non valido`);
  if (typeof precision !== 'number' || !Number.isInteger(precision)) throw new InstrumentError(`${symbol}: contractValueTradePrecision mancante o non valido`);
  return {
    symbol,
    tradeable: raw.tradeable === true,
    tickSize,
    sizeDecimals: precision,
    // 10 ** -4 in virgola mobile vale 0,0000999…: il passo si costruisce dalla forma decimale.
    sizeStep: precision >= 0 ? Number(`1e-${precision}`) : 10 ** -precision,
    maxPositionSize: typeof raw.maxPositionSize === 'number' && raw.maxPositionSize > 0 ? raw.maxPositionSize : null,
  };
}

/** Arrotonda al tick: 'down' / 'up' verso il basso / l'alto. Senza errori di virgola mobile. */
export function roundToTick(price: number, tickSize: number, mode: 'down' | 'up'): number {
  if (!(price > 0)) throw new InstrumentError(`Prezzo non valido: ${price}`);
  const decimals = decimalsOf(tickSize);
  const ratio = price / tickSize;
  const nearest = Math.round(ratio);
  // Un prezzo già multiplo del tick (a meno dell'errore di virgola mobile) resta invariato.
  const steps = Math.abs(ratio - nearest) < 1e-9 ? nearest : mode === 'down' ? Math.floor(ratio) : Math.ceil(ratio);
  return Number((steps * tickSize).toFixed(decimals));
}

/** Size arrotondata per difetto al passo del contratto. */
export function floorToStep(size: number, spec: InstrumentSpec): number {
  if (!(size > 0)) return 0;
  const ratio = size / spec.sizeStep;
  const nearest = Math.round(ratio);
  const steps = Math.abs(ratio - nearest) < 1e-9 ? nearest : Math.floor(ratio);
  return Number((steps * spec.sizeStep).toFixed(Math.max(0, spec.sizeDecimals)));
}

export class InstrumentRegistry {
  private specs = new Map<string, InstrumentSpec>();
  private loadedAt: number | null = null;

  constructor(
    private readonly load: () => Promise<FuturesInstrument[]>,
    private readonly now: () => number,
    private readonly ttlMs = 6 * 3_600_000,
  ) {}

  async refresh(): Promise<void> {
    const specs = new Map<string, InstrumentSpec>();
    const errors: string[] = [];
    for (const raw of await this.load()) {
      if (typeof raw?.symbol !== 'string') continue;
      try {
        specs.set(raw.symbol, toSpec(raw));
      } catch (err) {
        // Contratti non usati dal bot possono avere campi assenti: l'errore emerge se servono.
        errors.push((err as Error).message);
      }
    }
    if (specs.size === 0) throw new InstrumentError(`Nessuno strumento valido da Kraken${errors.length ? `: ${errors.slice(0, 3).join('; ')}` : ''}`);
    this.specs = specs;
    this.loadedAt = this.now();
  }

  /** Specifica di un contratto tradabile; ricarica la cache se scaduta. */
  async get(symbol: string): Promise<InstrumentSpec> {
    if (this.loadedAt === null || this.now() - this.loadedAt > this.ttlMs) await this.refresh();
    const spec = this.specs.get(symbol);
    if (!spec) throw new InstrumentError(`Contratto sconosciuto o con specifiche non valide: ${symbol}`);
    if (!spec.tradeable) throw new InstrumentError(`Contratto non tradabile: ${symbol}`);
    return spec;
  }

  /** Verifica all'avvio che tutti i contratti del bot esistano e siano tradabili. */
  async requireAll(symbols: readonly string[]): Promise<InstrumentSpec[]> {
    await this.refresh();
    return Promise.all(symbols.map((s) => this.get(s)));
  }
}
