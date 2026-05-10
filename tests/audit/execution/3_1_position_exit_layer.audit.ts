import { PositionExitLayer, ActiveTrade, MarketDataLayer, FEATURE_FLAGS } from '../../../src/server/core/architecture';
import * as assert from 'assert';

function createDummyTrade(overrides: any = {}): ActiveTrade {
    return {
        id: "TEST-1",
        symbol: "TEST",
        direction: "LONG",
        entryPrice: 100,
        size: 1,
        leverage: 2,
        initialStopLoss: 90,
        currentStopLoss: 90,
        catastropheStopLoss: 85,
        takeProfit: 130,
        highWaterMark: 100,
        lowWaterMark: 100,
        barsHeld: 0,
        entryRegime: "BULL",
        engine: "NORMAL",
        ...overrides
    } as ActiveTrade;
}

function testExitLayer() {
    console.log("Running testExitLayer...");

    // 1. Edge Decay: Bars Held updates correctly (new Closed candle)
    let trade = createDummyTrade();
    let features: any = { price: 105 }; 
    let res = PositionExitLayer.monitorAndExit(trade, features, "BULL", true);
    assert.strictEqual(trade.barsHeld, 1);
    assert.strictEqual(trade.highWaterMark, 105);
    
    // 2. MFE Update
    assert.strictEqual(trade.mfeR, 0.5); // Risk = 10, Profit = 5 -> MFE = 0.5
    assert.strictEqual(trade.barsToHalfR, 1); // Hit 0.5R on bar 1

    // 3. Take Profit Hit
    trade = createDummyTrade();
    features = { price: 135 };
    res = PositionExitLayer.monitorAndExit(trade, features, "BULL", true);
    assert.strictEqual(res.shouldExit, true);
    assert.strictEqual(res.exitType, "TAKE_PROFIT");

    // 4. Catastrophe Hit (Note: NORMAL engine ignores catastrophe stop in normal flow? Wait, the code says trade.engine !== 'NORMAL' for CATASTROPHE check)
    trade = createDummyTrade({ engine: "EXTREME", direction: "LONG", catastropheStopLoss: 80 });
    features = { price: 79 };
    res = PositionExitLayer.monitorAndExit(trade, features, "CRASH", true);
    assert.strictEqual(res.shouldExit, true);
    assert.strictEqual(res.exitType, "CATASTROPHE_STOP");

    // 5. Initial Stop Hit (EXTREME)
    trade = createDummyTrade({ engine: "EXTREME", direction: "LONG", initialStopLoss: 90, currentStopLoss: 90, catastropheStopLoss: 80 });
    features = { price: 89 };
    res = PositionExitLayer.monitorAndExit(trade, features, "CRASH", true);
    assert.strictEqual(res.shouldExit, true);
    assert.strictEqual(res.exitType, "INITIAL_STOP_LOSS");

    // 6. Normal Trailing Logic Hit
    trade = createDummyTrade({ engine: "NORMAL", direction: "LONG", initialStopLoss: 90, currentStopLoss: 100, highWaterMark: 110 });
    // Assuming trailPct is 0.04...
    // Let's just push price below current SL
    features = { price: 99 };
    res = PositionExitLayer.monitorAndExit(trade, features, "BULL", true);
    assert.strictEqual(res.shouldExit, true);
    assert.strictEqual(res.exitType, "TRAILING_STOP");

    console.log("PASS: testExitLayer");
}

try {
    testExitLayer();
} catch (e) {
    console.error("FAIL:", e);
    process.exit(1);
}
