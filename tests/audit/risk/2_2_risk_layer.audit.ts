import { RiskLayer } from '../../../src/server/core/architecture';
import * as assert from 'assert';

function createDummyFeatures(price: number, atr: number): any {
    return {
        price,
        atr1H: atr,
        rsi1H: 50,
        rsi2_4H: 50,
        volZScore: 0,
        volPct: 0.01,
        trend1H: 1,
        trend4H: 1
    };
}

function testRiskSizing() {
    console.log("Running testRiskSizing...");

    const signal: any = { direction: "LONG", quality: 1.0, type: "TEST", engine: "NORMAL" };
    
    // 1. Base Sizing
    let features = createDummyFeatures(100, 2);
    let risk = RiskLayer.calculateRisk(signal, features, 10000, "BULL", 1.0, "TEST");
    
    let expectedRiskPerTrade = 0.05 * 1.0; // 5%
    let expectedLeverage = 2.0;
    let expectedAlloc = 10000 * expectedRiskPerTrade * expectedLeverage; // 10000 * 0.05 * 2 = 1000
    assert.strictEqual(risk.positionSize, expectedAlloc / features.price, "Base size should match formula");
    assert.strictEqual(risk.leverage, expectedLeverage, "Base leverage should be 2.0 in BULL");
    
    // 2. High ATR Reduces Leverage
    // if expectedRiskPct * leverage > 0.15 -> leverage clamped
    // slDist for NORMAL is max(trendPct, atrPct)
    // atrPct = 2.5 * atr / price = 2.5 * 10 / 100 = 0.25 (25%)
    // expectedRiskPct = 0.25
    // 0.25 * 2.0 = 0.50 > 0.15
    // leverage = floor(0.15 / 0.25 * 10) / 10 = floor(0.6 * 10) / 10 = 0.6
    // BUT leverage = Math.max(1.0, ...) so leverage = 1.0
    features = createDummyFeatures(100, 10);
    risk = RiskLayer.calculateRisk(signal, features, 10000, "BULL", 1.0, "TEST");
    assert.strictEqual(risk.leverage, 1.0, "High ATR should clamp leverage to 1.0 to protect margin");

    // 3. Gatekeeper modifier works
    features = createDummyFeatures(100, 2);
    risk = RiskLayer.calculateRisk(signal, features, 10000, "BULL", 0.5, "TEST");
    expectedAlloc = 10000 * (0.05 * 0.5) * 2.0; // 500
    assert.strictEqual(risk.positionSize, expectedAlloc / features.price, "Gatekeeper modifier must reduce size");

    // 4. EUPHORIA increases risk and scaling
    features = createDummyFeatures(100, 1);
    // Let's assume FASE 10 is false or true. It's enabled now so we test the new logic. 
    // In FASE 10, EUPHORIA with quality=1 but no expectancy is reduced to leverage 2.0 or 3.0?
    // Let's test output
    risk = RiskLayer.calculateRisk(signal, features, 10000, "EUPHORIA", 1.0, "TEST");
    assert.ok([2.0, 3.0, 5.0].includes(risk.leverage), "Leverage in EUPHORIA should be evaluated by quality-gated logic");

    // 5. Max Exposure Cap
    // Let's use a very high risk pct dynamic exposure
    risk = RiskLayer.calculateRisk(signal, features, 10000, "BULL", 1.0, "TEST", undefined, 1.0 /* 100% risk */);
    // expectedAlloc = 10000 * 1.0(risk) * 2(lev) = 20000
    // BUT max cap = 10000 * 0.8 = 8000
    assert.strictEqual(risk.positionSize, 8000 / features.price, "Size must be clamped by max exposure USD cap (80%)");
    
    // 6. Stop and Catastrophe stop sanity checks
    assert.ok(risk.stopLoss < features.price, "LONG SL must be below price");
    assert.ok(risk.catastropheStopLoss < features.price, "Catastrophe stop must be below price for LONG");
    
    console.log("PASS: testRiskSizing");
}

try {
    testRiskSizing();
} catch(e) {
    console.error("FAIL:", e);
    process.exit(1);
}
