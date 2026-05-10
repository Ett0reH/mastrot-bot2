import { MarketDataLayer, RegimeLayer, SignalLayer } from '../../../src/server/core/architecture';
import * as assert from 'assert';

function testMarketDataLayerErrorsOnNotEnoughData() {
    console.log("Running testMarketDataLayerErrorsOnNotEnoughData...");
    
    // Feature 1H usano < 200 candele -> throw
    const bars1H = Array.from({length: 199}, (_, i) => ({ t: Date.now() - i*3600*1000, o: 100, h: 110, l: 90, c: 100, v: 1000 }));
    const bars4H = Array.from({length: 200}, (_, i) => ({ t: Date.now() - i*4*3600*1000, o: 100, h: 110, l: 90, c: 100, v: 1000 }));
    
    try {
        MarketDataLayer.prepareFeatures(bars1H, bars4H, true);
        assert.fail("Should have thrown error for insufficient 1H bars");
    } catch(e: any) {
        assert.ok(e.message.includes('Insufficient data'), "Error message should mention insufficient data");
    }
    
    const bars1H_2 = Array.from({length: 200}, (_, i) => ({ t: Date.now() - i*3600*1000, o: 100, h: 110, l: 90, c: 100, v: 1000 }));
    const bars4H_2 = Array.from({length: 199}, (_, i) => ({ t: Date.now() - i*4*3600*1000, o: 100, h: 110, l: 90, c: 100, v: 1000 }));
    
    try {
        MarketDataLayer.prepareFeatures(bars1H_2, bars4H_2, true);
        assert.fail("Should have thrown error for insufficient 4H bars");
    } catch(e: any) {
        assert.ok(e.message.includes('Insufficient data'), "Error message should mention insufficient data");
    }
    
    console.log("PASS: testMarketDataLayerErrorsOnNotEnoughData");
}

function filterClosedCandles(candles: any[], timeframe: string, nowMs: number) {
    if (candles.length === 0) return candles;
    const last = candles[candles.length - 1];
    const lastTimeMs = new Date(last.t).getTime();
    
    let durationMs = 3600 * 1000;
    if (timeframe === '4h') durationMs = 4 * 3600 * 1000;

    if (nowMs < lastTimeMs + durationMs) {
        return candles.slice(0, -1);
    }
    return candles;
}

function testFilterClosedCandles() {
    console.log("Running testFilterClosedCandles...");
    const baseTime = new Date('2026-05-10T10:00:00Z').getTime();
    
    const candles1H = [
        { t: baseTime - 3600000 * 2, c: 100 }, // 08:00
        { t: baseTime - 3600000, c: 100 },     // 09:00
        { t: baseTime, c: 100 }                // 10:00
    ];
    
    // Check at 10:45 (not closed yet)
    let valid = filterClosedCandles(candles1H, '1h', baseTime + 45 * 60000);
    assert.strictEqual(valid.length, 2, "Should drop the 10:00 candle at 10:45");
    assert.strictEqual(valid[valid.length-1].t, baseTime - 3600000, "Last closed candle is 09:00");
    
    // Check at 11:00 (exact boundary)
    valid = filterClosedCandles(candles1H, '1h', baseTime + 60 * 60000);
    assert.strictEqual(valid.length, 3, "Should include the 10:00 candle at 11:00");
    
    const candles4H = [
        { t: baseTime - 4*3600000, c: 100 }, // 06:00
        { t: baseTime, c: 100 }              // 10:00
    ];
    
    // Check at 11:00 (not closed yet)
    valid = filterClosedCandles(candles4H, '4h', baseTime + 3600000);
    assert.strictEqual(valid.length, 1, "Should drop the 10:00 candle at 11:00");
    
    // Check at 14:00 (closed)
    valid = filterClosedCandles(candles4H, '4h', baseTime + 4*3600000);
    assert.strictEqual(valid.length, 2, "Should include the 10:00 candle at 14:00");
    
    console.log("PASS: testFilterClosedCandles");
}

function runAll() {
    try {
        testMarketDataLayerErrorsOnNotEnoughData();
        testFilterClosedCandles();
    } catch(e) {
        console.error("FAIL:", e);
        process.exit(1);
    }
}

runAll();
