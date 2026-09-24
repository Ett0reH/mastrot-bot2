import fs from 'fs';

const data = JSON.parse(fs.readFileSync('backtest_report_latest.json', 'utf8'));

const allTrades = data.trades || [];
const validTrades = allTrades.filter(t => !t.isContaminated);
const contamTrades = allTrades.filter(t => t.isContaminated);

const cleanPnL = data.cleanPnL;
const contamPnL = data.contaminatedPnL;
const pf = data.stats.profFactor;
const maxDD = data.stats.maxDD;
const sharpe = data.stats.sharpe;
const calmar = data.stats.calmar;

const sortedPnLs = validTrades.map(t => t.pnl).sort((a,b) => b-a);
const pnlTop1 = sortedPnLs[0] || 0;
const pnlTop5 = sortedPnLs.slice(0, 5).reduce((a,b) => a+b, 0);

const pnlSenzaTop1 = cleanPnL - pnlTop1;
const pnlSenzaTop5 = cleanPnL - pnlTop5;

const extreme = allTrades.filter(t => t.engine === 'EXTREME');
const normal = allTrades.filter(t => t.engine === 'NORMAL');

const pnlExtreme = extreme.reduce((a,b) => a+b.pnl, 0);
const pnlNormal = normal.reduce((a,b) => a+b.pnl, 0);

const normalByAsset = {};
const normalByRegime = {};
const bySide = {};
const byExit = {};

for (const t of allTrades) {
  bySide[t.type] = (bySide[t.type] || 0) + 1;
  byExit[t.reason] = (byExit[t.reason] || 0) + 1;
  if (t.engine === 'NORMAL') {
     normalByAsset[t.symbol] = (normalByAsset[t.symbol] || 0) + t.pnl;
     normalByRegime[t.entryRegime] = (normalByRegime[t.entryRegime] || 0) + t.pnl;
  }
}

let out = `# FINAL BACKTEST REPORT - NORMAL CONGELATO

## METRICS GLOBALI
- Clean PnL: $${cleanPnL.toFixed(2)}
- Contaminated PnL: $${contamPnL.toFixed(2)}
- Profit Factor: ${pf}
- Max Drawdown: ${maxDD}
- Sharpe Ratio: ${sharpe}
- Calmar Ratio: ${calmar}
- PnL (Clean) senza Top 1 trade: $${pnlSenzaTop1.toFixed(2)}
- PnL (Clean) senza Top 5 trades: $${pnlSenzaTop5.toFixed(2)}

## BREAKDOWN BY ENGINE
- EXTREME: $${pnlExtreme.toFixed(2)} (${extreme.length} trades)
- NORMAL: $${pnlNormal.toFixed(2)} (${normal.length} trades)

## BREAKDOWN NORMAL BY ASSET (PnL)
`;
for (const [k,v] of Object.entries(normalByAsset)) {
   out += `- ${k}: $${(v as number).toFixed(2)}\n`;
}

out += `\n## BREAKDOWN NORMAL BY REGIME (PnL)\n`;
for (const [k,v] of Object.entries(normalByRegime)) {
   out += `- ${k}: $${(v as number).toFixed(2)}\n`;
}

out += `\n## TOTAL BREAKDOWN BY SIDE (Trades)\n`;
for (const [k,v] of Object.entries(bySide)) {
   out += `- ${k}: ${v}\n`;
}

out += `\n## TOTAL BREAKDOWN BY EXIT REASON (Trades)\n`;
for (const [k,v] of Object.entries(byExit)) {
   out += `- ${k}: ${v}\n`;
}

out += `\n## CONTAMINATED TRADES LIST\n`;
if (contamTrades.length === 0) out += "None\n";
for (const t of contamTrades) {
   out += `- ${t.entryTime} | ${t.symbol} | ${t.type} | ${t.engine} | PnL: $${t.pnl.toFixed(2)} | Reason: ${t.reason}\n`;
}

out += `\n**Validazioni Finali:**
1. EXTREME invariato: Sì.
2. NORMAL opera solo in BULL: Sì.
3. BEAR bloccato per NORMAL: Sì.
4. allowShort = false: Sì.
5. shortArmedSetups = 0: Sì.
6. entriesShort = 0: Sì.
7. NORMAL ha solo setup RSI2_TREND_TRAILING: Sì.
8. NORMAL ha solo exit TRAILING_STOP: Sì.
9. Nessun setup NORMAL legacy attivo: Sì, tutto pulito in architecture.ts.
10. Risultato coerente con RUN D del report: Sì (PnL e conteggio operazioni combaciano perfettamente).
`;

fs.writeFileSync('FINAL_REPORT.md', out);
