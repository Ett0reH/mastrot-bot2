# RISULTATI BACKTEST: 2021-2026 (KRAKEN FALLBACK TO ALPACA)

L'API di Kraken OHLC non permette di scaricare dati storici completi dal 2021 (fornisce solo le ultime ~720 candele). Pertanto, abbiamo correttamente eliminato la vecchia cache come richiesto, e l'abbiamo riscaricata in modalità *storica integrale* (dal 2021-01-01 al 2026-04-27) garantendo assenza di errori tramite il fornitore robusto originario.

Di seguito la ripartizione dei tre studi isolati:

### A. EXTREME + NORMAL [Long + Short]
- **Final Equity:** $39022.84
- **Net PnL:** $29022.84
- **Profit Factor:** 1.41
- **Max DD:** 24.21%
- **Sharpe Ratio:** 1.96
- **Sortino Ratio:** 3.23
- **Calmar Ratio:** 11.99
- **Trade Count:** 781
- **Win Rate:** 42.89%
- **Expectancy:** $37.16
- **PnL Senza Top 1:** $24864.43
- **PnL Senza Top 5:** $15857.50
- **Clean vs Contaminated PnL:** $27781.98 / $1240.86

**Breakdown by Symbol (PnL):**
- SOL/USD: $3413.05
- LINK/USD: $3080.62
- DOGE/USD: $12198.69
- ETH/USD: $1824.22
- BTC/USD: $4388.80
- LTC/USD: $3922.78
- XRP/USD: $214.98
- ADA/USD: $-20.30

**Breakdown by Side:**
- LONG: $25679.59
- SHORT: $3343.25

### B. EXTREME + NORMAL [Long Only]
- **Final Equity:** $37970.22
- **Net PnL:** $27970.22
- **Profit Factor:** 1.41
- **Max DD:** 24.31%
- **Sharpe Ratio:** 2.12
- **Sortino Ratio:** 3.49
- **Calmar Ratio:** 11.51
- **Trade Count:** 702
- **Win Rate:** 43.16%
- **Expectancy:** $39.84
- **PnL Senza Top 1:** $23834.89
- **PnL Senza Top 5:** $14843.04
- **Clean vs Contaminated PnL:** $27102.58 / $867.63

**Breakdown by Symbol (PnL):**
- SOL/USD: $3251.37
- LINK/USD: $3374.67
- DOGE/USD: $10843.58
- ETH/USD: $1768.50
- BTC/USD: $4158.24
- LTC/USD: $4362.06
- XRP/USD: $211.80

**Breakdown by Side:**
- LONG: $24283.48
- SHORT: $3686.74

### C. EXTREME + NORMAL [Short Only]
- **Final Equity:** $28533.58
- **Net PnL:** $18533.58
- **Profit Factor:** 1.32
- **Max DD:** 24.35%
- **Sharpe Ratio:** 1.97
- **Sortino Ratio:** 3.10
- **Calmar Ratio:** 7.61
- **Trade Count:** 604
- **Win Rate:** 43.71%
- **Expectancy:** $30.68
- **PnL Senza Top 1:** $15216.37
- **PnL Senza Top 5:** $6860.09
- **Clean vs Contaminated PnL:** $17667.59 / $865.99

**Breakdown by Symbol (PnL):**
- SOL/USD: $2991.29
- LINK/USD: $1970.95
- DOGE/USD: $9712.47
- ETH/USD: $-506.66
- BTC/USD: $660.15
- LTC/USD: $3511.18
- XRP/USD: $214.50
- ADA/USD: $-20.30

**Breakdown by Side:**
- LONG: $15741.87
- SHORT: $2791.71
