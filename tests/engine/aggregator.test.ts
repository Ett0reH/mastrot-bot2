// Invariante I1: candele 1H/4H come bucket UTC di candele 15m chiuse, mai visibili prima della chiusura.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CandleAggregator, HOUR_MS, isHourCloseSlot } from '../../src/engine/core/aggregator';
import { BAR_15M_MS, type Candle } from '../../src/engine/data/dataset';

const T0 = Date.UTC(2024, 0, 1); // mezzanotte UTC
const candle = (i: number, base = 100): Candle => ({ t: T0 + i * BAR_15M_MS, o: base + i, h: base + i + 2, l: base + i - 2, c: base + i + 1, v: 1 });

test('la candela 1H non esiste prima della fine dell ora (niente look-ahead)', () => {
  const agg = new CandleAggregator();
  for (let i = 0; i < 4; i++) {
    agg.addCandle(candle(i));
    const { closed1H } = agg.closeUntil(T0 + (i + 1) * BAR_15M_MS);
    assert.equal(closed1H, i === 3, `slot ${i}`);
    assert.equal(agg.bars1H.length, i === 3 ? 1 : 0);
  }
  const bar = agg.bars1H[0];
  assert.deepEqual(bar, { t: new Date(T0).toISOString(), o: 100, h: 105, l: 98, c: 104, v: 4 });
});

test('la candela 4H copre il blocco UTC 00-04 e si chiude alle 04:00', () => {
  const agg = new CandleAggregator();
  let closes4H = 0;
  for (let i = 0; i < 20; i++) {
    agg.addCandle(candle(i));
    if (agg.closeUntil(T0 + (i + 1) * BAR_15M_MS).closed4H) {
      closes4H++;
      assert.equal(i, 15, 'la 4H si chiude sulla sedicesima 15m');
    }
  }
  assert.equal(closes4H, 1);
  assert.equal(agg.bars4H[0].t, new Date(T0).toISOString());
  assert.equal(agg.bars4H[0].o, 100);
  assert.equal(agg.bars4H[0].c, 116);
  assert.equal(agg.closed4HCount, 1);
});

test('con un buco la candela 1H contiene solo le 15m della sua ora (non unisce ore diverse)', () => {
  const agg = new CandleAggregator();
  // ora 00: manca la candela delle 00:45; ora 01: completa
  for (const i of [0, 1, 2, 4, 5, 6, 7]) {
    agg.addCandle(candle(i));
    agg.closeUntil(T0 + (i + 1) * BAR_15M_MS);
  }
  // l'ora 00 si chiude comunque alla fine dell'ora (lo slot delle 00:45 viene elaborato anche senza candela)
  assert.equal(agg.bars1H.length, 2);
  assert.equal(agg.bars1H[0].t, new Date(T0).toISOString());
  assert.equal(agg.bars1H[0].c, 103); // chiusura della 00:30
  assert.equal(agg.bars1H[1].t, new Date(T0 + HOUR_MS).toISOString());
  assert.equal(agg.bars1H[1].o, 104);
});

test('un ora senza candele non produce una candela 1H', () => {
  const agg = new CandleAggregator();
  for (const i of [0, 1, 2, 3, 8, 9, 10, 11]) {
    agg.addCandle(candle(i));
    agg.closeUntil(T0 + (i + 1) * BAR_15M_MS);
  }
  assert.deepEqual(agg.bars1H.map((b) => b.t), [new Date(T0).toISOString(), new Date(T0 + 2 * HOUR_MS).toISOString()]);
});

test('candele fuori ordine o duplicate vengono rifiutate', () => {
  const agg = new CandleAggregator();
  agg.addCandle(candle(1));
  assert.throws(() => agg.addCandle(candle(1)), /fuori ordine/);
  assert.throws(() => agg.addCandle(candle(0)), /fuori ordine/);
});

test('i bucket sono allineati a UTC indipendentemente dal fuso del processo', () => {
  assert.equal(isHourCloseSlot(T0 + 3 * BAR_15M_MS), true);
  assert.equal(isHourCloseSlot(T0 + 2 * BAR_15M_MS), false);
  const agg = new CandleAggregator();
  for (let i = 0; i < 8; i++) {
    agg.addCandle(candle(i));
    agg.closeUntil(T0 + (i + 1) * BAR_15M_MS);
  }
  for (const bar of agg.bars1H) assert.equal(Date.parse(bar.t) % HOUR_MS, 0);
});
