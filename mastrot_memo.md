# MASTROT MEMO : ARCHITETTURA E LOGICHE DEL BOT
*Questo file rappresenta lo "storico" dell'architettura e deve essere sempre consultato per non rompere la coerenza del sistema quando si applicano fix o si implementano nuove feature.*

## 1. Visione di Sistema e Architettura Dati
- **Frequenza Dati:** Il sistema si basa su tick a 15m (15 minuti).
- **Aggregazione Strategica (Features):** L'ambiente calcola feature strutturali estrapolate a 1H e 4H partendo dai tick a 15m (es. `sma50_1H`, `sma200_4H`, `atr1H`, `rsi1H`).
- **Capitale e Fees:** Modello configurato su base 10000$ (initialCapital), fee dello 0.05% (0.0005). Slippage e Data Gap Validation integrati nel core.

## 2. Motori Strategici (Trading Regimes)
Il bot smista l'execution su diversi motori in base al Regime del mercato:
1. **MEAN_REVERSION**
2. **EUPHORIA** / **CRASH** (Estremi, focus sui ritracciamenti volatili)
3. **NORMAL** (Usa prevalentemente RSI2_TREND_TRAILING, basso win rate e ratio rischio particolare che va tenuto d'occhio).

## 3. Gestione del Rischio (Exit & Risk Dynamics)
Le logiche di uscita sono complesse e stratificate per preservare l'equità:
- **Quality-Gated Leverage (Introdotta in FASE 10):** Flag che scala attivamente l'esposizione (es. da 5x a 3x) in condizioni avverse (es. MEAN_REVERSION nei CRASH specifici di altcoin come DOGE/LINK). Riduce il rischio di coda.
- **Edge Decay (Time-Based Exit):** Il bot chiude i trade (altissimo Win Rate in uscita, ma piccolo PnL) che mostrano debolezza o mancanza di volatilità nel tempo stabilito, limitando il "bleeding" del PnL.
- **Trailing Stop Loss (TSL):** L'analisi MFE/MAE ha evidenziato che alcuni trade lasciano soldi sul tavolo; il Trailing Stop è vitale e deve muoversi insieme alla confidenza del trend.
- **Catastrophic Stop / Initial Stop:** Strati fissi di blocco del rischio per evitare collassi sui picchi.

## 4. Linee Guida Esecutive e Regole di Coerenza
- **Niente modifica isolata:** Alterare il `Trailing Stop` o i `Regimi` può rompere il delicate equilibrio (es. Edge Decay potrebbe tagliare in anticipo trade destinati a sviluppare la MAE).
- **Controllo Leva Dinamico:** La gestione della marginazione va processata solo ad inizio trade e non alterata in the middle.
- **TypeScript & Build:** Tutto gira internamente su TSX/TSC rigoroso. (`verbatimModuleSyntax` etc.).

## 5. Ultime Modifiche (Aggiornamento Recente)
- Creata la struttura di test in `summa-test.md` che divide l'architettura in 5 Macro-Aree fondamentali (Core Strategy, Risk Management, Trade Lifecycle, Live Engine, Persistence/UI). Tutte le future sessioni di test e analisi profonda dovranno far riferimento a queste macro-aree per isolare i comportamenti (es. Ghost Trades, coerenza UI, disallineamento Kraken).
- *Fix TypeScript Environment:* Corrette le configurazioni di build mancanti e ripristinato il pacchetto dipendenze di base per l'ambiente Node/TypeScript in cui testiamo i fills.
- *Integrazione Leva di FASE 10 confermata nel core e gestita correttamente.*
