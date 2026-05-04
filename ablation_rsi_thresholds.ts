import { execSync } from "child_process";
import fs from "fs";

function testRsiThresholds() {
  const originalFile = fs.readFileSync("src/server/core/architecture.ts", "utf8");

  const combos = [
    { name: "Baseline (Long<25, Short>85)", long: 25, short: 85 },
    { name: "Test A (Long<20, Short>80)", long: 20, short: 80 },
    { name: "Test B (Long<25, Short>80)", long: 25, short: 80 },
    { name: "Test C (Long<25, Short>75)", long: 25, short: 75 },
    { name: "Test D (Long<20, Short>75)", long: 20, short: 75 }
  ];

  console.log("Starting comparative backtest for MEAN_REVERSION RSI thresholds...");

  let results = `| Thresholds | Clean PnL | Total Trades | Win Rate | Extreme Engine PnL |\n`;
  results +=    `|------------|-----------|--------------|----------|--------------------|\n`;

  for (const combo of combos) {
    let updated = originalFile.replace(
      /regime === "CRASH" && features\.rsi1H < \d+/,
      `regime === "CRASH" && features.rsi1H < ${combo.long}`
    );
    updated = updated.replace(
      /regime === "EUPHORIA" && features\.rsi1H > \d+/,
      `regime === "EUPHORIA" && features.rsi1H > ${combo.short}`
    );
    fs.writeFileSync("src/server/core/architecture.ts", updated);

    console.log(`Running backtest for ${combo.name}...`);
    try {
      execSync("npx tsx src/server/backtest/run.ts", { stdio: "ignore" });
      const data = JSON.parse(fs.readFileSync("backtest_report_latest.json", "utf8"));
      
      const pnl = data.cleanPnL.toFixed(2);
      const wr = (data.winRate * 100).toFixed(1);
      const tradesCount = data.trades.length || 0;
      
      let extPnl = 0;
      data.trades.forEach((t:any) => {
         if (t.engine === "EXTREME") {
            extPnl += t.pnl;
         }
      });

      results += `| ${combo.name} | $${pnl} | ${tradesCount} | ${wr}% | $${extPnl.toFixed(2)} |\n`;

    } catch (e: any) {
      console.log("Error running for " + combo.name, e.message);
    }
  }

  // Restore
  fs.writeFileSync("src/server/core/architecture.ts", originalFile);
  fs.writeFileSync("RSI_THRESHOLD_COMPARISON.md", results);
  console.log("Done.");
  console.log(results);
}
testRsiThresholds();
