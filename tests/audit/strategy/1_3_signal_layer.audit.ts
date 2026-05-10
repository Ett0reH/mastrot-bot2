import { SignalLayer, MarketDataLayer, ExpectancyTracker, GatekeeperLayer, TradingRegime } from '../../../src/server/core/architecture';
import * as assert from 'assert';

function createDummyFeatures(overrides: any = {}): any {
    return {
        price: 100,
        rsi1H: 50,
        rsi2_4H: 50,
        rsi4H: 50,
        ema50_4H: 100,
        ema200_4H: 100,
        sma50_1H: 100,
        sma200_4H: 100,
        volZScore: 0,
        volPct: 0.01,
        distFromSMA: 0,
        trend1H: 0,
        trend4H: 0,
        isH4Closed: true,
        isChop: false,
        ...overrides
    };
}

function testSignalLayer() {
    console.log("Running testSignalLayer...");
    
    // 1. CLEAR LONG NORMAL
    let features = createDummyFeatures({
        ema50_4H: 120,
        ema200_4H: 100,
        price: 110,
        rsi2_4H: 5, // Deep pullback
        isH4Closed: true
    });
    let signal = SignalLayer.evaluate(features, "BULL", "TEST/USD");
    assert.strictEqual(signal.direction, "LONG", "Should generate LONG in BULL regime with pullback");
    assert.strictEqual(signal.engine, "NORMAL", "Should use NORMAL engine");

    // 2. SHORT DESIGNED -> NO_TRADE (Since Normal Short is disabled)
    features = createDummyFeatures({
        ema50_4H: 80,
        ema200_4H: 100,
        price: 90,
        rsi2_4H: 95, // Relief rally
        isH4Closed: true
    });
    signal = SignalLayer.evaluate(features, "BEAR", "TEST/USD");
    assert.strictEqual(signal.direction, "NEUTRAL", "Should NOT generate SHORT in BEAR because Normal shorts are disabled");

    // 3. EXTREME EUPHORIA -> SHORT? NO_SHORTS_IN_EUPHORIA gatekeeper test? 
    // Wait, let's see what SignalLayer emits in EUPHORIA.
    features = createDummyFeatures({
        volZScore: 4.0,
        volPct: 5.0,
        price: 150,
        sma200_4H: 100,
        rsi1H: 90,
        isH4Closed: true
    });
    signal = SignalLayer.evaluate(features, "EUPHORIA", "TEST/USD");
    // ExtremeEngine checks rsi1H > 85 -> SHORT
    assert.strictEqual(signal.direction, "SHORT", "ExtremeEngine should generate SHORT in EUPHORIA");
    assert.strictEqual(signal.engine, "EXTREME", "Should use EXTREME engine in EUPHORIA");

    // 4. GATEKEEPER EUPHORIA SHORT TEST
    // "In EUPHORIA, Gatekeeper blocks SHORTS unless MEAN_REVERSION"
    let fakeSignal: any = { direction: "SHORT", type: "TREND_FOLLOWING", engine: "EXTREME", quality: 1.0 };
    let gate = GatekeeperLayer.allowEntry(fakeSignal, features, "EUPHORIA", "TEST/USD");
    assert.strictEqual(gate.allowed, false, "Gatekeeper should block non MEAN_REVERSION SHORT in EUPHORIA");
    assert.strictEqual(gate.reason, "NO_SHORTS_IN_EUPHORIA");

    console.log("PASS: testSignalLayer");
}

function testExpectancyTracker() {
    console.log("Running testExpectancyTracker...");
    
    const features = createDummyFeatures();
    const signal = { direction: "LONG" as "LONG", quality: 1, type: "TEST_SETUP", engine: "NORMAL" as "NORMAL" };
    
    ExpectancyTracker.loadMatrix({});
    const gate = GatekeeperLayer.allowEntry(signal, features, "BULL", "TEST/USD");
    
    // As per requirement: "Expectancy manca -> EXPECTANCY_INSUFFICIENT_DATA e riskModifier 0.5"
    assert.strictEqual(gate.allowed, true, "Should allow but reduce risk");
    assert.strictEqual(gate.reason, "EXPECTANCY_INSUFFICIENT_DATA_OR_REDUCED");
    assert.strictEqual(gate.riskModifier, 0.5);

    console.log("PASS: testExpectancyTracker");
}

try {
    testSignalLayer();
    testExpectancyTracker();
} catch (e) {
    console.error("FAIL:", e);
    process.exit(1);
}
