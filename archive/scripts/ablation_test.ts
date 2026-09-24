import { execSync } from 'child_process';
import * as fs from 'fs';

const modes = ["ATTUALE", "OFF_NORMAL", "MENO_AGGRESSIVO", "SOTTO_ENTRY", "DOPO_1R"];

console.log("5. Edge Decay ablation");
console.log("Variante\tPnL\tPF\tDD\tTrade\tPnL Normal\tPnL Extreme");

for (const mode of modes) {
  try {
     // run backtest with specific mode
     execSync(`EDGE_DECAY_MODE=${mode} npx tsx src/server/backtest/run.ts`, { stdio: 'ignore' });
     
     // read output
     const dataStr = fs.readFileSync('backtest_report_fase5.json', 'utf8');
     const data = JSON.parse(dataStr);
     const trades = data.trades;
     
     let totalPnl = 0;
     let grossWin = 0;
     let grossLoss = 0;
     
     let normalPnl = 0;
     let extremePnl = 0;
     let peak = 10000;
     let currentEq = 10000;
     let maxDD = 0;
     
     // Sort trades by exit time
     trades.sort((a,b) => new Date(a.exitTime).getTime() - new Date(b.exitTime).getTime());
     
     for (const t of trades) {
        totalPnl += t.pnl;
        currentEq += t.pnl;
        
        if (currentEq > peak) peak = currentEq;
        let dd = (peak - currentEq) / peak;
        if (dd > maxDD) maxDD = dd;
        
        if (t.pnl > 0) grossWin += t.pnl;
        else grossLoss += Math.abs(t.pnl);
        
        if (t.engine === 'NORMAL') normalPnl += t.pnl;
        else if (t.engine === 'EXTREME') extremePnl += t.pnl;
     }
     
     const pf = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : 'N/A';
     const ddStr = (maxDD * 100).toFixed(1) + '%';
     
     console.log(`${mode}\t$${totalPnl.toFixed(2)}\t${pf}\t${ddStr}\t${trades.length}\t$${normalPnl.toFixed(2)}\t$${extremePnl.toFixed(2)}`);
     
  } catch (e) {
     console.error("Failed for " + mode, e.message);
  }
}
