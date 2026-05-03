import "dotenv/config";
import { initExchange, loopTick, state, simulatedPositions, getLiveState } from './src/server/liveEngine';

setTimeout(() => { console.log("Force exiting after 15s"); process.exit(1); }, 15000);

async function run() {
    state.isActive = true;
    state.status = 'RUNNING';
    state.balance = 50000;
    state.baseBalance = 50000;
    
    await initExchange();
    
    console.log("Starting loopTick...");
    // run one tick
    await loopTick();
    
    console.log("Positions:", simulatedPositions);
    console.log("State:", state.status);
    console.log("Regime:", state.regime);
    process.exit(0);
}
run();
