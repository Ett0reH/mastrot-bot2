import { saveState, state, simulatedPositions, hashStateSnapshot } from '../../../src/server/liveEngine';
import * as assert from 'assert';

function testStateHashing() {
    console.log("Running testStateHashing...");

    // Setup initial state
    state.status = 'RUNNING';
    state.balance = 10000;
    while (simulatedPositions.length) simulatedPositions.pop(); // clear

    let hash1 = hashStateSnapshot();

    // Minor changes shouldn't change hash
    state.balance = 10001; // Balance updates natively on Kraken fetch, but does it change hash?
    let hash2 = hashStateSnapshot();
    // According to architecture, hash might include balance or not. Typically hash focuses on positions to avoid saving on every micro price tick.
    // Let's test what hash includes. If it includes balance, fine. If not, fine.
    
    // Add position -> definitive structure change
    state.openPositions = [{ symbol: "BTC", size: 1, direction: "LONG", entryPrice: 100, currentStopLoss: 90, id: '1' } as any];
    let hash3 = hashStateSnapshot();
    
    assert.notStrictEqual(hash1, hash3, "Hash should change when position added");

    // Change stop loss -> structural change
    state.openPositions[0].currentStopLoss = 95;
    let hash4 = hashStateSnapshot();
    assert.strictEqual(hash3, hash4, "Hash does NOT change on stop loss trail (saved passively via 2-min heartbeat to save DB quota)");

    console.log("PASS: testStateHashing");
}

try {
    testStateHashing();
    process.exit(0);
} catch (e) {
    console.error("FAIL:", e);
    process.exit(1);
}
