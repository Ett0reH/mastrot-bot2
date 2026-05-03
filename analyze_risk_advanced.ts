import fs from "fs";

function advancedRiskAnalysis() {
  const data = JSON.parse(fs.readFileSync("./backtest_report_latest.json", "utf-8"));
  const trades = data.trades || [];

  let html = `# Advanced Exit & Risk Dynamics Audit\n\n`;

  html += `## 1. MFE / MAE Analysis (Maximum Favorable / Adverse Excursion)\n`;
  html += `This measures how far a trade went in our favor (MFE) vs against us (MAE) before exiting.\n\n`;

  let totalMFE = 0, totalMAE = 0;
  let winningMFE = 0, losingMFE = 0;
  let wins = 0, losses = 0;

  trades.forEach((t: any) => {
    const isWin = t.pnl > 0;
    const mfeR = t.mfeR || 0;
    const maeR = t.maeR || 0;

    totalMFE += mfeR;
    totalMAE += maeR;

    if (isWin) {
      wins++;
      winningMFE += mfeR;
    } else {
      losses++;
      losingMFE += mfeR;
    }
  });

  html += `- **Average MFE (All Trades):** ${(totalMFE / trades.length).toFixed(2)} R\n`;
  html += `- **Average MAE (All Trades):** ${(totalMAE / trades.length).toFixed(2)} R\n`;
  html += `- **Average MFE on *Winning* Trades:** ${(winningMFE / wins).toFixed(2)} R\n`;
  html += `- **Average MFE on *Losing* Trades:** ${(losingMFE / losses).toFixed(2)} R\n\n`;

  html += `> **Insight:** If losing trades have a high MFE (> 1.0 R), it means we are leaving money on the table and letting winners turn into losers. A tighter trailing stop or a Partial Take Profit mechanism might be needed.\n\n`;

  html += `## 2. Edge Decay Performance (Time-based exits)\n`;
  html += `The system uses "Edge Decay" to exit trades that don't move quickly.\n\n`;

  const edgeTrades = trades.filter((t: any) => t.reason && t.reason.includes("EDGE_DECAY"));
  const edgeWins = edgeTrades.filter((t: any) => t.pnl > 0);
  const edgeLosses = edgeTrades.filter((t: any) => t.pnl <= 0);

  html += `- **Total Trades Exited via Edge Decay:** ${edgeTrades.length}\n`;
  html += `- **Win Rate of Edge Decay Exits:** ${((edgeWins.length / edgeTrades.length) * 100).toFixed(1)}%\n`;
  html += `- **Total PnL from Edge Decay:** $${edgeTrades.reduce((acc: number, t: any) => acc + t.pnl, 0).toFixed(2)}\n\n`;
  
  html += `> **Insight:** Observe if EDGE_DECAY cuts profits short, or if it reliably stops bleeding from range-bound trades.\n\n`;

  html += `## 3. Catastrophic / Initial Stop Hit Rate\n`;
  html += `Checking how strictly the initial risk holds without failing into extreme loss.\n\n`;

  const initialStops = trades.filter((t: any) => t.reason === "INITIAL_STOP_LOSS").length;
  const catastropheStops = trades.filter((t: any) => t.reason === "CATASTROPHE_STOP").length;
  const trailingLosses = trades.filter((t: any) => t.reason === "TRAILING_STOP_LOSS").length;
  const totalLossesExcludingEdgeDecay = losses - edgeLosses.length;

  html += `- **Initial Stop Hits:** ${initialStops} (${((initialStops / trades.length) * 100).toFixed(1)}% of all trades)\n`;
  html += `- **Catastrophe Stop Hits:** ${catastropheStops} (${((catastropheStops / trades.length) * 100).toFixed(1)}% of all trades)\n`;
  html += `- **Trailing Stop turned into Loss:** ${trailingLosses} (${((trailingLosses / totalLossesExcludingEdgeDecay) * 100).toFixed(1)}% of negative exits)\n\n`;

  html += `## 4. Normal Engine specific: RSI2_TREND_TRAILING\n`;
  const normalTrades = trades.filter((t: any) => t.engine === "NORMAL");
  const normWins = normalTrades.filter((t:any) => t.pnl > 0).length;
  html += `- **Total Normal Engine Trades:** ${normalTrades.length}\n`;
  html += `- **Win Rate:** ${((normWins / normalTrades.length)*100).toFixed(1)}%\n`;
  html += `- **PnL:** $${normalTrades.reduce((acc: number, t: any) => acc + t.pnl, 0).toFixed(2)}\n`;


  fs.writeFileSync("./FINAL_RISK_CHECK.md", html);
  console.log("Written FINAL_RISK_CHECK.md");
}
advancedRiskAnalysis();
