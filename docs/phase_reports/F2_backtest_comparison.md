# F2 — Confronto modello legacy vs modello di esecuzione realistico

> Generato da `npm run backtest:compare`. Dati: finestre del golden (dataset parziale, vedi F0).
> Il confronto out-of-sample 2022-2024 vs 2025-2026 richiede il dataset completo: `npm run data:download`, poi `npm run backtest:compare -- --full`.

## Finestra 2022H1 (2022-01-01 → 2022-06-12, BTC, ETH, SOL, AVAX, XRP, DOGE, LINK, ADA)

| Scenario | Trade | PnL netto | Rend. | Max DD | PF | Win rate | Fee | Funding | Sharpe (giorn.) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Legacy (riferimento) | 52 | +433.44 $ | +4.33% | 5.47% | 1.56 | 55.8% | 54.60 $ | 0.00 $ | 1.39 |
| Solo backstop 3% (0 bps) | 52 | +290.07 $ | +2.90% | 5.63% | 1.33 | 53.8% | 53.99 $ | 0.00 $ | 0.86 |
| Realistico (backstop 3%, slippage 5 bps) | 52 | +230.01 $ | +2.30% | 5.69% | 1.25 | 53.8% | 53.67 $ | 0.00 $ | 0.69 |
| Stress: slippage 10 bps | 52 | +170.11 $ | +1.70% | 5.74% | 1.18 | 53.8% | 53.20 $ | 0.00 $ | 0.52 |
| Stress: fee ×2 (0,10%) + 5 bps | 52 | +170.11 $ | +1.70% | 5.74% | 1.18 | 53.8% | 106.40 $ | 0.00 $ | 0.52 |
| Realistico + funding 0,01%/8h | 52 | +222.00 $ | +2.22% | 5.69% | 1.24 | 53.8% | 53.50 $ | 7.21 $ | 0.67 |
| Alternativa native_intrabar (5 bps) | 53 | −113.83 $ | −1.14% | 4.75% | 0.85 | 39.6% | 53.93 $ | 0.00 $ | -0.43 |

**Legacy (riferimento) — per anno, periodo (2022-2024 vs 2025-2026), motore, simbolo e motivo di uscita**

| Gruppo | Trade | PnL | PF | Win rate |
|---|---:|---:|---:|---:|
| anno 2022 | 52 | +433.44 $ | 1.56 | 55.8% |
| periodo 2022-2024 | 52 | +433.44 $ | 1.56 | 55.8% |
| motore EXTREME | 39 | +398.33 $ | 1.52 | 51.3% |
| motore NORMAL | 13 | +35.11 $ | 2.68 | 69.2% |
| simbolo ADA | 4 | +131.00 $ | 3.53 | 75.0% |
| simbolo AVAX | 9 | +64.03 $ | 1.29 | 55.6% |
| simbolo BTC | 3 | −3.15 $ | 0.59 | 33.3% |
| simbolo DOGE | 6 | −15.25 $ | 0.80 | 66.7% |
| simbolo ETH | 5 | −75.37 $ | 0.20 | 60.0% |
| simbolo LINK | 6 | +290.91 $ | 5.82 | 83.3% |
| simbolo SOL | 7 | +132.00 $ | 3.51 | 57.1% |
| simbolo XRP | 12 | −90.73 $ | 0.58 | 33.3% |
| uscita EDGE_DECAY | 2 | +319.08 $ | ∞ | 100.0% |
| uscita EDGE_DECAY_EXTREME_UNCHANGED | 13 | +534.79 $ | 120.11 | 92.3% |
| uscita PROFIT_STOP | 10 | +216.49 $ | 3.61 | 60.0% |
| uscita TRAILING_STOP | 13 | +35.11 $ | 2.68 | 69.2% |
| uscita TRAILING_STOP_LOSS | 14 | −672.03 $ | 0.00 | 0.0% |

**Realistico (backstop 3%, slippage 5 bps) — per anno, periodo (2022-2024 vs 2025-2026), motore, simbolo e motivo di uscita**

| Gruppo | Trade | PnL | PF | Win rate |
|---|---:|---:|---:|---:|
| anno 2022 | 52 | +230.01 $ | 1.25 | 53.8% |
| periodo 2022-2024 | 52 | +230.01 $ | 1.25 | 53.8% |
| motore EXTREME | 39 | +204.68 $ | 1.23 | 48.7% |
| motore NORMAL | 13 | +25.33 $ | 2.14 | 69.2% |
| simbolo ADA | 4 | +27.82 $ | 1.23 | 50.0% |
| simbolo AVAX | 9 | +43.80 $ | 1.19 | 55.6% |
| simbolo BTC | 3 | −4.13 $ | 0.50 | 33.3% |
| simbolo DOGE | 6 | −38.38 $ | 0.59 | 66.7% |
| simbolo ETH | 5 | −80.62 $ | 0.18 | 60.0% |
| simbolo LINK | 6 | +281.49 $ | 5.62 | 83.3% |
| simbolo SOL | 7 | +120.60 $ | 3.16 | 57.1% |
| simbolo XRP | 12 | −120.56 $ | 0.50 | 33.3% |
| uscita BACKSTOP | 5 | −323.54 $ | 0.00 | 0.0% |
| uscita EDGE_DECAY | 2 | +311.27 $ | ∞ | 100.0% |
| uscita EDGE_DECAY_EXTREME_UNCHANGED | 12 | +493.23 $ | 95.70 | 91.7% |
| uscita PROFIT_STOP | 9 | +237.45 $ | 5.92 | 66.7% |
| uscita TRAILING_STOP | 13 | +25.33 $ | 2.14 | 69.2% |
| uscita TRAILING_STOP_LOSS | 11 | −513.74 $ | 0.00 | 0.0% |

**Gate F2 sul profilo realistico:** PF 1.25 ✅ · max DD 5.69% ✅ · anni solari 2022 +2.30% ✅

## Finestra 2026Q2 (2026-04-23 → 2026-05-08, BTC, ETH, SOL, LTC, XRP, DOGE, LINK, ADA)

| Scenario | Trade | PnL netto | Rend. | Max DD | PF | Win rate | Fee | Funding | Sharpe (giorn.) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Legacy (riferimento) | 4 | +117.37 $ | +1.17% | 0.36% | 183.08 | 75.0% | 3.20 $ | 0.00 $ | 5.57 |
| Solo backstop 3% (0 bps) | 4 | +117.37 $ | +1.17% | 0.36% | 183.08 | 75.0% | 3.20 $ | 0.00 $ | 5.57 |
| Realistico (backstop 3%, slippage 5 bps) | 4 | +114.17 $ | +1.14% | 0.37% | 109.84 | 75.0% | 3.20 $ | 0.00 $ | 5.53 |
| Stress: slippage 10 bps | 4 | +110.96 $ | +1.11% | 0.39% | 77.37 | 75.0% | 3.20 $ | 0.00 $ | 5.49 |
| Stress: fee ×2 (0,10%) + 5 bps | 4 | +110.96 $ | +1.11% | 0.38% | 77.37 | 75.0% | 6.39 $ | 0.00 $ | 5.50 |
| Realistico + funding 0,01%/8h | 4 | +113.52 $ | +1.14% | 0.37% | 101.87 | 75.0% | 3.20 $ | 0.64 $ | 5.49 |
| Alternativa native_intrabar (5 bps) | 4 | +111.64 $ | +1.12% | 0.31% | 66.07 | 50.0% | 2.86 $ | 0.00 $ | 5.26 |

**Legacy (riferimento) — per anno, periodo (2022-2024 vs 2025-2026), motore, simbolo e motivo di uscita**

| Gruppo | Trade | PnL | PF | Win rate |
|---|---:|---:|---:|---:|
| anno 2026 | 4 | +117.37 $ | 183.08 | 75.0% |
| periodo 2025-2026 | 4 | +117.37 $ | 183.08 | 75.0% |
| motore EXTREME | 1 | +97.85 $ | ∞ | 100.0% |
| motore NORMAL | 3 | +19.52 $ | 31.28 | 66.7% |
| simbolo DOGE | 2 | +107.32 $ | ∞ | 100.0% |
| simbolo ETH | 1 | −0.64 $ | 0.00 | 0.0% |
| simbolo LTC | 1 | +10.70 $ | ∞ | 100.0% |
| uscita PROFIT_STOP | 1 | +97.85 $ | ∞ | 100.0% |
| uscita TRAILING_STOP | 3 | +19.52 $ | 31.28 | 66.7% |

**Realistico (backstop 3%, slippage 5 bps) — per anno, periodo (2022-2024 vs 2025-2026), motore, simbolo e motivo di uscita**

| Gruppo | Trade | PnL | PF | Win rate |
|---|---:|---:|---:|---:|
| anno 2026 | 4 | +114.17 $ | 109.84 | 75.0% |
| periodo 2025-2026 | 4 | +114.17 $ | 109.84 | 75.0% |
| motore EXTREME | 1 | +95.87 $ | ∞ | 100.0% |
| motore NORMAL | 3 | +18.30 $ | 18.44 | 66.7% |
| simbolo DOGE | 2 | +104.93 $ | ∞ | 100.0% |
| simbolo ETH | 1 | −1.05 $ | 0.00 | 0.0% |
| simbolo LTC | 1 | +10.28 $ | ∞ | 100.0% |
| uscita PROFIT_STOP | 1 | +95.87 $ | ∞ | 100.0% |
| uscita TRAILING_STOP | 3 | +18.30 $ | 18.44 | 66.7% |

**Gate F2 sul profilo realistico:** PF 109.84 ✅ · max DD 0.37% ✅ · anni solari 2026 +1.14% ✅

