--- MULTI-YEAR SIMULATION ARCHITECTURE V2 (MAX PERIOD) ---
Setup Expectancy Matrix not found. Run generate_expectancy_matrix.ts to build it.
Precomputing OHLCV...
Cache fully covers up to target end date for BTC/USD.
Precomputed 112869 states for BTC/USD
Cache fully covers up to target end date for ETH/USD.
Precomputed 112954 states for ETH/USD
Cache fully covers up to target end date for SOL/USD.
Precomputed 72658 states for SOL/USD
Cache fully covers up to target end date for LTC/USD.
Precomputed 112779 states for LTC/USD
Cache fully covers up to target end date for XRP/USD.
Precomputed 75700 states for XRP/USD
Cache fully covers up to target end date for DOGE/USD.
Precomputed 112923 states for DOGE/USD
Cache fully covers up to target end date for LINK/USD.
Precomputed 112800 states for LINK/USD
Cache fully covers up to target end date for ADA/USD.
Precomputed 3649 states for ADA/USD

==============================================
====== NEW ARCHITECTURE BACKTEST ===================
==============================================
End Equity (Gross): $20849.97 (Initial: $10000.00)
Total System PnL (Gross): $10849.97
End Equity (Clean-only): $16404.21
Clean PnL: $6404.21
Contaminated PnL: $4445.76

--- RISK TIER BREAKDOWN ---
PnL senza Top 5 winners: $1638.02
PnL senza Top 10 winners: $-610.04
[EXTREME_10] Trades: 240 | Clean PnL: $8852.21 | Clean PF: 1.71
[EXTREME_FALLBACK_5] Trades: 0 | Clean PnL: $0.00 | Clean PF: 0.00
[NORMAL_5] Trades: 5927 | Clean PnL: $-2448.00 | Clean PF: 0.94
[NORMAL_UPGRADED] Trades: 0 | Clean PnL: $0.00 | Clean PF: 0.00
[TRANSITION_BLOCKED] Trades: 0 | Clean PnL: $0.00 | Clean PF: 0.00

--- CHOP REGIME STATS ---
CHOP Detected Candles: 10095
Trades Blocked by CHOP: 604
CHOP Base Entries Executed: 0
Theoretical / Actual PnL in CHOP: $0.00
Clean PnL: $6404.21
Contaminated PnL: $4445.76
Valid Trades: 6167 | Contaminated Trades: 45
Symbols w/ Gaps: LTC/USD, LINK/USD, DOGE/USD, SOL/USD, ETH/USD, XRP/USD, BTC/USD
Total Trades Executed: 6212
Win Rate: 40.6%

--- ENGINE STATS ---
EXTREME Engine: 243 trades | PnL: $9199.91 | PF: 1.74 | WR: 49.0%
NORMAL Engine:  5969 trades | PnL: $1650.06 | PF: 1.04 | WR: 40.2%

--- BREAKOUT RETEST (FASE 7) STATS ---
Candidates: 10705
Confirmed:  3217
Blocked:    7488
Reasons:     {
  'Volatilità esplosiva contro posizione': 2925,
  'RSI ipervenduto sul retest': 1584,
  'BTC non conferma (Breakdown)': 394,
  'RSI ipercomprato sul retest': 2088,
  'Prezzo sopra SMA50': 16,
  'BTC non conferma (Recupero)': 460,
  'Prezzo sotto SMA50': 21
}

--- PROGRESSIVE EDGE DECAY (FASE 9) STATS ---
Trades Closed by EDGE_DECAY_EARLY: 1591 (Normal: 1539, Extreme: 52)
Classical EDGE_DECAY (48 bars): 131
PnL 'Saved' from negative delayed exits: $2184.03
Positive PnL cut short (Premature exits): $16647.83 (on 1081 trades)
Generated backtest_report_fase5.json
