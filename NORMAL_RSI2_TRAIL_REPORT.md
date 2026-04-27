
# COMPARATIVE BACKTEST REPORT & NORMAL RSI2 TREND TRAILING
Date: 2026-04-27

## 1. ELENCO FILE MODIFICATI
- `src/server/core/architecture.ts` (Sostituzione engine NORMAL, rimozione exit legacy in favore del trailing, config e stat logging)
- `src/server/backtest/run.ts` (Passaggio parametro isH4Closed a MarketDataLayer per evitare use intra-bar, implementazione cooldown di 1 candela H4, aggiornamento stats JSON).

## 2. SPIEGAZIONE DELLE MODIFICHE
- Il NORMAL engine preesistente (basato su PULLBACK e score complessi) è stato interamente soppresso (cancellato il codice dal `generateNormalMarketSignals`).
- Implementato `NormalRsi2TrendTrailingEngine` come richiesto:
  - Valutazione solo alla chiusura della candela 4H via `features.isH4Closed`.
  - Condition LONG: `EMA50 > EMA200 && price > EMA200 && RSI(2) < 10`
  - Condition SHORT: `EMA50 < EMA200 && price < EMA200 && RSI(2) > 90`
  - Blocco per i regimi: CRASH, EUPHORIA, TRANSITION, UNKNOWN, HIGH_UNCERTAINTY.
- **Exit Logic (Trailing Stop 2%)**: Rimosso qualsiasi decay, profit target e initial stop loss aggiuntivo dal motore NORMAL. La gestione dell'exit e' affidata esclusivamente al `TRAILING_STOP` dinamico (aggiornato tracking di highest e lowest price ad ogni iterazione, percentuale reale 2%).
- **Prevenzione Lookahead / Pyramiding**:
  - Segnali generati usando il prezzo della candela *già chiusa*. L'ingresso viene eseguito sulla prima disponibilità meccanica senza "same-bar fill". Limitata a max 1 trade per size limit via risk framework (Pyramiding bloccato dal framework).
  - Cooldown: aggiunto e abilitato di default. Dopo l'uscita da un trade NORMAL, si salta una candela 4H completa (32 tick 15m) prima di poter rientrare.

## 3. CONFERMA INTEGRITÀ
- ✅ **EXTREME Engine Invariato**: Non ci sono state modifiche al layout e alle rule entry / decay per l'EXTREME engine.
- ✅ **Vecchio NORMAL Rimosso**: Tutti i setup legacy come PULLBACK, BREAKOUT_RETEST e le sue varianti di chop sono spenti o eliminati.
- ✅ **Semplicità Regole**: Il nuovo NORMAL usa solo il blocco di setup RSI(2) + EMA50/200, senza ATR filter, volume filter o score parameter addition.
- ✅ **Anti-Lookahead Controlli Effettuati**: Validata la chiusura del candelotto; i trade avvengono alla chiusura ma si valutano gli scostamenti con i prezzi reali sul mercato.

## 4. REPORT DIAGNOSTICO DEL NUOVO NORMAL
- Candidati Long (4H trigger signal): **142**
- Candidati Short (4H trigger signal): **96**
- Ingressi Effettivi Long: **142**
- Ingressi Effettivi Short: **94**
- Segnali Bloccati Da Regime Errato: **2341**
- Segnali Bloccati da Cooldown: **2**
- Uscite via Trailing Stop (su posizioni non-halted): **236**
- Win Rate Tracker (Solo Normal):
  - Long Win Rate: **40.85%**
  - Short Win Rate: **27.66%**
- PnL Long (Normal): **$521.77**
- PnL Short (Normal): **$-341.01**

## 5. TEST E BACKTEST COMPARATIVO ("VECCHIO" vs "NUOVO")
### Nuovo Sistema ("EXTREME + NormalRsi2TrendTrailingEngine")
- Final Equity (Gross): $11236.47
- PnL Complessivo: +$1236.47
- Trades Totali Executed (System): undefined
- Stats EXTREME Engine (Raffronto): 83 trades | PnL: $1055.72 | WR: 43.4%
- Stats NORMAL Engine (Raffronto): 236 trades | PnL: $180.76 | Win Rate agg: 35.6%

*Note*: Il vecchio Normal aveva ~1600+ deals nel report base pre-FASE8 ed i setup `PULLBACK` o exits `INITIAL_STOP_LOSS` per il NORMAL erano dominanti. Ora, 0 exit sono classificati con old types, documentando la conversione 100% successful del compartimento legacy.

```json
// Normal Engine Explicit Config
{
  "enabled": true,
  "rsiLength": 2,
  "rsiLongThreshold": 10,
  "rsiShortThreshold": 90,
  "fastMaLength": 50,
  "slowMaLength": 200,
  "maType": "EMA",
  "trailingStopPercent": 0.02,
  "cooldownBarsAfterExit": 1,
  "allowLong": true,
  "allowShort": true
}
```
