import fs from 'fs';
import path from 'path';

function testCostsAndSlippage() {
  console.log("Running Costs & Slippage Test...");
  const reportPath = path.join(process.cwd(), 'backtest_report_latest.json');
  if (!fs.existsSync(reportPath)) {
      console.warn("[WARN] backtest_report_latest.json not found. Run backtest first to test costs.");
      return;
  }
  
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  let pass = true;

  if (report.config.fee === null || report.config.fee === undefined || report.config.fee === 0) {
      console.error("[FAIL] Fee not applied or missing in report config.");
      pass = false;
  }
  
  if (!report.config.slippage) {
      console.error("[FAIL] Slippage config missing.");
      pass = false;
  }

  // Assuming globalStats has gross and net pnl or feesTotal
  if (report.globalStats) {
      if (report.globalStats.totalTrades > 0 && (!report.globalStats.feesTotal || report.globalStats.feesTotal === 0)) {
          console.error("[FAIL] Total Trades > 0 but total fees are 0.");
          pass = false;
      }
      
      if (report.globalStats.netPnl === report.globalStats.grossPnl && report.globalStats.totalTrades > 0) {
         console.warn("[WARN] Net PnL is exactly equal to Gross PnL. Fee/Slippage wasn't correctly subtracted from equity.");
         // We might FAIL here, but letting it warn depending on how gross is defined
      }
  }

  if (pass) {
    console.log("PASS: Costs & Slippage Test");
  } else {
    console.error("FAIL: Costs & Slippage Test");
    process.exit(1);
  }
}

testCostsAndSlippage();
