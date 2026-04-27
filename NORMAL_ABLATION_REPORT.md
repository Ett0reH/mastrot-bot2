# NORMAL RSI2 TREND TRAILING - ABLATION STUDY
Date: 2026-04-27

## INTRODUZIONE
In questa fase è stato condotto un test di ablazione sulla nuova implementazione del \`NormalRsi2TrendTrailingEngine\` per determinare la profittabilità isolata della componente LONG rispetto a quella SHORT e comprendere le interazioni con l'attuale \`ExtremeEngine\`.

La logica della strategia è mantenuta rigorosamente su **RSI(2) + EMA50/200 con uscita tramite Trailing Stop al 2%**, valutata sempre e solo alla *chiusura* della candela a 4H. Nessuna ottimizzazione, filtro o aggiustamento extra è stato applicato. Il periodo di backtest è allineato a quello ripulito per prevenzione gap (2023-07-01 -> 2024-12-31).

---

## 5. SPIEGAZIONE FLUTTUAZIONE TRADE EXTREME
**Perché in alcuni scenari EXTREME passa da 88 a 83 trade nonostante il codice non sia stato toccato?**
Questo è il classico fenomeno dell'**Interferenza Posizionale**.
Il sistema è configurato con un limite *"No Pyramiding"* rigoroso (massimo 1 posizione aperta per simbolo). Quando il motore NORMAL (Long + Short) è abilitato, esso genera 236 trades, occupando la singola "slot" disponibile per i rispettivi simboli al verificarsi della condizione. 
Quando si verifica simultaneamente o conseguentemente un segnale EXTREME per quel medesimo simbolo in quel lasso temporale, l'EXTREME viene bloccato perché il motore di routing previene i conflitti allocativi.
- Nel setup **Short-Only**, il NORMAL genera solo 94 trade, lasciando "liberi" e disponibili i simboli per eseguire fino a **88 trade EXTREME**.
- Nel setup **Long+Short** (completo), il NORMAL occupa i simboli per più tempo e con maggiore frequenza (236 trade), risultando nell'omissione di 5 trade EXTREME e fermando il loro counter a **83**.

---

## 6. SINTESI RISULTATI ABLATIVI

### A. EXTREME + NORMAL [LONG + SHORT]
*Configurazione predefinita corrente.*
- **Final Equity (Gross):** $11,236.47
- **System Net PnL:** +$1,236.47
- **[NORMAL] Performance Isolato:** 236 trades | PnL: +$180.76 | PF: 1.11 | WR: 35.6%
- **[EXTREME] Performance Isolato:** 83 trades | PnL: +$1,055.72 | PF: 1.36 | WR: 43.4%
- **PnL Senza Top 5 Winner:** -$370.28
- **PnL Senza Top 10 Winner:** -$1,194.31

### B. EXTREME + NORMAL [LONG-ONLY]
*Configurazione col NORMAL limitato alle entrate Long in uptrend strutturale.*
- **Final Equity (Gross):** $11,901.31
- **System Net PnL:** +$1,901.31
- **[NORMAL] Performance Isolato:** 142 trades | PnL: +$782.48 | PF: 1.67 | WR: 40.85%
- **[EXTREME] Performance Isolato:** 83 trades | PnL: +$1,118.83 | PF: 1.36 | WR: 43.4%
- **PnL Senza Top 5 Winner:** +$158.44
- **PnL Senza Top 10 Winner:** -$746.95
*Nota: il NORMAL long-only incrementa le performance assolute grazie ai netti differenziali sul win rate (40.8%) rispetto al 27.7% del comparto short. Inoltre è qui che spicca il PF (1.67).*

### C. EXTREME + NORMAL [SHORT-ONLY]
*Configurazione col NORMAL limitato alle entrate Short in downtrend strutturale.*
- **Final Equity (Gross):** $11,009.23
- **System Net PnL:** +$1,009.23
- **[NORMAL] Performance Isolato:** 94 trades | PnL: -$199.97 | PF: 0.49 | WR: 27.7%
- **[EXTREME] Performance Isolato:** 88 trades | PnL: +$1,209.19 | PF: 1.40 | WR: 44.3%
- **PnL Senza Top 5 Winner:** -$538.97
- **PnL Senza Top 10 Winner:** -$1,347.85
*Nota: Questa run documenta come l'intero drawdown o underperformance del pacchetto completo di NORMAL dipenda dalla side SHORT della RSI2 Mean Reversion in trending down conditions over questo timeframe, perdendo una media per trade elevata.*

---

## 7. DETTAGLIO MODIFICHE TECNICHE
1. Eseguiti i tre test iterativamente settando a \`true/false\` in combinazione le flags \`allowLong\` ed \`allowShort\` in \`/src/server/core/architecture.ts\`.
2. Risolto il problema del report bug che dichiarava \`Trades Totali Executed (System): undefined\`.
3. Non ci sono stati interventi su alcun parametro sensibile oltre a \`allowLong\` / \`allowShort\`. Rispettati in toto i limiti ed avoid parameter-hunting and trailing parameter variance (ancorati al 2%).
