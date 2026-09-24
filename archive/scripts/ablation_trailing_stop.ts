import { execSync } from "child_process";
import fs from "fs";

function testTrailingStops() {
  const values = [0.01, 0.02, 0.03, 0.04, 0.05];
  
  const originalFile = fs.readFileSync("src/server/core/architecture.ts", "utf8");

  console.log("Starting risk control sensitivity check on trailing stop...");

  let results = `| Trailing Stop % | Clean PnL | WR% | Avg MFE | Avg MAE | Normal Engine PnL |\n`;
  results +=    `|-----------------|-----------|-----|---------|---------|-------------------|\n`;

  for (const v of values) {
    const updated = originalFile.replace(
      /longTrailingStopPercent:\s*[\d.]+/,
      `longTrailingStopPercent: ${v}`
    );
    fs.writeFileSync("src/server/core/architecture.ts", updated);

    console.log(`Running backtest with Trail = ${v*100}%...`);
    try {
      execSync("npx tsx src/server/backtest/run.ts", { stdio: "ignore" });
      const data = JSON.parse(fs.readFileSync("backtest_report_latest.json", "utf8"));
      
      const pnl = data.cleanPnL.toFixed(2);
      const wr = (data.winRate * 100).toFixed(1);
      
      let mfe = 0; let mae = 0;
      let normPnl = 0;
      data.trades.forEach((t:any) => {
         mfe += t.mfeR || 0;
         mae += t.maeR || 0;
         if (t.engine === "NORMAL") {
            normPnl += t.pnl;
         }
      });
      mfe /= data.trades.length || 1;
      mae /= data.trades.length || 1;

      results += `| ${v * 100}% | $${pnl} | ${wr}% | ${mfe.toFixed(2)} R | ${mae.toFixed(2)} R | $${normPnl.toFixed(2)} |\n`;

    } catch (e) {
      console.log("Error running for " + v);
    }
  }

  // Restore
  fs.writeFileSync("src/server/core/architecture.ts", originalFile);
  fs.writeFileSync("TRAILING_STOP_RISK_CHECK.md", results);
  console.log("Done.");
  console.log(results);
}
testTrailingStops();
