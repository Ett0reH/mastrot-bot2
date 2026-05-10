import { ccxtWithRetry, withTimeout } from '../../../src/server/liveEngine';
import * as assert from 'assert';
import ccxt from 'ccxt';

async function testWithTimeout() {
    console.log("Running testWithTimeout...");
    
    // 1. Success case
    const p1 = new Promise(res => setTimeout(() => res("OK"), 10));
    let start = Date.now();
    const r1 = await withTimeout(p1, 100);
    assert.strictEqual(r1, "OK");

    // 2. Timeout case
    const p2 = new Promise(res => setTimeout(() => res("OK"), 200));
    start = Date.now();
    try {
        await withTimeout(p2, 50, "TestOp");
        assert.fail("Should have timed out");
    } catch (e: any) {
        assert.strictEqual(e.message.includes("TestOp timed out"), true);
    }
    
    console.log("PASS: testWithTimeout");
}

async function testCcxtWithRetry() {
    console.log("Running testCcxtWithRetry...");

    // 1. Succeeds on first try
    let calls = 0;
    const fn1 = async () => { calls++; return "OK"; };
    let r = await ccxtWithRetry(fn1, 3, 10);
    assert.strictEqual(r, "OK");
    assert.strictEqual(calls, 1);

    // 2. Transient error then success
    calls = 0;
    const fn2 = async () => {
        calls++;
        if (calls < 3) throw new ccxt.NetworkError("ECONNRESET mock error");
        return "NOW_OK";
    };
    r = await ccxtWithRetry(fn2, 4, 10);
    assert.strictEqual(r, "NOW_OK");
    assert.strictEqual(calls, 3);

    // 3. Fatal error (e.g. invalid size, margin, etc) immediately throws
    calls = 0;
    const fn3 = async () => {
        calls++;
        throw new ccxt.ExchangeError("Order size invalid");
    };
    try {
        await ccxtWithRetry(fn3, 3, 10);
        assert.fail("Should have thrown FATAL");
    } catch (e: any) {
        assert.strictEqual(calls, 1, "Should not retry an invalid size/margin error");
        assert.strictEqual(e.message, "Order size invalid");
    }

    // 4. Exceeds max retries
    calls = 0;
    const fn4 = async () => {
        calls++;
        throw new ccxt.NetworkError("timeout mock error " + calls); // Transient error
    };
    try {
        await ccxtWithRetry(fn4, 3, 10);
        assert.fail("Should have thrown after 3 retries");
    } catch (e: any) {
        assert.strictEqual(calls, 3);
        assert.strictEqual(e.message.includes("timeout mock error 3"), true);
    }

    console.log("PASS: testCcxtWithRetry");
}

async function main() {
    try {
        await testWithTimeout();
        await testCcxtWithRetry();
        process.exit(0);
    } catch (err) {
        console.error("FAIL:", err);
        process.exit(1);
    }
}

main();
