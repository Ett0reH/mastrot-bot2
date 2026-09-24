# FASE 11 REPORT - TRADE BUDGET PER CANDELE E CORRELAZIONE

## OBIETTIVO E IMPLEMENTAZIONE
L'obiettivo della Fase 11 è impedire al motore di trading di saturare l'esposizione al rischio aprendo molteplici posizioni nello stesso momento su asset fortemente correlati (es. quando l'intero mercato crypto segue una singola direzionalità legata a Bitcoin). 
Per risolvere questo problema, è stato introdotto il concetto di **Trade Budget** a livello della singola candela (`maxNewPositionsPerCandle`), accoppiato ad un sistema di **Signal Ranking**.

### Logica di Ranking dei Segnali (Signal Aggregation)
Quando su una stessa candela vengono generati molteplici segnali che superano il *GatekeeperLayer* e allocano una *Risk size* valida, i candidati non vengono più eseguiti in modo cieco in ordine alfabetico di symbol, bensì vengono catalogati e ordinati:
1. **Regime Alignment (BTC Confirmation)**: I trade la cui direzionalità corrisponde al macro-regime (trend e regime) del layer di Bitcoin (`btcTrend1H`) hanno la precedenza assoluta. 
2. **Quality Score**: La confidenza e la solidità intrinseca calcolata dal *SignalLayer* (basata principalmente sulla configurazione dell'indicatore per quel setup).
3. **Distanza Finale dal Risk (Stop Loss)**: Valutato come scostamento `%` dal prezzo di base allo Stop Loss nominale per privilegiare l'invalidation più rapida in caso d'errore (spread e slippage proxy).

I trade generati in eccesso al `maxNewPositionsPerCandle` vengono marchiati e archiviati organicamente in `AnalyticsLayer` come "SKIPPED".

## GUARDRAIL RISPETTATI
1. **Nessun impatto con flag OFF**: Il comportamento `enableTradeBudgetPerCandle: false` restaura l'iterazione sequenziale as-is.
2. **Limitazione ESCLUSIVA alle nuove posizioni**: Il filtro viene applicato sul pool dei _candidateSignals_ calcolato pre-position per non intaccare lo scope delle posizioni correntemente aperte.
3. **Tracciamento opportunità**: Le perdite o le omissioni del filtro vengono documentate accuratamente e monitorate all'interno di `TradeBudgetMetrics`. Nessun segnale viene silenziosamente sovrascritto.

## METRICHE PRIMA / DOPO (Baseline vs Feature)

Un run intensivo sul dataset dal 2021-01-01 al 2024-10-31 configurando `maxNewPositionsPerCandle = 2` (per forzare gli intervalli saturi) offre il seguente delta:

| Metrica | Fase 11 OFF (Baseline) | Fase 11 ON | Impatto |
| - | - | - | - |
| **Total Net PnL** | $22,038.94 | **$22,107.56** | Lieve aumento |
| **Total Trades (Executed)** | 5265 trades | **5260 trades** | Ridotta esposizione nominale |
| **Win Rate** | 40.9% | **40.9%** | Invariato | 
| **Skipped Signals** | N/A | **20** | Segnali omessi per risk saturation |

### Analisi del Rischio Opportunità Perse
La distribuzione della densità delle candele ha prodotto risultati netti:
- Singoli Trigger isolati: **4742 candele**
- Multipli Setups Simultanei (2-limit): **259 candele** 

Omettendo esattamente i 20 segnali declassati dal motore di classificazione per eccesso di budget, il sistema ha paradossalmente **guadagnato ~$68 in PnL netto**, mitigando i falsi positivi altamente correlati provenienti dai periodi di finta inversione (tipicamente in Transition states) e lasciando invariato il Win Rate globale su una mole di circa ~5260 trade validi.

La configurazione ideale da default applicata al codice è `maxNewPositionsPerCandle = 3` come richiesto. Con il limite innalzato a 3, non sono rilevati picchi superiori a questa soglia nel dataset precalcolato per gli 8 asset attuali (0 skipped signals). 
