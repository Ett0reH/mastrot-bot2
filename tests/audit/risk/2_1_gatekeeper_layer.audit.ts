import { GatekeeperLayer, SignalLayer, MarketDataLayer, ExpectancyTracker } from '../../../src/server/core/architecture';
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

function testGatekeeperLogic() {
    console.log("Running testGatekeeperLogic...");

    // 1. NEUTRAL signal -> reject
    let signal: any = { direction: "NEUTRAL", quality: 0, type: "NONE" };
    let features = createDummyFeatures();
    let gate = GatekeeperLayer.allowEntry(signal, features, "BULL", "TEST");
    assert.strictEqual(gate.allowed, false, "Should block NEUTRAL signal");
    assert.strictEqual(gate.reason, "NO_SIGNAL");

    // 2. LOW QUALITY signal -> reject
    signal = { direction: "LONG", quality: 0.4, type: "TEST_SETUP" };
    gate = GatekeeperLayer.allowEntry(signal, features, "BULL", "TEST");
    assert.strictEqual(gate.allowed, false, "Should block LOW QUALITY signal");
    assert.strictEqual(gate.reason, "LOW_QUALITY_SIGNAL");

    // 3. CHOP bloccante deve produrre reject
    signal = { direction: "LONG", quality: 0.9, type: "TEST_SETUP" };
    features = createDummyFeatures({ isChop: true });
    gate = GatekeeperLayer.allowEntry(signal, features, "BULL", "TEST");
    assert.strictEqual(gate.allowed, false, "Should block in CHOP");
    assert.strictEqual(gate.reason, "BLOCKED_BY_CHOP");

    // 4. Overextended guards
    features = createDummyFeatures({ rsi1H: 80, isChop: false });
    gate = GatekeeperLayer.allowEntry(signal, features, "BULL", "TEST");
    assert.strictEqual(gate.allowed, false, "Should block OVEREXTENDED_LONG");
    assert.strictEqual(gate.reason, "OVEREXTENDED_LONG");

    signal.direction = "SHORT";
    features = createDummyFeatures({ rsi1H: 20 });
    gate = GatekeeperLayer.allowEntry(signal, features, "BEAR", "TEST");
    assert.strictEqual(gate.allowed, false, "Should block OVEREXTENDED_SHORT");
    assert.strictEqual(gate.reason, "OVEREXTENDED_SHORT");

    // 5. CRASH long block if not Mean Reversion
    signal = { direction: "LONG", quality: 0.9, type: "TREND_FOLLOWING" };
    features = createDummyFeatures({ rsi1H: 50 });
    gate = GatekeeperLayer.allowEntry(signal, features, "CRASH", "TEST");
    assert.strictEqual(gate.allowed, false, "Should block LONG in CRASH if not MEAN REVERSION");
    assert.strictEqual(gate.reason, "NO_TREND_LONGS_IN_CRASH");

    // 6. EUPHORIA short block if not Mean Reversion
    signal = { direction: "SHORT", quality: 0.9, type: "TREND_FOLLOWING" };
    features = createDummyFeatures({ rsi1H: 50 });
    gate = GatekeeperLayer.allowEntry(signal, features, "EUPHORIA", "TEST");
    assert.strictEqual(gate.allowed, false, "Should block SHORT in EUPHORIA if not MEAN REVERSION");
    assert.strictEqual(gate.reason, "NO_SHORTS_IN_EUPHORIA");

    // 7. TRANSITION require high conviction
    signal = { direction: "LONG", quality: 0.7, type: "TEST_SETUP" };
    gate = GatekeeperLayer.allowEntry(signal, features, "TRANSITION", "TEST");
    assert.strictEqual(gate.allowed, false, "Should block low conviction in TRANSITION");
    assert.strictEqual(gate.reason, "REQUIRE_HIGH_CONVICTION_IN_TRANSITION");

    // 8. Expectancy Filter Logic
    // We already tested basic insufficient data, let's load a matrix to mock a DISABLED response
    ExpectancyTracker.loadMatrix({
        'TEST_BULL_TEST_SETUP': { trades: 50, expectancy: -1, profitFactor: 0.5, sampleSize: 50 } as any
    });
    signal = { direction: "LONG", quality: 0.9, type: "TEST_SETUP" };
    gate = GatekeeperLayer.allowEntry(signal, features, "BULL", "TEST");
    assert.strictEqual(gate.allowed, false, "Should block if EXPECTANCY_DISABLED");
    assert.strictEqual(gate.reason, "EXPECTANCY_DISABLED");

    console.log("PASS: testGatekeeperLogic");
}

try {
    testGatekeeperLogic();
} catch (e) {
    console.error("FAIL:", e);
    process.exit(1);
}
