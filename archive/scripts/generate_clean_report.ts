import * as fs from 'fs';

const dataStr = fs.readFileSync('backtest_report_fase5.json', 'utf8');
const data = JSON.parse(dataStr);
const trades = data.trades;

let engineStats = {
  EXTREME: { cleanPnL: 0, contPnL: 0, cleanTrades: 0, contTrades: 0, cleanGrossProfit: 0, cleanGrossLoss: 0 },
  NORMAL: { cleanPnL: 0, contPnL: 0, cleanTrades: 0, contTrades: 0, cleanGrossProfit: 0, cleanGrossLoss: 0 },
  NONE: { cleanPnL: 0, contPnL: 0, cleanTrades: 0, contTrades: 0, cleanGrossProfit: 0, cleanGrossLoss: 0 }
};

for (const t of trades) {
  const engine = t.engine || 'NONE';
  const isContaminated = t.isContaminated === true;
  if (!engineStats[engine]) {
    engineStats[engine] = { cleanPnL: 0, contPnL: 0, cleanTrades: 0, contTrades: 0, cleanGrossProfit: 0, cleanGrossLoss: 0 };
  }
  
  if (isContaminated) {
    engineStats[engine].contPnL += t.pnl;
    engineStats[engine].contTrades++;
  } else {
    engineStats[engine].cleanPnL += t.pnl;
    engineStats[engine].cleanTrades++;
    if (t.pnl > 0) engineStats[engine].cleanGrossProfit += t.pnl;
    else engineStats[engine].cleanGrossLoss += Math.abs(t.pnl);
  }
}

console.log("1. Engine clean report");
console.log("Engine\tClean PnL\tContaminated PnL\tTrade clean\tTrade contaminated\tPF clean");

for (const engine of ['EXTREME', 'NORMAL', 'NONE']) {
  const s = engineStats[engine];
  if (s.cleanTrades === 0 && s.contTrades === 0) continue;
  const pfClean = s.cleanGrossLoss > 0 ? (s.cleanGrossProfit / s.cleanGrossLoss).toFixed(2) : 'N/A';
  console.log(`${engine}\t$${s.cleanPnL.toFixed(2)}\t$${s.contPnL.toFixed(2)}\t${s.cleanTrades}\t${s.contTrades}\t${pfClean}`);
}
