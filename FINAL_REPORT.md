# FINAL BACKTEST REPORT - NORMAL CONGELATO

## METRICS GLOBALI
- Clean PnL: $23326.30
- Contaminated PnL: $960.42
- Profit Factor: 1.37
- Max Drawdown: 20.1%
- Sharpe Ratio: 0.83
- Calmar Ratio: 1.11
- PnL (Clean) senza Top 1 trade: $19582.78
- PnL (Clean) senza Top 5 trades: $10992.94

## BREAKDOWN BY ENGINE
- EXTREME: $20842.90 (515 trades)
- NORMAL: $3443.82 (278 trades)

## BREAKDOWN NORMAL BY ASSET (PnL)
- LTC/USD: $-659.57
- DOGE/USD: $152.08
- ETH/USD: $1613.78
- BTC/USD: $1973.32
- LINK/USD: $168.50
- SOL/USD: $56.58
- XRP/USD: $139.14

## BREAKDOWN NORMAL BY REGIME (PnL)
- BULL: $3443.82

## TOTAL BREAKDOWN BY SIDE (Trades)
- SHORT: 66
- LONG: 727

## TOTAL BREAKDOWN BY EXIT REASON (Trades)
- PROFIT_STOP: 209
- TRAILING_STOP: 278
- TRAILING_STOP_LOSS: 223
- CATASTROPHE_STOP: 3
- EDGE_DECAY_EXTREME_UNCHANGED: 73
- INVALIDATED_DATA_GAP: 1
- INITIAL_STOP_LOSS: 4
- EDGE_DECAY: 2

## CONTAMINATED TRADES LIST
- 2021-06-21T22:45:00Z | DOGE/USD | LONG | EXTREME | PnL: $494.18 | Reason: INVALIDATED_DATA_GAP
- 2024-02-26T11:45:00Z | LTC/USD | LONG | NORMAL | PnL: $140.08 | Reason: TRAILING_STOP
- 2024-02-26T07:45:00Z | LINK/USD | LONG | NORMAL | PnL: $53.30 | Reason: TRAILING_STOP
- 2025-10-10T21:45:00Z | LINK/USD | LONG | EXTREME | PnL: $-217.42 | Reason: TRAILING_STOP_LOSS
- 2025-10-10T23:45:00Z | XRP/USD | LONG | EXTREME | PnL: $154.88 | Reason: PROFIT_STOP
- 2025-10-10T22:45:00Z | DOGE/USD | LONG | EXTREME | PnL: $335.41 | Reason: PROFIT_STOP

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
