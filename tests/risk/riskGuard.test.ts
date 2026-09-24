// RiskGuard (F5): un test per ogni limite della sezione 2, stati operativi, perdita giornaliera
// e drawdown.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_LIMITS, type RiskLimits } from '../../src/engine/config/config';
import type { CorePosition, OpenIntent } from '../../src/engine/core/types';
import { checkEntry, evaluateEquity, type GuardContext, type GuardResult } from '../../src/engine/risk/riskGuard';

const NOW = Date.parse('2022-01-22T10:01:00Z');
const LIMITS: RiskLimits = { ...DEFAULT_LIMITS };

function intent(overrides: Partial<OpenIntent> = {}): OpenIntent {
  return {
    kind: 'OPEN', symbol: 'SOL', slotTime: NOW - 16 * 60_000, positionId: `SOL-${overrides.slotTime ?? 0}`, direction: 'LONG', size: 2, leverage: 2,
    referencePrice: 100, stopLoss: 95, catastropheStopLoss: 90, backstop: 92, engine: 'EXTREME', setup: 'x', regime: 'CRASH', tierLabel: 't',
    quality: 1, isChopEntry: false, isReducedLeverageAction: false,
    ...overrides,
  };
}

function position(symbol: string, notional: number, leverage: number): CorePosition {
  return { id: `${symbol}-p`, symbol, trade: { size: notional / 100, entryPrice: 100, leverage } } as unknown as CorePosition;
}

function ctx(overrides: Partial<GuardContext> = {}): GuardContext {
  return { state: 'RUNNING', dailyLossBlockUntil: null, openPositions: [], approved: [], equity: 1000, now: NOW, ...overrides };
}

function code(r: GuardResult): string {
  return r.outcome === 'allowed' ? 'ALLOWED' : r.code;
}

test('ingresso entro tutti i limiti: consentito', () => {
  assert.equal(code(checkEntry(intent(), ctx(), LIMITS)), 'ALLOWED');
});

test('MAX_LEVERAGE: conta la leva isolated impostata su Kraken (intero superiore)', () => {
  assert.equal(code(checkEntry(intent({ leverage: 3 }), ctx(), LIMITS)), 'ALLOWED');
  assert.equal(code(checkEntry(intent({ leverage: 3.2 }), ctx(), LIMITS)), 'MAX_LEVERAGE', '3,2x diventa 4x su Kraken');
  assert.equal(code(checkEntry(intent({ leverage: 1.3 }), ctx(), { ...LIMITS, maxLeverage: 1.5 })), 'MAX_LEVERAGE', '1,3x diventa 2x su Kraken');
  assert.equal(code(checkEntry(intent({ leverage: 1 }), ctx(), { ...LIMITS, maxLeverage: 1 })), 'ALLOWED');
  for (const bad of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) assert.equal(code(checkEntry(intent({ leverage: bad }), ctx(), LIMITS)), 'MAX_LEVERAGE', `leva ${bad}`);
});

test('MAX_NOTIONAL: nozionale della posizione oltre il limite (e valori non finiti) rifiutato', () => {
  assert.equal(code(checkEntry(intent({ size: 10, referencePrice: 100 }), ctx({ equity: 10_000 }), LIMITS)), 'ALLOWED', '1.000 $ esatti');
  assert.equal(code(checkEntry(intent({ size: 10.01, referencePrice: 100 }), ctx({ equity: 10_000 }), LIMITS)), 'MAX_NOTIONAL');
  assert.equal(code(checkEntry(intent({ size: Number.NaN }), ctx(), LIMITS)), 'MAX_NOTIONAL');
  assert.equal(code(checkEntry(intent({ referencePrice: Number.POSITIVE_INFINITY }), ctx(), LIMITS)), 'MAX_NOTIONAL');
});

test('MAX_OPEN_POSITIONS: contano le posizioni aperte e gli ingressi già approvati nello stesso ciclo', () => {
  const limits = { ...LIMITS, maxOpenPositions: 3 };
  const open = [position('BTC', 100, 1), position('ETH', 100, 1)];
  assert.equal(code(checkEntry(intent(), ctx({ openPositions: open, equity: 10_000 }), limits)), 'ALLOWED');
  assert.equal(code(checkEntry(intent(), ctx({ openPositions: open, approved: [intent({ symbol: 'XRP' })], equity: 10_000 }), limits)), 'MAX_OPEN_POSITIONS');
});

test('CAPITAL: il margine totale non supera l equity del bot', () => {
  // Margini: 400 + 300 (aperte) + 150 (approvato) = 850; il nuovo ne chiede 100 → 950 ≤ 1.000.
  const open = [position('BTC', 800, 2), position('ETH', 600, 2)];
  const approved = [intent({ symbol: 'XRP', size: 3, leverage: 2 })];
  assert.equal(code(checkEntry(intent(), ctx({ openPositions: open, approved }), LIMITS)), 'ALLOWED');
  assert.equal(code(checkEntry(intent({ size: 3.1, leverage: 2 }), ctx({ openPositions: open, approved }), LIMITS)), 'CAPITAL', '850 + 155 > 1.000');
  assert.equal(code(checkEntry(intent(), ctx({ openPositions: open, approved, equity: 900 }), LIMITS)), 'CAPITAL', 'equity scesa (o collateral ridotto)');
  assert.equal(code(checkEntry(intent(), ctx({ equity: Number.NaN }), LIMITS)), 'CAPITAL', 'equity sconosciuta: nessun ingresso');
});

test('DAILY_LOSS: ingressi bloccati fino all istante indicato, poi di nuovo consentiti', () => {
  const until = Date.parse('2022-01-23T00:00:00Z');
  assert.equal(code(checkEntry(intent(), ctx({ dailyLossBlockUntil: until }), LIMITS)), 'DAILY_LOSS');
  assert.equal(code(checkEntry(intent(), ctx({ dailyLossBlockUntil: until, now: until }), LIMITS)), 'ALLOWED');
});

test('stati operativi: REDUCE_ONLY, HALTING e HALTED rifiutano ogni ingresso, prima di ogni altro controllo', () => {
  assert.equal(code(checkEntry(intent(), ctx({ state: 'REDUCE_ONLY' }), LIMITS)), 'REDUCE_ONLY');
  assert.equal(code(checkEntry(intent(), ctx({ state: 'HALTING' }), LIMITS)), 'HALTED');
  assert.equal(code(checkEntry(intent({ leverage: 9 }), ctx({ state: 'HALTED' }), LIMITS)), 'HALTED');
});

test('perdita giornaliera: riferimento alla prima equity del giorno UTC, blocco fino alla mezzanotte successiva', () => {
  const day = Date.parse('2022-01-22T00:01:00Z');
  let e = evaluateEquity({ dayStart: null }, { trueEquity: 1000, maxHistoricalEquity: 1000 }, day, LIMITS);
  assert.deepEqual(e.dayStart, { day: '2022-01-22', equity: 1000 });
  e = evaluateEquity({ dayStart: e.dayStart }, { trueEquity: 951, maxHistoricalEquity: 1000 }, day + 5 * 3_600_000, LIMITS);
  assert.equal(e.dailyLossBlockUntil, null, '4,9%: sotto il limite');
  e = evaluateEquity({ dayStart: e.dayStart }, { trueEquity: 950, maxHistoricalEquity: 1000 }, day + 6 * 3_600_000, LIMITS);
  assert.equal(e.dailyLossBlockUntil, Date.parse('2022-01-23T00:00:00Z'), '5%: blocco fino a mezzanotte UTC');
  e = evaluateEquity({ dayStart: e.dayStart }, { trueEquity: 950, maxHistoricalEquity: 1000 }, Date.parse('2022-01-23T00:01:00Z'), LIMITS);
  assert.deepEqual(e.dayStart, { day: '2022-01-23', equity: 950 }, 'nuovo giorno: nuovo riferimento');
  assert.equal(e.dailyLossBlockUntil, null);
});

test('drawdown: oltre la soglia dal massimo segnala il passaggio a REDUCE_ONLY', () => {
  assert.equal(evaluateEquity({ dayStart: null }, { trueEquity: 851, maxHistoricalEquity: 1000 }, NOW, LIMITS).drawdownBreached, false);
  assert.equal(evaluateEquity({ dayStart: null }, { trueEquity: 850, maxHistoricalEquity: 1000 }, NOW, LIMITS).drawdownBreached, true);
});
