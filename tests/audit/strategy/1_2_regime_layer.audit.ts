import { RegimeLayer, TradingRegime } from '../../../src/server/core/architecture';
import * as assert from 'assert';

function createDummyFeatures(overrides: any = {}): any {
    return {
        price: 100,
        rsi1H: 50,
        rsi4H: 50,
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

function testRegimeDetection() {
    console.log("Running testRegimeDetection...");

    // STABLE BULL
    let features = createDummyFeatures({ trend4H: 1, distFromSMA: 0.05, volPct: 0.02, volZScore: 1 });
    let regime = RegimeLayer.detect(features);
    assert.strictEqual(regime, "BULL", "Should detect BULL regime");

    // STABLE BEAR
    features = createDummyFeatures({ trend4H: -1, distFromSMA: -0.05, volPct: 0.02, volZScore: 1 });
    regime = RegimeLayer.detect(features);
    assert.strictEqual(regime, "BEAR", "Should detect BEAR regime");

    // CRASH (Violent dump)
    features = createDummyFeatures({ volPct: 5.0, price: 80, trend4H: -1 });
    regime = RegimeLayer.detect(features);
    assert.strictEqual(regime, "CRASH", "Should detect CRASH on high volPct and negative dist");

    // EUPHORIA
    features = createDummyFeatures({ volZScore: 3.5, price: 125, trend4H: 1 });
    regime = RegimeLayer.detect(features);
    assert.strictEqual(regime, "EUPHORIA", "Should detect EUPHORIA on high volZScore and positive dist");

    // CHOP (Laterale)
    features = createDummyFeatures({ trend4H: 0, distFromSMA: 0.01, volPct: 0.01 });
    regime = RegimeLayer.detect(features);
    assert.strictEqual(regime, "TRANSITION", "Should detect TRANSITION on no trend and small dist");

    console.log("PASS: testRegimeDetection");
}

testRegimeDetection();
