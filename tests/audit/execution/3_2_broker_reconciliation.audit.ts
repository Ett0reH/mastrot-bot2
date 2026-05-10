import { resolveOrderAmount } from '../../../src/server/liveEngine';
import * as assert from 'assert';

function testResolveOrderAmount() {
    console.log("Running testResolveOrderAmount...");

    const fakeExchange = {
        markets: {
            "TEST/USD": {
                limits: {
                    amount: { min: 0.1 },
                    cost: { min: 10 }
                }
            }
        },
        amountToPrecision: (symbol: string, amount: number) => {
            return amount.toFixed(2);
        }
    };

    // 1. Valid amount
    let res = resolveOrderAmount(fakeExchange, "TEST/USD", 1.555, 100);
    assert.strictEqual(res.ok, true, "Should accept valid amount");
    assert.strictEqual(res.amount, Number((1.555).toFixed(2)), "Should truncate to precision");

    // 2. Below min amount limits, but high notional
    res = resolveOrderAmount(fakeExchange, "TEST/USD", 0.05, 1000); // Notional = 50, amount = 0.05
    assert.strictEqual(res.ok, false, "Should reject below min amount");
    assert.ok(res.reason.includes("below min limits"), "Expected reason to mention limits, but got: " + res.reason);

    // 3. Below min cost limits
    res = resolveOrderAmount(fakeExchange, "TEST/USD", 0.1, 50); // Notional = 0.1 * 50 = 5, limit is 10
    assert.strictEqual(res.ok, false, "Should reject below min notional cost");
    assert.ok(res.reason.includes("below min cost"), "Expected reason to mention cost, but got: " + res.reason);

    // 4. Truncated to zero
    res = resolveOrderAmount(fakeExchange, "TEST/USD", 0.001, 100);
    assert.strictEqual(res.ok, false, "Should reject if truncated to 0");
    assert.ok(res.reason.includes("Amount truncated to zero by precision") || res.reason.includes("Notional 0 below min cost"), "Should have truncation or zero notional reason");

    // 5. Negative raw amount
    res = resolveOrderAmount(fakeExchange, "TEST/USD", -10, 100);
    assert.strictEqual(res.ok, false, "Should reject negative raw amount");
    assert.strictEqual(res.reason, "Amount must be positive");

    console.log("PASS: testResolveOrderAmount");
}

try {
    testResolveOrderAmount();
    process.exit(0);
} catch (e) {
    console.error("FAIL:", e);
    process.exit(1);
}
