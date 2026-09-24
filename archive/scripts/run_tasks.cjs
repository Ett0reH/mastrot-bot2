const fs = require('fs');
const { execSync } = require('child_process');

const archPath = 'src/server/core/architecture.ts';
const runPath = 'src/server/backtest/run.ts';

const originalArch = fs.readFileSync(archPath, 'utf8');
const originalRun = fs.readFileSync(runPath, 'utf8');

function setConfig(symbols, onlyBull) {
  let archStr = originalArch.replace(
    /export const NormalRsi2TrendTrailingConfig = \{[\s\S]*?\};/m,
    `export const NormalRsi2TrendTrailingConfig = {
  enabled: true,
  allowLong: true,
  allowShort: false,
  rsiLength: 2,
  rsiLongThreshold: 10,
  rsiShortThreshold: 90,
  fastMaLength: 50,
  slowMaLength: 200,
  maType: "EMA",
  shortRequiresRejectionConfirmation: false,
  shortRequiresCloseBelowEma50: false,
  longTrailingStopPercent: 0.02,
  shortTrailingStopPercent: 0.03,
  cooldownBarsAfterExit: 1,
  allowedSymbols: ${symbols ? `[${symbols.map(s => `"${s}"`).join(', ')}]` : 'null'},
};`
  );
  
  if (onlyBull) {
    archStr = archStr.replace(
      /if \(\["CRASH", "EUPHORIA", "TRANSITION", "UNKNOWN", "HIGH_UNCERTAINTY"\]\.includes\(regime\)\)/,
      `if (["CRASH", "EUPHORIA", "TRANSITION", "UNKNOWN", "HIGH_UNCERTAINTY", "BEAR"].includes(regime))`
    );
  }

  fs.writeFileSync(archPath, archStr);
}

function runAndSave(name) {
  console.log(`Running experiment: ${name}`);
  execSync('npx tsx src/server/backtest/run.ts', { stdio: 'inherit' });
  fs.copyFileSync('backtest_report_latest.json', `${name}.json`);
}

// Ensure clean start
fs.writeFileSync(archPath, originalArch);
fs.writeFileSync(runPath, originalRun);

try {
  // A. setup su tutti
  setConfig(null, false);
  runAndSave('A');

  // B. solo btc/eth
  setConfig(["BTC/USD", "ETH/USD"], false);
  runAndSave('B');

  // C. btc/eth/link
  setConfig(["BTC/USD", "ETH/USD", "LINK/USD"], false);
  runAndSave('C');

  // D. bull only
  setConfig(null, true);
  runAndSave('D');
} finally {
  console.log("Restoring original files...");
  fs.writeFileSync(archPath, originalArch);
  fs.writeFileSync(runPath, originalRun);
}
