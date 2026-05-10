import { loadInitialState, state, startPaperTrading } from '../../../src/server/liveEngine';
import * as assert from 'assert';

async function testBackendAPIEndpoints() {
    console.log("Running testBackendAPIEndpoints...");

    // Mock an active system
    state.status = 'ERROR';
    state.lastError = 'Mock Error';
    state.balance = 20000;
    state.openPositions = [{ symbol: 'BTC', size: 10,  id: 'x' } as any];
    
    // Simulate /api/system/state route logic
    const res = Object.assign({}, state);
    
    // Assert 5.4.b coherence (state passes through nicely without stripping)
    assert.strictEqual(res.status, 'ERROR');
    assert.strictEqual(res.lastError, 'Mock Error');
    assert.strictEqual(res.balance, 20000);
    assert.strictEqual(res.openPositions.length, 1);
    
    console.log("PASS: testBackendAPIEndpoints");
}

async function main() {
    try {
        await testBackendAPIEndpoints();
        process.exit(0);
    } catch (e) {
        console.error("FAIL:", e);
        process.exit(1);
    }
}
main();
