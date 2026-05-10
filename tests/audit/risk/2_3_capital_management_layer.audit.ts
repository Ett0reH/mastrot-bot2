import { CapitalManagementLayer } from '../../../src/server/core/architecture';
import * as assert from 'assert';

function testCapitalHealth() {
    console.log("Running testCapitalHealth...");

    // 1. Initial State (No drawdown)
    let health = CapitalManagementLayer.evaluateAccountHealth(10000, 10000);
    assert.strictEqual(health.isHalted, false);
    assert.strictEqual(health.allowedCapacityMultiplier, 1.0);

    // 2. Small drawdown (under 15%)
    health = CapitalManagementLayer.evaluateAccountHealth(9000, 10000); // 10%
    assert.strictEqual(health.isHalted, false);
    assert.strictEqual(health.allowedCapacityMultiplier, 1.0);

    // 3. Medium drawdown (15% - 25%)
    health = CapitalManagementLayer.evaluateAccountHealth(8500, 10000); // 15%
    assert.strictEqual(health.isHalted, false);
    assert.strictEqual(health.allowedCapacityMultiplier, 0.5);

    health = CapitalManagementLayer.evaluateAccountHealth(8000, 10000); // 20%
    assert.strictEqual(health.isHalted, false);
    assert.strictEqual(health.allowedCapacityMultiplier, 0.5);

    // 4. Heavy drawdown (>= 25%) -> Halted
    health = CapitalManagementLayer.evaluateAccountHealth(7500, 10000); // 25%
    assert.strictEqual(health.isHalted, true);
    assert.strictEqual(health.allowedCapacityMultiplier, 0);

    health = CapitalManagementLayer.evaluateAccountHealth(5000, 10000); // 50%
    assert.strictEqual(health.isHalted, true);
    assert.strictEqual(health.allowedCapacityMultiplier, 0);
    
    // 5. Recovery
    health = CapitalManagementLayer.evaluateAccountHealth(9500, 10000); // 5% DD again
    assert.strictEqual(health.isHalted, false);
    assert.strictEqual(health.allowedCapacityMultiplier, 1.0);

    console.log("PASS: testCapitalHealth");
}

function testPeakDrawdownUpdate() {
    console.log("Running testPeakDrawdownUpdate...");

    let equity = 10000;
    let peak = 10000;
    
    // 10000 -> 10500
    equity = 10500;
    peak = Math.max(peak, equity);
    let health = CapitalManagementLayer.evaluateAccountHealth(equity, peak);
    assert.strictEqual(peak, 10500);
    assert.strictEqual(health.allowedCapacityMultiplier, 1.0);

    // 10500 -> 10200
    equity = 10200;
    peak = Math.max(peak, equity); // DDR 10200 vs 10500 = ~2.8%
    health = CapitalManagementLayer.evaluateAccountHealth(equity, peak);
    assert.strictEqual(peak, 10500);
    assert.strictEqual(health.allowedCapacityMultiplier, 1.0);

    // 10200 -> 8900
    equity = 8900;
    peak = Math.max(peak, equity); // DDR 8900 vs 10500 = ~15.2%
    health = CapitalManagementLayer.evaluateAccountHealth(equity, peak);
    assert.strictEqual(health.allowedCapacityMultiplier, 0.5);

    // 8900 -> 9500
    equity = 9500;
    peak = Math.max(peak, equity); // DDR 9500 vs 10500 = ~9.5%
    health = CapitalManagementLayer.evaluateAccountHealth(equity, peak);
    assert.strictEqual(health.allowedCapacityMultiplier, 1.0, "Recovery allows full risk again");

    console.log("PASS: testPeakDrawdownUpdate");
}

function testExposureGlobalLogic() {
    console.log("Running testExposureGlobalLogic...");
    
    const balance = 10000;
    const MAX_GLOBAL_EXPOSURE = Math.max(50000, balance * 2.5); // From liveEngine: 50000
    
    const simulatedPositions = [
        { size: 0.5, entryPrice: 60000 }, // 30,000 exposure
        { size: 10, entryPrice: 1500 } // 15,000 exposure
    ];
    
    const currentExposure = simulatedPositions.reduce((acc, p) => acc + (p.size * p.entryPrice), 0);
    assert.strictEqual(currentExposure, 45000);
    
    // Simulo new trade
    const orderResAmount = 0.1;
    const featuresPrice = 61000;
    const newTradeExposure = orderResAmount * featuresPrice; // 6,100
    
    assert.strictEqual(currentExposure + newTradeExposure > MAX_GLOBAL_EXPOSURE, true, "Should reject trade: Exposure exceeds MAX_GLOBAL_EXPOSURE");

    console.log("PASS: testExposureGlobalLogic");
}

try {
    testCapitalHealth();
    testPeakDrawdownUpdate();
    testExposureGlobalLogic();
} catch(e) {
    console.error("FAIL:", e);
    process.exit(1);
}
