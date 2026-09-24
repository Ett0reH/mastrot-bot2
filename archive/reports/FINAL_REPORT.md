# FINAL BACKTEST REPORT - NORMAL CONGELATO

## METRICS GLOBALI
- Clean PnL: $27367.57
- Contaminated PnL: $1612.94
- Profit Factor: 1.67
- Max Drawdown: 13.0%
- Sharpe Ratio: 0.97
- Calmar Ratio: 1.59
- PnL (Clean) senza Top 1 trade: $24398.25
- PnL (Clean) senza Top 5 trades: $14679.12

## BREAKDOWN BY ENGINE
- EXTREME: $27668.82 (392 trades)
- NORMAL: $1311.69 (307 trades)

## BREAKDOWN NORMAL BY ASSET (PnL)
- LTC/USD: $130.89
- ETH/USD: $955.34
- DOGE/USD: $-16.55
- BTC/USD: $405.97
- LINK/USD: $-123.11
- SOL/USD: $58.19
- XRP/USD: $-99.05

## BREAKDOWN NORMAL BY REGIME (PnL)
- BULL: $1311.69

## TOTAL BREAKDOWN BY SIDE (Trades)
- SHORT: 199
- LONG: 500

## TOTAL BREAKDOWN BY EXIT REASON (Trades)
- TRAILING_STOP_LOSS: 164
- PROFIT_STOP: 173
- TRAILING_STOP: 307
- CATASTROPHE_STOP: 1
- INVALIDATED_DATA_GAP: 1
- EDGE_DECAY_EXTREME_UNCHANGED: 49
- EDGE_DECAY: 2
- TRAILING_PROFIT_STOP: 1
- INITIAL_STOP_LOSS: 1

## CONTAMINATED TRADES LIST
- 2021-06-21T22:45:00Z | DOGE/USD | LONG | EXTREME | PnL: $1090.16 | Reason: INVALIDATED_DATA_GAP
- 2025-10-10T21:45:00Z | LINK/USD | LONG | EXTREME | PnL: $-206.47 | Reason: TRAILING_STOP_LOSS
- 2025-10-10T23:45:00Z | XRP/USD | LONG | EXTREME | PnL: $371.59 | Reason: PROFIT_STOP
- 2025-10-10T22:45:00Z | DOGE/USD | LONG | EXTREME | PnL: $357.66 | Reason: PROFIT_STOP

**Validazioni Finali:**
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
