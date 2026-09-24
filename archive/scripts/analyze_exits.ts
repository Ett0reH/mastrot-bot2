import fs from "fs";

function analyzeExits() {
  const filePath = "./backtest_report_latest.json";
  if (!fs.existsSync(filePath)) {
    console.error("No backtest_report_latest.json found.");
    return;
  }

  const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  const trades = data.allTrades || data.trades || [];

  if (trades.length === 0) {
    console.log("No trades found in report.");
    return;
  }

  console.log(`Analyzing ${trades.length} trades for Exit Dynamics and Risk Control...`);

  // Count exit reasons
  const exitReasons: Record<string, number> = {};
  const exitPnL: Record<string, number> = {};
  let totalPnL = 0;

  // Risk metrics
  let totalBarsHeld = 0;
  let maxMAE = 0;
  let maxMFE = 0;
  let mfeSum = 0;
  let maeSum = 0;

  trades.forEach((t: any) => {
    const reason = t.reason || "UNKNOWN";
    exitReasons[reason] = (exitReasons[reason] || 0) + 1;
    exitPnL[reason] = (exitPnL[reason] || 0) + (t.pnl || 0);
    totalPnL += (t.pnl || 0);

    totalBarsHeld += (t.barsHeld || 0);
    const mfeR = t.mfeR || 0;
    const maeR = t.maeR || 0;

    mfeSum += mfeR;
    maeSum += maeR;
    if (mfeR > maxMFE) maxMFE = mfeR;
    // MAE is typically negative in standard R terms but here assuming absolute or negative
    if (Math.abs(maeR) > Math.abs(maxMAE)) maxMAE = maeR;
  });

  console.log("\n--- EXIT REASONS ---");
  Object.keys(exitReasons)
    .sort((a, b) => exitReasons[b] - exitReasons[a])
    .forEach((reason) => {
      const count = exitReasons[reason];
      const pnl = exitPnL[reason];
      console.log(`${reason}: ${count} trades (${((count / trades.length) * 100).toFixed(1)}%) -> PnL: $${pnl.toFixed(2)}`);
    });

  console.log("\n--- RISK DYNAMICS ---");
  console.log(`Average Bars Held: ${(totalBarsHeld / trades.length).toFixed(1)}`);
  console.log(`Average MFE (Maximum Favorable Excursion in R): ${(mfeSum / trades.length).toFixed(2)} R`);
  console.log(`Average MAE (Maximum Adverse Excursion in R): ${(maeSum / trades.length).toFixed(2)} R`);
  console.log(`Max Individual MFE: ${maxMFE.toFixed(2)} R`);
  console.log(`Max Individual MAE: ${maxMAE.toFixed(2)} R`);

  // Setup breakdown
  console.log("\n--- EXITS BY SETUP ---");
  const setupExits: Record<string, Record<string, number>> = {};
  trades.forEach((t: any) => {
    const s = t.setup || "UNKNOWN";
    const r = t.reason || "UNKNOWN";
    if (!setupExits[s]) setupExits[s] = {};
    setupExits[s][r] = (setupExits[s][r] || 0) + 1;
  });

  Object.keys(setupExits).forEach((setup) => {
    console.log(`\nSetup: ${setup}`);
    Object.keys(setupExits[setup])
      .sort((a, b) => setupExits[setup][b] - setupExits[setup][a])
      .forEach((r) => {
        console.log(`  ${r}: ${setupExits[setup][r]}`);
      });
  });
}

analyzeExits();
