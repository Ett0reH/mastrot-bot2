import * as fs from 'fs';
import { execSync } from 'child_process';

const archPath = 'src/server/core/architecture.ts';

function setConfig(allowLong: boolean, allowShort: boolean) {
  let content = fs.readFileSync(archPath, 'utf8');
  content = content.replace(/allowLong:\s*(true|false)/, `allowLong: ${allowLong}`);
  content = content.replace(/allowShort:\s*(true|false)/, `allowShort: ${allowShort}`);
  fs.writeFileSync(archPath, content);
}

function runBacktest(outputName: string) {
  console.log(`Running backtest for ${outputName}...`);
  execSync('npx tsx src/server/backtest/run.ts', { stdio: 'inherit' });
  fs.copyFileSync('backtest_report_latest.json', outputName);
}

setConfig(true, true);
runBacktest('backtest_ls.json');

setConfig(true, false);
runBacktest('backtest_lo.json');

setConfig(false, true);
runBacktest('backtest_so.json');

setConfig(true, true); // restore
console.log("Experiments completed.");
