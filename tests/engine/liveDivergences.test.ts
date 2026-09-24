// F2 Fase C: le divergenze tra live legacy e backtest (D09-D15) non esistono nel DecisionCore,
// che è l'unico codice decisionale per backtest, replay e live.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExpectancyTracker, MarketDataLayer, type SetupMetrics } from '../../src/server/core/architecture';
import { loadBacktestData, runBacktest } from '../../src/engine/backtest/runner';
import { REALISTIC_PROFILE } from '../../src/engine/backtest/profiles';
import { DecisionCore, type EntryInput, FEATURE_WINDOW, decideEntry, type SlotResult } from '../../src/engine/core/decisionCore';
import type { CloseIntent, CorePosition, OpenIntent } from '../../src/engine/core/types';
import { BAR_15M_MS, type Candle } from '../../src/engine/data/dataset';
import { GOLDEN_WINDOWS } from '../../scripts/golden/windows';

const W2022 = GOLDEN_WINDOWS.find((w) => w.id === '2022H1')!;
const W2026 = GOLDEN_WINDOWS.find((w) => w.id === '2026Q2')!;
const baseConfig = (w: typeof W2022) => ({
  symbols: w.symbols,
  start: w.start,
  end: w.end,
  warmupDays: 50,
  initialEquity: 10000,
  execution: REALISTIC_PROFILE.execution,
  backstop: REALISTIC_PROFILE.backstop,
  funding: REALISTIC_PROFILE.funding,
});

/** Core portato fino allo slot indicato sui dati reali (warm-up dal `fromMs`), con il risultato dello slot. */
function coreAt(slotIso: string, fromMs?: number): { core: DecisionCore; res: SlotResult } {
  const data = loadBacktestData(baseConfig(W2022));
  const core = new DecisionCore({ symbols: W2022.symbols, initialEquity: 10000, feeRate: 0.0005, backstop: REALISTIC_PROFILE.backstop });
  const slotMs = Date.parse(slotIso);
  const maps = Object.fromEntries(W2022.symbols.map((s) => [s, new Map(data[s].map((c) => [c.t, c]))]));
  const first = fromMs ?? Math.min(...W2022.symbols.map((s) => data[s][0].t));
  const candlesAt = (t: number) => Object.fromEntries(W2022.symbols.map((s) => [s, maps[s].get(t)]));
  for (let t = first; t < slotMs; t += BAR_15M_MS) core.processSlot(t, candlesAt(t), { warmupOnly: true });
  return { core, res: core.processSlot(slotMs, candlesAt(slotMs)) };
}

// SOL apre una EXTREME MEAN_REVERSION LONG in regime CRASH alle 01:45 del 21/01/2022 (golden).
const SOL_EXTREME_SLOT = '2022-01-21T01:45:00.000Z';
// AVAX apre una NORMAL alle 19:45 del 02/01/2022, chiusura 4H (golden, tier NORMAL_5).
const AVAX_NORMAL_SLOT = '2022-01-02T19:45:00.000Z';

function entryInput(core: DecisionCore, res: SlotResult, symbol: string, overrides: Partial<EntryInput> = {}): EntryInput {
  const snapshot = res.snapshots[symbol];
  const btc = res.snapshots.BTC;
  assert.ok(snapshot && btc && res.equity);
  return {
    slotTime: res.equity.slotTime,
    symbol,
    snapshot,
    btc: { trend1H: btc.features.trend1H, regime: btc.regime },
    capital: { trueEquity: 10000, isHalted: false, capacityMultiplier: 1 },
    normalCooldownActive: false,
    gapMinutes: 15,
    cleanProfitFactor: 1,
    backstopLevel: (d, s) => core.backstopLevel(d, s),
    ...overrides,
  };
}

test('D09: i tier di rischio si applicano come nel backtest, compreso il blocco di TRANSITION', () => {
  ExpectancyTracker.loadMatrix({});
  const { core, res } = coreAt(SOL_EXTREME_SLOT);
  const input = entryInput(core, res, 'SOL');
  const open = decideEntry(input);
  assert.equal(open.record.action, 'OPEN');
  assert.equal(open.intent?.tierLabel, 'EXTREME_10');
  // Stesso segnale EXTREME (ereditato dal CRASH di BTC) ma regime locale TRANSITION: bloccato dal tier.
  const transition = decideEntry({ ...input, snapshot: { ...input.snapshot, regime: 'TRANSITION' }, btc: { ...input.btc, regime: 'CRASH' } });
  assert.equal(transition.record.action, 'TIER_BLOCKED');
  assert.match(transition.record.reason, /TRANSITION/);
  assert.equal(transition.intent, null);
});

test('D09: il tier NORMAL dipende dal profit factor dei NORMAL chiusi (stato del core)', () => {
  ExpectancyTracker.loadMatrix({});
  const { core, res } = coreAt(AVAX_NORMAL_SLOT);
  const at = (cleanProfitFactor: number) => decideEntry(entryInput(core, res, 'AVAX', { cleanProfitFactor })).intent;
  const base = at(1.0);
  const down = at(0.5);
  const up = at(1.5);
  assert.ok(base && down && up);
  assert.equal(base.tierLabel, 'NORMAL_5');
  assert.equal(down.tierLabel, 'NORMAL_DOWNGRADED');
  assert.equal(up.tierLabel, 'NORMAL_UPGRADED');
  assert.ok(down.size < base.size && base.size < up.size, 'la size segue l esposizione del tier');
  // In cooldown (nessuna 4H chiusa dopo l'ultima uscita) il NORMAL non entra.
  const cooldown = decideEntry(entryInput(core, res, 'AVAX', { normalCooldownActive: true }));
  assert.equal(cooldown.record.action, 'COOLDOWN');
});

test('D10/I15: il trade aperto non ha take profit né entryTime (niente uscite a 3R, niente Date.now())', () => {
  ExpectancyTracker.loadMatrix({});
  const { core, res } = coreAt(SOL_EXTREME_SLOT);
  const open = res.intents.find((i): i is OpenIntent => i.kind === 'OPEN' && i.symbol === 'SOL');
  assert.ok(open, 'il core apre SOL come nel golden');
  assert.ok(!Object.keys(open).some((k) => /take.?profit/i.test(k)));
  core.applyFill({ kind: 'OPEN', symbol: 'SOL', positionId: open.positionId, price: open.referencePrice, size: open.size, fee: 0, time: open.slotTime, source: 'sim' });
  const trade = core.state.positions.SOL!.trade;
  // PositionExitLayer esce a TAKE_PROFIT solo se trade.takeProfit è valorizzato e calcola
  // barsHeld con Date.now() se trade.entryTime è valorizzato: nel core non lo sono mai.
  assert.equal(trade.takeProfit, undefined);
  assert.equal(trade.entryTime, undefined);
});

test('D10: nel backtest realistico nessuna uscita è un take profit', () => {
  const result = runBacktest({ ...baseConfig(W2022), collectJournal: true });
  assert.ok(result.trades.length > 0);
  assert.ok(result.trades.every((t) => t.reason !== 'TAKE_PROFIT'));
  assert.ok(result.intents.filter((i) => i.kind === 'OPEN').length >= result.trades.length);
});

test('D11: le uscite usano feature e prezzo del simbolo, non quelli di BTC', () => {
  const T0 = Date.UTC(2024, 0, 1);
  const flat = (i: number, price: number): Candle => ({ t: T0 + i * BAR_15M_MS, o: price, h: price * 1.001, l: price * 0.999, c: price, v: 1 });
  const core = new DecisionCore({ symbols: ['BTC', 'ETH'], initialEquity: 10000, feeRate: 0.0005, backstop: { model: 'close_based_plus_native_backstop', bufferPct: 3 } });
  let i = 0;
  for (; i < FEATURE_WINDOW * 16 + 8; i++) core.processSlot(T0 + i * BAR_15M_MS, { BTC: flat(i, 100), ETH: flat(i, 50) });
  const position = (symbol: string, entry: number, stop: number): CorePosition => ({
    id: `${symbol}-test`, symbol, entryTime: new Date(T0).toISOString(), entrySlot: T0,
    trade: {
      id: new Date(T0).toISOString(), symbol: `${symbol}/USD:USD`, direction: 'LONG', entryPrice: entry, size: 1, leverage: 2,
      stopLoss: stop, initialStopLoss: stop, currentStopLoss: stop, catastropheStopLoss: stop * 0.8, highWaterMark: entry, lowWaterMark: entry,
      barsHeld: 1, entryRegime: 'BULL', setup: 'RSI2_TREND_TRAILING', engine: 'NORMAL',
    },
    entryFee: 0, fundingPaid: 0, tierLabel: 'NORMAL_5', isChopEntry: false, isReducedLeverageAction: false, quality: 0.9, backstop: null,
  });
  // Stesso ingresso (60) e stesso stop (55): il trailing NORMAL al 2% dal massimo tiene BTC
  // (prezzo 100) e chiude ETH (prezzo 50). Con le feature di BTC anche ETH resterebbe aperta.
  core.state.positions.BTC = position('BTC', 60, 55);
  core.state.positions.ETH = position('ETH', 60, 55);
  let res: SlotResult;
  do {
    res = core.processSlot(T0 + i * BAR_15M_MS, { BTC: flat(i, 100), ETH: flat(i, 50) });
    i++;
  } while (!res.hourClose);
  const closes = res.intents.filter((x): x is CloseIntent => x.kind === 'CLOSE');
  assert.deepEqual(closes.map((c) => [c.symbol, c.referencePrice, c.exitType]), [['ETH', 50, 'TRAILING_STOP']]);
  assert.ok(core.state.positions.BTC, 'BTC resta aperta: il suo prezzo è sopra lo stop');
});

test('D12: matrice expectancy vuota come nel backtest (rischio ×0,5) ed esplicita per ogni core', () => {
  const disabled: SetupMetrics = { trades: 100, netPnL: -1, grossProfit: 1, grossLoss: -2, profitFactor: 0.5, expectancy: -1, winRate: 0.3, sampleSize: 100, averageWin: 1, averageLoss: -1 };
  const regimes = ['BULL', 'BEAR', 'CRASH', 'EUPHORIA', 'TRANSITION', 'UNKNOWN'];
  const setups = ['MEAN_REVERSION', 'RSI2_TREND_TRAILING'];
  const matrix: Record<string, SetupMetrics> = {};
  for (const s of W2026.symbols) for (const r of regimes) for (const st of setups) matrix[`${s}/USD:USD_${r}_${st}`] = disabled;
  const config = baseConfig(W2026);
  const data = loadBacktestData(config);
  const plain = runBacktest(config, data);
  const blocked = runBacktest({ ...config, expectancyMatrix: matrix, collectJournal: true }, data);
  const plainAgain = runBacktest(config, data);
  assert.ok(plain.trades.length > 0);
  assert.equal(blocked.trades.length, 0);
  assert.ok(blocked.journal.some((j) => j.action === 'BLOCKED' && j.reason === 'EXPECTANCY_DISABLED'));
  assert.equal(plainAgain.trades.length, plain.trades.length, 'la matrice di un core non resta caricata per gli altri');
  assert.equal(plainAgain.finalEquity, plain.finalEquity);
  // Con la matrice vuota il Gatekeeper dimezza il rischio: raddoppiando il modificatore
  // (matrice "high confidence" ×1,5 = 3 volte 0,5) la size cresce.
  ExpectancyTracker.loadMatrix({});
  const { core, res } = coreAt(SOL_EXTREME_SLOT);
  const empty = decideEntry(entryInput(core, res, 'SOL')).intent;
  ExpectancyTracker.loadMatrix({ 'SOL/USD:USD_CRASH_MEAN_REVERSION': { ...disabled, trades: 100, expectancy: 1, profitFactor: 2, winRate: 0.7, netPnL: 100 } });
  const confident = decideEntry(entryInput(core, res, 'SOL')).intent;
  ExpectancyTracker.loadMatrix({});
  assert.ok(empty && confident);
  assert.ok(confident.size > empty.size, `size con matrice vuota ${empty.size} vs matrice favorevole ${confident.size}`);
});

test('D13/I4: la leva decisa all ingresso non cambia fino alla chiusura', () => {
  const result = runBacktest({ ...baseConfig(W2022), collectJournal: true });
  const opens = new Map(result.intents.filter((i): i is OpenIntent => i.kind === 'OPEN').map((o) => [`${o.symbol}/USD:USD|${new Date(o.slotTime).toISOString()}`, o]));
  assert.ok(result.trades.length > 40);
  for (const t of result.trades) {
    const open = opens.get(`${t.symbol}|${t.entryTime}`);
    assert.ok(open, `intento di apertura per ${t.symbol} ${t.entryTime}`);
    assert.equal(t.leverage, open.leverage, `${t.symbol} ${t.entryTime}`);
  }
  // Gli aggiornamenti dello stop non portano la leva: l'esecuzione non può cambiarla.
  assert.ok(result.intents.filter((i) => i.kind === 'UPDATE_STOP').every((u) => !('leverage' in u)));
});

test('D14: HWM, trailing e stop si aggiornano solo alla chiusura oraria; il backstop resta oltre lo stop', () => {
  const T0 = Date.UTC(2024, 0, 1);
  const candle = (i: number, price: number, high = price * 1.001): Candle => ({ t: T0 + i * BAR_15M_MS, o: price, h: high, l: price * 0.999, c: price, v: 1 });
  const core = new DecisionCore({ symbols: ['BTC'], initialEquity: 10000, feeRate: 0.0005, backstop: { model: 'close_based_plus_native_backstop', bufferPct: 3 } });
  let i = 0;
  for (; i < FEATURE_WINDOW * 16; i++) core.processSlot(T0 + i * BAR_15M_MS, { BTC: candle(i, 100) });
  assert.equal((T0 + i * BAR_15M_MS) % 3_600_000, 0, 'si parte dall inizio di un ora');
  core.state.positions.BTC = {
    id: 'BTC-test', symbol: 'BTC', entryTime: new Date(T0).toISOString(), entrySlot: T0,
    trade: {
      id: new Date(T0).toISOString(), symbol: 'BTC/USD:USD', direction: 'LONG', entryPrice: 100, size: 1, leverage: 2,
      stopLoss: 95, initialStopLoss: 95, currentStopLoss: 95, catastropheStopLoss: 85, highWaterMark: 100, lowWaterMark: 100,
      barsHeld: 1, entryRegime: 'BULL', setup: 'RSI2_TREND_TRAILING', engine: 'NORMAL',
    },
    entryFee: 0, fundingPaid: 0, tierLabel: 'NORMAL_5', isChopEntry: false, isReducedLeverageAction: false, quality: 0.9, backstop: 95 * 0.97,
  };
  const before = structuredClone(core.state.positions.BTC.trade);
  // Tre candele 15m con massimi in forte rialzo (spike intrabar): nessun effetto sulla posizione.
  for (let k = 0; k < 3; k++, i++) {
    const res = core.processSlot(T0 + i * BAR_15M_MS, { BTC: candle(i, 104, 130) });
    assert.equal(res.hourClose, false);
    assert.deepEqual(res.intents, []);
    assert.deepEqual(core.state.positions.BTC.trade, before);
  }
  const res = core.processSlot(T0 + i * BAR_15M_MS, { BTC: candle(i, 105, 130) });
  assert.equal(res.hourClose, true);
  const trade = core.state.positions.BTC!.trade;
  assert.equal(trade.highWaterMark, 105, 'il massimo è la chiusura 1H, non lo spike intrabar');
  assert.equal(trade.currentStopLoss, 105 * (1 - 0.02));
  const update = res.intents.find((x) => x.kind === 'UPDATE_STOP');
  assert.ok(update && update.kind === 'UPDATE_STOP');
  assert.equal(update.backstop, trade.currentStopLoss * (1 - 3 / 100));
});

test('D15: le feature usano sempre e solo le ultime 250 candele 1H/4H', () => {
  // Due core con storico diverso (dal primo dato disponibile / solo 45 giorni): stesse feature.
  const slot = '2022-01-01T10:45:00.000Z'; // chiusura 1H, non 4H
  const long = coreAt(slot);
  const short = coreAt(slot, Date.parse(slot) - 45 * 24 * 3_600_000);
  assert.ok(long.core.aggregators.BTC.bars1H.length > short.core.aggregators.BTC.bars1H.length || long.core.aggregators.BTC.bars4H.length > short.core.aggregators.BTC.bars4H.length);
  for (const s of W2022.symbols) {
    const a = long.res.snapshots[s];
    const b = short.res.snapshots[s];
    assert.ok(a && b, `snapshot ${s}`);
    assert.deepEqual(a, b, `feature di ${s}`);
    const agg = long.core.aggregators[s];
    assert.deepEqual(a.features, MarketDataLayer.prepareFeatures(agg.bars1H.slice(-FEATURE_WINDOW), agg.bars4H.slice(-FEATURE_WINDOW), false));
  }
});
