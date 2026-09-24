// Mercato sintetico deterministico per i test di parità su periodi lunghi (F2 Fase C).
//
// Il dataset reale disponibile copre meno di 12 mesi (vedi F0). Per verificare la parità
// backtest ↔ replay live su almeno 12 mesi si generano candele 15m con un seme fisso:
// - un fattore di mercato (BTC) con regimi a catena di Markov giornaliera: rialzo, ribasso,
//   laterale, crollo, euforia;
// - gli altri simboli seguono il fattore con un beta e aggiungono rumore e shock propri;
// - buchi nei dati: candele singole mancanti e un buco di oltre 4 ore (invalidazione del trade).
// NON serve a valutare la strategia (i prezzi non sono reali): serve solo a esercitare tutti i
// percorsi del core (EXTREME, NORMAL, backstop, buchi) e a confrontare backtest e replay.
import { BAR_15M_MS, type Candle } from '../data/dataset';
import { gaussian, hash32, mulberry32 } from '../util/prng';

type Regime = 'BULL' | 'BEAR' | 'CHOP' | 'CRASH' | 'EUPHORIA';

/** Deriva e volatilità giornaliere (log-rendimenti) per regime. */
const REGIMES: Record<Regime, { drift: number; vol: number; minDays: number; maxDays: number }> = {
  BULL: { drift: 0.006, vol: 0.03, minDays: 8, maxDays: 30 },
  BEAR: { drift: -0.006, vol: 0.035, minDays: 6, maxDays: 25 },
  CHOP: { drift: 0, vol: 0.02, minDays: 4, maxDays: 15 },
  CRASH: { drift: -0.08, vol: 0.09, minDays: 1, maxDays: 4 },
  EUPHORIA: { drift: 0.07, vol: 0.08, minDays: 1, maxDays: 3 },
};

const TRANSITIONS: Record<Regime, [Regime, number][]> = {
  BULL: [['BULL', 0.1], ['CHOP', 0.35], ['BEAR', 0.25], ['CRASH', 0.15], ['EUPHORIA', 0.15]],
  BEAR: [['BULL', 0.3], ['CHOP', 0.3], ['BEAR', 0.05], ['CRASH', 0.3], ['EUPHORIA', 0.05]],
  CHOP: [['BULL', 0.4], ['BEAR', 0.3], ['CRASH', 0.15], ['EUPHORIA', 0.15]],
  CRASH: [['BEAR', 0.3], ['CHOP', 0.4], ['BULL', 0.3]],
  EUPHORIA: [['BULL', 0.3], ['CHOP', 0.4], ['BEAR', 0.3]],
};

export interface SyntheticSymbol {
  symbol: string;
  startPrice: number;
  /** Esposizione al fattore di mercato. */
  beta: number;
  /** Volatilità giornaliera idiosincratica. */
  idioVol: number;
}

export const SYNTHETIC_SYMBOLS: SyntheticSymbol[] = [
  { symbol: 'BTC', startPrice: 30000, beta: 1, idioVol: 0 },
  { symbol: 'ETH', startPrice: 2000, beta: 1.15, idioVol: 0.012 },
  { symbol: 'SOL', startPrice: 60, beta: 1.5, idioVol: 0.02 },
  { symbol: 'AVAX', startPrice: 25, beta: 1.45, idioVol: 0.02 },
  { symbol: 'XRP', startPrice: 0.6, beta: 1.2, idioVol: 0.018 },
  { symbol: 'DOGE', startPrice: 0.12, beta: 1.6, idioVol: 0.025 },
  { symbol: 'LINK', startPrice: 12, beta: 1.35, idioVol: 0.02 },
  { symbol: 'ADA', startPrice: 0.5, beta: 1.3, idioVol: 0.018 },
];

export interface SyntheticOptions {
  seed: number;
  fromMs: number;
  toMs: number;
  symbols?: SyntheticSymbol[];
  /** Simboli con buchi nei dati (default XRP, come nei dati reali, e DOGE). */
  gapSymbols?: string[];
}

function pickNext(regime: Regime, rand: () => number): Regime {
  let x = rand();
  for (const [next, p] of TRANSITIONS[regime]) {
    x -= p;
    if (x < 0) return next;
  }
  return TRANSITIONS[regime][TRANSITIONS[regime].length - 1][0];
}

/** Candele 15m per ogni simbolo in [fromMs, toMs) (fromMs allineato a 15 minuti). */
export function generateSyntheticMarket(options: SyntheticOptions): Record<string, Candle[]> {
  if (options.fromMs % BAR_15M_MS !== 0) throw new Error('fromMs deve essere allineato a 15 minuti');
  const symbols = options.symbols ?? SYNTHETIC_SYMBOLS;
  const barsPerDay = (24 * 3_600_000) / BAR_15M_MS;
  const steps = Math.floor((options.toMs - options.fromMs) / BAR_15M_MS);
  const rand = mulberry32(options.seed);

  // 1. Fattore di mercato: log-rendimento per slot.
  const factor = new Float64Array(steps);
  let regime: Regime = 'BULL';
  let left = 0;
  for (let i = 0; i < steps; i++) {
    if (left <= 0) {
      regime = pickNext(regime, rand);
      const r = REGIMES[regime];
      left = (r.minDays + Math.floor(rand() * (r.maxDays - r.minDays + 1))) * barsPerDay;
    }
    const r = REGIMES[regime];
    factor[i] = r.drift / barsPerDay + (r.vol / Math.sqrt(barsPerDay)) * gaussian(rand);
    left--;
  }

  // 2. Simboli: beta × fattore + rumore proprio + rari shock propri (pump/dump di qualche ora).
  const out: Record<string, Candle[]> = {};
  const gapSymbols = options.gapSymbols ?? ['XRP', 'DOGE'];
  for (const s of symbols) {
    const r = mulberry32(hash32(`${options.seed}|${s.symbol}`));
    const idio = s.idioVol / Math.sqrt(barsPerDay);
    const candles: Candle[] = [];
    let close = s.startPrice;
    let shock = 0;
    let shockLeft = 0;
    for (let i = 0; i < steps; i++) {
      if (shockLeft <= 0 && s.beta !== 1 && r() < 1 / (barsPerDay * 25)) {
        shock = (r() < 0.5 ? -1 : 1) * (0.06 + r() * 0.1) / 16;
        shockLeft = 16;
      }
      const ret = s.beta * factor[i] + idio * gaussian(r) + (shockLeft-- > 0 ? shock : 0);
      const open = close;
      close = open * Math.exp(ret);
      const wick = Math.abs(ret) * 0.5 + (s.idioVol + 0.01) / Math.sqrt(barsPerDay) * Math.abs(gaussian(r)) * 0.6;
      const high = Math.max(open, close) * (1 + wick);
      const low = Math.min(open, close) * (1 - wick);
      const round = (x: number) => Number(x.toPrecision(8));
      candles.push({ t: options.fromMs + i * BAR_15M_MS, o: round(open), h: round(high), l: round(low), c: round(close), v: round(100 + r() * 1000) });
    }
    if (gapSymbols.includes(s.symbol)) {
      // Buchi: una candela ogni ~3 giorni, 2 ore (posizione "contaminata") ogni ~20 giorni e
      // 5 ore (oltre 240 minuti: trade invalidato) ogni ~10 giorni.
      const drop = new Set<number>();
      for (let i = barsPerDay * 2; i < steps; i += barsPerDay * 3 + Math.floor(r() * barsPerDay)) drop.add(i);
      for (let i = barsPerDay * 7; i < steps; i += barsPerDay * 20 + Math.floor(r() * barsPerDay)) for (let k = 0; k < 8; k++) drop.add(i + k);
      for (let i = barsPerDay * 5; i < steps; i += barsPerDay * 10 + Math.floor(r() * barsPerDay)) for (let k = 0; k < 20; k++) drop.add(i + k);
      out[s.symbol] = candles.filter((_, i) => !drop.has(i));
    } else {
      out[s.symbol] = candles;
    }
  }
  return out;
}

/** Dataset sintetico di riferimento per il gate di parità "almeno 12 mesi" (13 mesi di trading). */
export const SYNTHETIC_PARITY_WINDOW = {
  id: 'SYNTH-13M',
  seed: 2,
  start: '2023-01-01T00:00:00Z',
  end: '2024-01-31T23:45:00Z',
  warmupDays: 50,
  symbols: SYNTHETIC_SYMBOLS.map((s) => s.symbol),
} as const;

export function syntheticParityData(): Record<string, Candle[]> {
  const w = SYNTHETIC_PARITY_WINDOW;
  return generateSyntheticMarket({ seed: w.seed, fromMs: Date.parse(w.start) - w.warmupDays * 24 * 3_600_000, toMs: Date.parse(w.end) + BAR_15M_MS });
}
