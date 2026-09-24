# Analisi Debug: Macro-Area 2 (Gatekeeping & Risk Management)

## 1. Mappa del Flusso
1. Il segnale esce dal `SignalLayer` e arriva in `GatekeeperLayer.allowEntry`.
2. Vengono processati i filtri (Quality, Chop, Expectancy, Overextension, Restrizioni Regime).
3. Il Gatekeeper ritorna un `{ allowed: boolean, reason: string, riskModifier: number }`.
4. Se `allowed == true`, si passa al `RiskLayer.calculateRisk`.
5. `RiskLayer` calcola la Size in dollari, poi divide per `features.price` e stabilisce la Leva, lo Stop e il Take Profit.
6. Nel `liveEngine.ts`, il trade calcolato deve scontrarsi con il `CapitalManagementLayer` tramite il moltiplicatore globale e la soglia `MAX_GLOBAL_EXPOSURE`.

## 2. Anomalie Certe e Rischio Operativo

*   **Gatekeeper - Expectancy Bypass per NORMAL**: Nel `GatekeeperLayer.allowEntry`, la chiamata `if (signal.engine !== "NORMAL")` disabilita del tutto il controllo di confidenza Expectancy per i trade trend-following. I trade normali passano anche se il backtest dimostra Profit Factor < 1.0 (perdita matematica garantita).
*   **RiskLayer - Catastrophe Stop Loss Errato in caso di Leva**: Nel `RiskLayer`, se la direzione è LONG, `catastropheStopLoss = features.price * 0.85` (-15%). Ma `leverage` può essere impostato a 5.0 (per setup ad alta confidenza in EUPHORIA). Uno stop al 15% fisico del prezzo sotto moltiplicatore 5x significa una perdita dell'75% del margine impegnato o *la possibile liquidazione dell'account* ben prima dello stop fisico, a seconda degli scaglioni di mantenimento su Kraken Futures. L'Hard Stop dovrebbe scalare in proporzione alla `leverage`.
*   **Private Property Bypass e Fragilità**: `RiskLayer` esegue `const metrics = (ExpectancyTracker as any).matrix?.[key]` per estrarre la expectancy cruda senza usare getter. È un approccio fragile ma funzionale. Se la key (Es. `BTC/USD:USD_EUPHORIA_LONG`) non è identica, cade su `leverage = 2.0` in silenzio.

## 3. Anomalie Probabili

*   **MAX_GLOBAL_EXPOSURE Ignorante del Capitale**: La soglia `MAX_GLOBAL_EXPOSURE = 50000` è hardocoded nel `liveEngine.ts` (riga ~1922). Se `state.balance` è un milione, 50k blocca il potenziale. Se il capitale depositato è solo `$1000`, 50k lascia un'esposizione sproporzionata e mortale in caso di slippage generalizzato.
*   **TargetAlloc & MaxExposureUSDCap**: In `targetAlloc = Math.min(allocatedCapital, maxExposureUsdCap);`, la `maxExposureUsdCap` equivale a `capital * 0.8`. Significa che un singolo trade non supererà mai l'80% dell'intero basket. Accettabile in isolamento, ma non vi è un controllo sul margine bloccato di M/L termine se più trade entrano sul mercato.

## 4. Test Consigliati
1.  **Test Liquidazione Leva 5x**: Creare array in Memory Sandbox con Leva 5 e far scendere il prezzo del Mock del 12%. Verificare se i check marginali restituiscono out-of-margin error da exchange prima del raggiungimento di `features.price * 0.85`.
2.  **Test su Filtro Chop (Segnale NORMAL)**: Passare parametro Chop=true e generare un segnale Normal con signal quality bassissima. Controllare se il Gatekeeper lo blocca (spoiler: da codice non lo fa).
