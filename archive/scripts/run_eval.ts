import { execSync } from 'child_process';
import * as fs from 'fs';

function evalMode(label: string, filePrefix: string, sedCommand: string) {
  console.log(`Running ${label}...`);
  if (sedCommand) {
     execSync(sedCommand); // I will inject a JS replace instead
  }
  
  execSync(`npx tsx src/server/backtest/run.ts`, { stdio: 'ignore' });
  
  const files = fs.readdirSync('.').filter(f => f.startsWith('backtest_report') && f.endsWith('.json')).map(f => ({ name: f, time: fs.statSync(f).mtime.getTime() })).sort((a,b) => b.time - a.time);
  const latest = files[0].name;
  
  const data = JSON.parse(fs.readFileSync(latest, 'utf8'));
  const trades = data.trades;
  
  let grossWin = 0;
  let grossLoss = 0;
  let normalPnl = 0;
  let extremePnl = 0;
  let chopDecline = data.chopStats?.chopBlockedTradesCount || 0;
  let contaminatedCount = data.contaminatedTradesCount || 0;
  
  // top 5
  const sortedByPnl = [...trades].sort((a,b) => b.pnl - a.pnl);
  let pnlTop5 = 0;
  for(let i=0; i<Math.min(5, sortedByPnl.length); i++) pnlTop5 += sortedByPnl[i].pnl;
  
  for (const t of trades) {
    if (t.pnl > 0) grossWin += t.pnl;
    else grossLoss += Math.abs(t.pnl);
    if (t.engine === 'NORMAL') normalPnl += t.pnl;
    else if (t.engine === 'EXTREME') extremePnl += t.pnl;
  }
  
  const pf = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : 'N/A';
  const ddStr = data.stats?.maxDD || 'N/A';
  const totalPnl = data.netPnL || 0;
  const pnlWithoutTop5 = totalPnl - pnlTop5;
  
  console.log(`${label}: PnL=${totalPnl.toFixed(2)}, PF=${pf}, MaxDD=${ddStr}, Trades=${trades.length}, NormalPnL=${normalPnl.toFixed(2)}, ExtremePnL=${extremePnl.toFixed(2)}, ChopBlocked=${chopDecline}, Contaminated=${contaminatedCount}, PnL_wo_Top5=${pnlWithoutTop5.toFixed(2)}`);
  
  const reasons = data.stats?.exitReasonBreakdown || {};
  console.log(`Reasons: ${JSON.stringify(reasons)}`);
}

console.log("Starting...");
// Run OFF
execSync(`node -e "const fs=require('fs'); let c=fs.readFileSync('src/server/core/architecture.ts','utf8'); c=c.replace(/enableLessAggressiveEdgeDecayNormal: true/g, 'enableLessAggressiveEdgeDecayNormal: false'); fs.writeFileSync('src/server/core/architecture.ts',c);"`);
evalMode("OFF (baseline 2022)", "baseline", "");

// Run ON
execSync(`node -e "const fs=require('fs'); let c=fs.readFileSync('src/server/core/architecture.ts','utf8'); c=c.replace(/enableLessAggressiveEdgeDecayNormal: false/g, 'enableLessAggressiveEdgeDecayNormal: true'); fs.writeFileSync('src/server/core/architecture.ts',c);"`);
evalMode("ON (less aggressive 2022)", "less_aggr", "");


