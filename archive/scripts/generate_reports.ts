import * as fs from 'fs';

const dataStr = fs.readFileSync('backtest_report_fase5.json', 'utf8');
const data = JSON.parse(dataStr);
const trades = data.trades;

console.log("2. Normal Engine breakdown");
// Setup	Trades	PnL	PF	Win rate	Avg PnL	PnL senza top 5
const normalTrades = trades.filter(t => t.engine === 'NORMAL');

const setupStats = {};
for (const t of normalTrades) {
  const s = t.setup || 'UNKNOWN';
  if (!setupStats[s]) {
    setupStats[s] = { trades: 0, pnl: 0, wins: 0, grossProfit: 0, grossLoss: 0, pnls: [] };
  }
  setupStats[s].trades++;
  setupStats[s].pnl += t.pnl;
  setupStats[s].pnls.push(t.pnl);
  if (t.pnl > 0) {
    setupStats[s].wins++;
    setupStats[s].grossProfit += t.pnl;
  } else {
    setupStats[s].grossLoss += Math.abs(t.pnl);
  }
}

console.log("Setup\tTrades\tPnL\tPF\tWin rate\tAvg PnL\tPnL senza top 5");
for (const s in setupStats) {
  const stat = setupStats[s];
  const pf = stat.grossLoss > 0 ? (stat.grossProfit / stat.grossLoss).toFixed(2) : 'N/A';
  const wr = ((stat.wins / stat.trades) * 100).toFixed(1) + '%';
  const avg = (stat.pnl / stat.trades).toFixed(2);
  
  // PnL senza top 5
  stat.pnls.sort((a, b) => b - a);
  let pnlSenzaTop5 = stat.pnl;
  for (let i = 0; i < 5 && i < stat.pnls.length; i++) {
     if (stat.pnls[i] > 0) pnlSenzaTop5 -= stat.pnls[i];
  }
  
  console.log(`${s}\t${stat.trades}\t$${stat.pnl.toFixed(2)}\t${pf}\t${wr}\t$${avg}\t$${pnlSenzaTop5.toFixed(2)}`);
}

console.log("\n3. Breakout Retest report");
console.log("Symbol\tLong/Short\tTrades\tPnL\tPF\tWin rate\tAvg duration");

const breakoutTrades = trades.filter(t => t.setup === 'BREAKOUT_RETEST');
const brStats = {};
for (const t of breakoutTrades) {
  const key = `${t.symbol}_${t.type}`;
  if (!brStats[key]) {
    brStats[key] = { trades: 0, pnl: 0, wins: 0, grossProfit: 0, grossLoss: 0, totalDuration: 0 };
  }
  brStats[key].trades++;
  brStats[key].pnl += t.pnl;
  brStats[key].totalDuration += (t.barsHeld || 0);
  if (t.pnl > 0) {
    brStats[key].wins++;
    brStats[key].grossProfit += t.pnl;
  } else {
    brStats[key].grossLoss += Math.abs(t.pnl);
  }
}

for (const key in brStats) {
  const [sym, dir] = key.split('_');
  const stat = brStats[key];
  const pf = stat.grossLoss > 0 ? (stat.grossProfit / stat.grossLoss).toFixed(2) : 'N/A';
  const wr = ((stat.wins / stat.trades) * 100).toFixed(1) + '%';
  const avgDur = (stat.totalDuration / stat.trades).toFixed(1);
  console.log(`${sym}\t${dir}\t${stat.trades}\t$${stat.pnl.toFixed(2)}\t${pf}\t${wr}\t${avgDur}`);
}

const dataStrChop = fs.readFileSync('backtest_report_fase3_on.json', 'utf8');
const chopData = JSON.parse(dataStrChop);
const chopTrades = chopData.trades.filter(t => t.isChopEntry);

let chopPnl = 0;
let chopGrossWin = 0;
let chopGrossLoss = 0;
let topMissed = 0;
let worstAvoided = 0;

for (const t of chopTrades) {
  chopPnl += t.pnl;
  if (t.pnl > 0) {
     chopGrossWin += t.pnl;
     if (t.pnl > topMissed) topMissed = t.pnl;
  } else {
     chopGrossLoss += Math.abs(t.pnl);
     if (t.pnl < worstAvoided) worstAvoided = t.pnl;
  }
}

const chopPF = chopGrossLoss > 0 ? (chopGrossWin / chopGrossLoss).toFixed(2) : 'N/A';

console.log("\n4. CHOP shadow report");
console.log("Bloccati da CHOP\tPnL teorico\tPF teorico\tTop missed winner\tWorst avoided loser");
console.log(`${chopTrades.length}\t$${chopPnl.toFixed(2)}\t${chopPF}\t$${topMissed.toFixed(2)}\t$${worstAvoided.toFixed(2)}`);
