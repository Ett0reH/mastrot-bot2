import { execSync } from "child_process";
import fs from "fs";

function testNormalTrailingStop() {
  const originalFile = fs.readFileSync("src/server/core/architecture.ts", "utf8");

  const combos = [
    { name: "1%", val: 0.01 },
    { name: "3%", val: 0.03 },
    { name: "5%", val: 0.05 },
    { name: "7%", val: 0.07 },
    { name: "10%", val: 0.10 }
  ];

  console.log("Analyzing NORMAL engine Trailing Stop impact...");

  for (const combo of combos) {
    let updated = originalFile.replace(
      /longTrailingStopPercent: 0\.\d+/,
      `longTrailingStopPercent: ${combo.val.toFixed(2)}`
    );
    fs.writeFileSync("src/server/core/architecture.ts", updated);

    try {
      execSync("npx tsx src/server/backtest/run.ts", { stdio: "ignore" });
      const data = JSON.parse(fs.readFileSync("backtest_report_latest.json", "utf8"));
      
      const normalTrades = data.trades.filter((t: any) => t.engine === "NORMAL" && t.entryRegime === "BULL");
      let wins = 0;
      let pnl = 0;
      normalTrades.forEach((t: any) => {
          if (t.pnl > 0) wins++;
          pnl += t.pnl;
      });
      const wr = normalTrades.length > 0 ? (wins / normalTrades.length) * 100 : 0;
      console.log(`- ${combo.name}: PnL = $${pnl.toFixed(2)}, WR = ${wr.toFixed(1)}%, Trades = ${normalTrades.length}`);
    } catch (e: any) {}
  }

  // Restore
  fs.writeFileSync("src/server/core/architecture.ts", originalFile);
}
testNormalTrailingStop();
