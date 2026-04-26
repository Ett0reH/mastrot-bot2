import "dotenv/config";
import { startPaperTrading, stopPaperTrading, triggerCronTick, getLiveState, saveState } from './liveEngine';

async function main() {
  try {
    console.log("Starting paper trading...");
    await startPaperTrading();
    const state = await getLiveState();
    
    // Bloat data to what it would be after hours
    state.recentTrades = new Array(50).fill(null).map((_, i) => ({
      symbol: 'BTC/USDT', side: 'LONG', entry: 50000, exit: 51000, pnl: 10, reason: 'TAKE_PROFIT', time: new Date().toISOString()
    }));
    state.equityHistory = new Array(500).fill(null).map((_, i) => ({ time: new Date().toISOString(), equity: 10000 + i }));
    state.metricsHistory = new Array(100).fill(null).map((_, i) => ({
      timestamp: new Date().toISOString(),
      balance: 10000,
      winRate: 0.5,
      profitFactor: 1.5,
      totalTrades: 100,
      openPositions: 2,
      maxDrawdown: -5.0,
      regime: 'BULL',
      expectancy: 0.1,
      sharpeRatio: 1.2
    }));
    
    console.log("Saving full payload test...");
    await saveState();
    console.log("Done.");
    await stopPaperTrading();
    process.exit(0);
  } catch(e) {
    console.error("Test failed:", e);
    process.exit(1);
  }
}
main();
