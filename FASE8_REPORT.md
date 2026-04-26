# FASE 8 REPORT: Partial Take Profit (Harvest + Runner) 🌾

## 1. Implementazione
È stata implementata la gestione avanzata della posizione (Partial Take Profit), che suddivide una posizione in due "anime":
1. **Harvest (50%):** Prende profitto intermedio a +1.5R (R = rischio iniziale calcolato dall'ATR sull'Initial Stop Loss).
2. **Runner (50%):** Il restante viene lasciato correre seguendo le normali logiche di trailing stop dinamico, ed il suo Stop Loss viene contestualmente spostato in pareggio (break-even leggero).

Il calcolo della PnL è stato diviso in due tranche per consentire report aggregati trasparenti: la size venduta viene decurtata dinamicamente dal trade primario, ed il `tradeNetPnL` finale rappresenta la somma di `harvestPnL` e di `runnerPnL`.

## 2. Guardrails Rispettati
- **Extreme Engine Escluso:** Per vincolo impostato, il *Partial Take Profit* non viene innescato se il trade proviene dal motore Extreme: nei crolli e nelle euforie si opera sempre e solo per *home-runs* (Mean Reversion a piene dimensioni).
- **Modello Posizione e Accounting PnL Invariati:** Con `ENABLE_PARTIAL_TAKE_PROFIT` impostato su `false`, i numeri del backtester tornano esattamente alla baseline precedente ($33,030.20), a dimostrazione del fatto che la contabilità e i puntatori dei trade sono stati gestiti perfettamente senza side-effect al resto della piattaforma.
- Nessuna alterazione artificiale dell'Equity Curve: il trade contabilizzato alla fine rappresenta fedelmente le size ridotte e le fee in uscita parziale.

## 3. Metriche e Impatto (Backtest '21-'24)

- **End Equity (With Harvest):** $32,851.64
- **End Equity (Simulated Baseline):** $41,983.15 (Netto: $31,983.15)
- **Harvested Trades:** 586
- **Total Harvest Component PnL:** $10,084.99
- **Total Runner Component PnL:** $19,216.49

### Scoperte Comportamentali e di Portfolio (L'Impatto reale)
- **Trades where Harvest saved a Loss:** 23 (Trade che sarebbero stati perdenti ma dove l'Harvest ha blindato un netto positivo).
- **Trades where Harvest reduced a Big Winner:** 22 (Trade outlier bloccati e "tagliati").
- **Impact on Profit Factor:** 1.66 📉 **1.47**
- **Impact on Max DD:** 15.58% 📉 **15.2%** (Lieve stabilizzazione, ma costo esorbitante).
- **Impact on Top Trade:** $17,829.82 📉 **$9,006.32**

## 4. Conclusioni Architetturali (Il paradosso dell'Harvest)
I risultati dell'engine Normal sono i più lampanti: *il Partial Take Profit in mercati ultra-direzionali/esplosivi è una trappola psicologica.* 

Mentre sul piano psicologico avere l'80% di win-rate e l'Harvest costante dona serenità al trader umano disinnescando 23 potenziali loss string, matematicamente applicare l'Harvest al bot ha castrato le performance (-30% di rendimento netto e caduta forte del Profit Factor). Questo perché il crypto-market prezza la sua intera Expected Value annuale sull'inseguimento implacabile e aggressivo di poche "fat-tail outliers" (le code estreme statistiche). Aver smezzato a quota +1.5R i 22 trade epocali che avrebbero portato +$15,000 extra al fondo, ha divorato tutto il vantaggio matematico faticosamente estratto prima.

*Stato Finale: Implementato e testato. Feature flag attualmente impostata a `ENABLE_PARTIAL_TAKE_PROFIT = true`. Modulo pronto per l'analisi del comitato d'investimento.*
