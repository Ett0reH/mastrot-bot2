# Advanced Exit & Risk Dynamics Audit

## 1. MFE / MAE Analysis (Maximum Favorable / Adverse Excursion)
This measures how far a trade went in our favor (MFE) vs against us (MAE) before exiting.

- **Average MFE (All Trades):** 0.70 R
- **Average MAE (All Trades):** 0.33 R
- **Average MFE on *Winning* Trades:** 1.34 R
- **Average MFE on *Losing* Trades:** 0.22 R

> **Insight:** If losing trades have a high MFE (> 1.0 R), it means we are leaving money on the table and letting winners turn into losers. A tighter trailing stop or a Partial Take Profit mechanism might be needed.

## 2. Edge Decay Performance (Time-based exits)
The system uses "Edge Decay" to exit trades that don't move quickly.

- **Total Trades Exited via Edge Decay:** 32
- **Win Rate of Edge Decay Exits:** 93.8%
- **Total PnL from Edge Decay:** $5452.64

> **Insight:** Observe if EDGE_DECAY cuts profits short, or if it reliably stops bleeding from range-bound trades.

## 3. Catastrophic / Initial Stop Hit Rate
Checking how strictly the initial risk holds without failing into extreme loss.

- **Initial Stop Hits:** 2 (0.9% of all trades)
- **Catastrophe Stop Hits:** 1 (0.5% of all trades)
- **Trailing Stop turned into Loss:** 63 (51.2% of negative exits)

## 4. Normal Engine specific: RSI2_TREND_TRAILING
- **Total Normal Engine Trades:** 70
- **Win Rate:** 32.9%
- **PnL:** $-65.53
