const fs = require('fs');

function formatMetrics(data) {
  const validTrades = data.trades.filter(t => !t.isContaminated);
  const cleanPnL = data.cleanPnL.toFixed(2);
  const contaminatedPnL = data.contaminatedPnL.toFixed(2);
  const pf = data.stats.profFactor;
  const maxDD = data.stats.maxDD;
  const sharpe = parseFloat(data.stats.sharpe || 0).toFixed(2);
  const calmar = parseFloat(data.stats.calmar || 0).toFixed(2);
  
  const sortedWins = validTrades.filter(t => t.pnl > 0).sort((a,b) => b.pnl - a.pnl);
  const top5PnL = sortedWins.slice(0, 5).reduce((acc, t) => acc + t.pnl, 0);
  const pnlSenzaTop5 = (data.cleanPnL - top5PnL).toFixed(2);
  
  const normal = data.engineStats.normalStats;
  
  let report = `
- Clean PnL: $${cleanPnL}
- Contaminated PnL: $${contaminatedPnL}
- PF: ${pf}
- Max DD: ${maxDD}
- Sharpe: ${sharpe}
- Calmar: ${calmar}
- PnL Senza Top 5: $${pnlSenzaTop5}

#### NORMAL Short Stats:
- shortArmedSetups: ${normal.shortArmedSetups || 0}
- shortConfirmedSetups: ${normal.shortConfirmedSetups || 0}
- entriesShort: ${normal.entriesShort || 0}
- pnlShort: $${(normal.pnlShort || 0).toFixed(2)}
- pfShort: ${Math.abs(normal.pfShort || 0).toFixed(2)}

#### Breakdown per Symbol (Clean)
`;

  if (data.advanced && data.advanced.aggregations && data.advanced.aggregations.bySymbol) {
    for (const st of data.advanced.aggregations.bySymbol) {
      report += `  - ${st.name}: PnL $${(st.pnlNetto || 0).toFixed(2)} |  Wr: ${(st.winRate * 100).toFixed(1)}% | PF: ${(st.profitFactor || 0).toFixed(2)}\n`;
    }
  }

  report += `\n#### Breakdown per Regime (Clean)\n`;
  if (data.advanced && data.advanced.aggregations && data.advanced.aggregations.byRegime) {
    for (const st of data.advanced.aggregations.byRegime) {
      report += `  - ${st.name}: PnL $${(st.pnlNetto || 0).toFixed(2)} | Wr: ${(st.winRate * 100).toFixed(1)}% | PF: ${(st.profitFactor || 0).toFixed(2)}\n`;
    }
  }

  report += `\n#### Breakdown per Side (Clean)\n`;
  if (data.advanced && data.advanced.aggregations && data.advanced.aggregations.bySide) {
    for (const st of data.advanced.aggregations.bySide) {
      report += `  - ${st.name}: PnL $${(st.pnlNetto || 0).toFixed(2)} | Wr: ${(st.winRate * 100).toFixed(1)}% | PF: ${(st.profitFactor || 0).toFixed(2)}\n`;
    }
  }

  report += `\n#### Breakdown per Setup (Clean)\n`;
  if (data.advanced && data.advanced.aggregations && data.advanced.aggregations.bySetup) {
    for (const st of data.advanced.aggregations.bySetup) {
      report += `  - ${st.name}: PnL $${(st.pnlNetto || 0).toFixed(2)} | Wr: ${(st.winRate * 100).toFixed(1)}% | PF: ${(st.profitFactor || 0).toFixed(2)}\n`;
    }
  }
  
  return report;
}

const runs = ['A.json', 'B.json', 'C.json', 'D.json'];

const legenda = `### LEGENDA RUN (A, B, C, D)

Questa legenda descrive la configurazione specifica di ogni run di test per il sottomodulo **NORMAL** (e il suo impatto). L'engine **EXTREME** è mantenuto **identico e sempre attivo** in tutte le run come baseline immutabile.

| Run | Asset Ammessi (NORMAL) | Sottoregimi / Setup (NORMAL) | Regime BEAR in NORMAL | BULL-only in NORMAL | EXTREME engine |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **A** | Tutti (Nessuna restrizione) | Tutti attivi (Short disabilitato per RSI2_TREND_TRAILING) | **Attivo** (ammesso) | Disattivato | Identico |
| **B** | Solo BTC/USD, ETH/USD | Tutti attivi (Short disabilitato per RSI2_TREND_TRAILING) | **Attivo** (ammesso) | Disattivato | Identico |
| **C** | Solo BTC/USD, ETH/USD, LINK/USD | Tutti attivi (Short disabilitato per RSI2_TREND_TRAILING) | **Attivo** (ammesso) | Disattivato | Identico |
| **D** | Tutti (Nessuna restrizione) | Tutti attivi (Short disabilitato per RSI2_TREND_TRAILING) | **Escluso** (aggiunto a blocklist) | **Attivo** (Esclude BEAR) | Identico |
`;

let fullReport = '# RISULTATI ESPERIMENTI MULTIPLI\n\n' + legenda + '\n\n';

for (const rn of runs) {
  if (fs.existsSync(rn)) {
    fullReport += `## RUN: ${rn.replace('.json', '')}\n`;
    try {
        const data = JSON.parse(fs.readFileSync(rn, 'utf8'));
        fullReport += formatMetrics(data) + '\n\n';
    } catch (e) {
        console.error('Error on', rn, e);
        fullReport += 'Errore lettura o parsing file.\n\n';
    }
  }
}

fs.writeFileSync('FINAL_REPORT.md', fullReport);
console.log('Report generato in FINAL_REPORT.md');
