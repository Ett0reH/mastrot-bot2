import fs from "fs";

function analyzeNormalBull() {
  const data = JSON.parse(fs.readFileSync("./backtest_report_latest.json", "utf-8"));
  const trades = data.trades || [];

  const normalBullTrades = trades.filter((t: any) => t.engine === "NORMAL" && t.entryRegime === "BULL");

  console.log("--- NORMAL ENGINE: BULL REGIME DYNAMICS ---");
  console.log(`Total Trades: ${normalBullTrades.length}`);

  let wins = 0;
  let losses = 0;
  let totalPnL = 0;
  let totalMFE = 0;
  let totalMAE = 0;

  const typeMap: Record<string, {count: number, pnl: number, wins: number, mfe: number}> = {};
  const reasonMap: Record<string, number> = {};

  normalBullTrades.forEach((t: any) => {
    totalPnL += t.pnl;
    totalMFE += t.mfeR || 0;
    totalMAE += t.maeR || 0;

    if (t.pnl > 0) wins++;
    else losses++;

    if (!typeMap[t.setup]) {
        typeMap[t.setup] = {count: 0, pnl: 0, wins: 0, mfe: 0};
    }
    typeMap[t.setup].count++;
    typeMap[t.setup].pnl += t.pnl;
    typeMap[t.setup].mfe += (t.mfeR || 0);
    if (t.pnl > 0) typeMap[t.setup].wins++;

    reasonMap[t.reason] = (reasonMap[t.reason] || 0) + 1;
  });

  console.log(`Win Rate: ${((wins / (normalBullTrades.length || 1)) * 100).toFixed(1)}%`);
  console.log(`Total PnL: $${totalPnL.toFixed(2)}`);
  console.log(`Avg MFE: ${(totalMFE / (normalBullTrades.length || 1)).toFixed(2)}R`);
  console.log(`Avg MAE: ${(totalMAE / (normalBullTrades.length || 1)).toFixed(2)}R`);

  console.log("\nBreakdown by Setup:");
  for (const [setup, stats] of Object.entries(typeMap)) {
      console.log(`- ${setup}: ${stats.count} trades, $${stats.pnl.toFixed(2)} PnL, WR: ${((stats.wins / stats.count)*100).toFixed(1)}%, Avg MFE: ${(stats.mfe/stats.count).toFixed(2)}R`);
  }

  console.log("\nBreakdown by Exit Reason:");
  for (const [reason, count] of Object.entries(reasonMap)) {
      console.log(`- ${reason}: ${count}`);
  }
}
analyzeNormalBull();
