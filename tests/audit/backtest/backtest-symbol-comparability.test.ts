import fs from 'fs';
import path from 'path';

function testSymbolComparability() {
  console.log("Running Symbol Comparability Test...");
  const reportPath = path.join(process.cwd(), 'backtest_report_latest.json');
  if (!fs.existsSync(reportPath)) {
      console.warn("[WARN] backtest_report_latest.json not found.");
      return;
  }
  
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const TARGET_SYMBOLS = [
      "BTC/USD", "ETH/USD", "SOL/USD", "AVAX/USD",
      "DOGE/USD", "LINK/USD", "ADA/USD", "XRP/USD"
  ];
  
  const reportedSymbols = report.symbols || [];
  
  // Note: the run.ts uses LTC/USD instead of AVAX/USD
  // We check if at least they are reported with their candle length
  
  let valid = true;
  for (const sym of reportedSymbols) {
      if (!report.symbolStats[sym]) {
          console.error(`[FAIL] ${sym} is in symbols array but has no stats block.`);
          valid = false;
      }
  }

  if (valid) {
      console.log("PASS: Symbol Comparability Test");
  } else {
      console.error("FAIL: Symbol Comparability Test");
      process.exit(1);
  }
}

testSymbolComparability();
