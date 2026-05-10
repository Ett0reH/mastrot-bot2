# Summa Test - Piano di Analisi e Testing del Bot

Questo documento scompone l'intera architettura del bot in Macro-Aree e Sotto-Aree. L'obiettivo è fornire una base strutturata per la creazione di prompt di test specifici (Unit Test, Integration Test e Stress Test) in modo da identificare cause profonde (root causes) dei problemi al posto di patch veloci.

---

## Elenco delle Macro-Aree del Progetto

1. **Logica della Strategia (Core Analysis & Signal Generation)**
2. **Filtri di Ingresso e Gestione del Rischio (Gatekeeping & Risk Management)**
3. **Gestione del Ciclo di Vita delle Posizioni (Trade Execution & Exits)**
4. **Live Engine e Sincronizzazione Exchange (Kraken API & State Verification)**
5. **Dati, Stato di Backend e Interfaccia Utente (Persistence & Dashboard)**

---

## Analisi Dettagliata (In corso)

### Macro-Area 1: Logica della Strategia (Core Analysis & Signal Generation)
Questa area si occupa unicamente di "leggere" i dati del mercato ed emettere un potenziale segnale. Non prende decisioni sul capitale o sull'exchange.

**Sotto-Aree di Test:**

*   **1.1 Data Feed e Pre-Processamento (MarketDataLayer)**
    *   _1.1.a_ Correttezza del calcolo matematico degli indicatori (RSI, SMA, ATR, ADX).
    *   _1.1.b_ Sincronizzazione e allineamento temporale (Timeframe 15m vs 1H).
    *   _1.1.c_ Prevenzione del "Look-ahead bias" (lettura errata della candela 1H prima della sua chiusura).

*   **1.2 Classificazione del Regime di Mercato (RegimeLayer)**
    *   _1.2.a_ Logica di allineamento Multi-Timeframe (Global BTC Regime vs Altcoin local regime).
    *   _1.2.b_ Transizioni di stato (Es. da BULL a EUPHORIA, soglie e resistenze).
    *   _1.2.c_ Condizioni di blocco e falso allarme (Es. identificazione sicura del CHOP e neutralizzazione).

*   **1.3 Generazione dei Segnali Operativi (SignalLayer)**
    *   _1.3.a_ Riconoscimento dei pattern statistici Base (RSI2_TREND_TRAILING).
    *   _1.3.b_ Riconoscimento dei pattern Extreme (MEAN_REVERSION).
    *   _1.3.c_ Risoluzione di conflitti (cosa succede se il trend dice LONG ma un indicatore counter-trend dice SHORT contemporaneamente).
    *   _1.3.d_ Rispetto delle Invarianti (es. divieto assoluto di posizioni SHORT nei setup NORMAL).

*   **1.4 Validazione Storica (ExpectancyTracker / Matrix)**
    *   _1.4.a_ Corretto caricamento della matrice di Expectancy generata dal backtest.
    *   _1.4.b_ Interrogazione in realtime dell'Expectancy in base alle logiche del segnale attuale, senza fallire nel caso di matrice vuota o non inizializzata.

### Macro-Area 2: Filtri di Ingresso e Gestione del Rischio (Gatekeeping & Risk Management)
Questa area serve da "buttafuori" e ragioniere del bot. Prende un segnale operativo valido e decide se è statisticamente e finanziariamente sicuro eseguirlo, assegnandogli una dimensione e un livello di rischio.

**Sotto-Aree di Test:**

*   **2.1 Filtri Operativi (GatekeeperLayer)**
    *   _2.1.a_ Blocco regime-specifico (es. blocco transizioni vietate, inibizioni in fase CHOP).
    *   _2.1.b_ Controllo filtri Expectancy (rifiuto del segnale se l'Edge statistico o il profit factor sono sotto la soglia minima).

*   **2.2 Gestione dell'Esposizione e Sizing (RiskLayer)**
    *   _2.2.a_ Classificazione del Rischio e Assegnazione Tier (es. EXTREME_10, NORMAL_5, NORMAL_UPGRADED).
    *   _2.2.b_ Modulazione dinamica della Position Size basata sull'Expectancy e sull'Health Moltiplicator.
    *   _2.2.c_ Calcolo della Leva Finanziaria di sicurezza basata sulla volatilità (ATR e Worst-Case Stop Loss).

*   **2.3 Gestione del Capitale Globale (CapitalManagementLayer)**
    *   _2.3.a_ Limite di esposizione globale (Prevenzione "Out of Margin" o sforamento del massimale investibile).
    *   _2.3.b_ Gestione dell'Equity Risk (Riduzione progressiva del capitale utilizzabile in caso di Drawdown).

### Macro-Area 3: Gestione del Ciclo di Vita delle Posizioni (Trade Execution & Exits)
Questa area monitora i trade attualmente aperti e decide rigorosamente quando è il momento di chiuderli, applicando le regole di sicurezza (Stop Loss) e di estrazione profitti (Take Profit/Edge Decay). È cruciale per evitare "Ghost Trades" disallineati.

**Sotto-Aree di Test:**

*   **3.1 Monitoraggio in Real-Time (State Tracking)**
    *   _3.1.a_ Aggiornamento costante dello stato incrociato della posizione (PnL latente, prezzo attuale vs entry price).
    *   _3.1.b_ Corretta gestione delle collisioni (evitare di aprire duplicati mentre il trade risulta già aperto).

*   **3.2 Meccanismi di Protezione ed Exit Hard (Stop Loss & Take Profit)**
    *   _3.2.a_ Attivazione e trigger matematico dello Stop Loss e del Trailing Stop (garantire che scattino chirurgicamente al prezzo prestabilito).
    *   _3.2.b_ Trigger e validazione dei livelli di Take Profit (specialmente nei trade EXTREME).

*   **3.3 Uscite Morbide e Limiti Temporali (Edge Decay & Regime Invalidation)**
    *   _3.3.a_ Esecuzione del Progressive Edge Decay (chiusura dopo N candele perché il vantaggio statistico è esaurito).
    *   _3.3.b_ Chiusura di emergenza per inversione del Regime di Mercato (es. regime globale crolla improvvisamente).

*   **3.4 Pulizia e Riconciliazione dello Stato Interno (Position Exit Layer)**
    *   _3.4.a_ Marcatura della chiusura definitiva lato software (salvataggio nello storico, reset contatori di rischio).
    *   _3.4.b_ Sincronizzazione dell'uscita (la chiusura logica garantisce che il trade non permanga come "attivo" in memoria).

### Macro-Area 4: Live Engine e Sincronizzazione Exchange (Kraken API & State Verification)
Questa area fa da ponte tra la logica decisionale e il mercato reale. Deve inviare ordini fisici all'exchange, gestire gli errori di rete e assicurarsi che la realtà dell'exchange coincida sempre con lo stato logico del bot, per evitare posizioni orfane o disallineamenti gravi.

**Sotto-Aree di Test:**

*   **4.1 Comunicazione API e Ordini (Kraken adapter)**
    *   _4.1.a_ Creazione, invio e validazione dei parametri degli ordini (Market, Limit, Leva, Margin type).
    *   _4.1.b_ Gestione dei rate limits e degli errori restituiti dall'exchange.

*   **4.2 Resilienza di Rete e Retry (Error Handling)**
    *   _4.2.a_ Intercettazione di timeout, disconnessioni socket e MockCcxtNetworkError.
    *   _4.2.b_ Logica di Retry sicura (quante volte riprovare, con che ritardo, evitando di duplicare gli ordini).

*   **4.3 Riconciliazione Stato Posizioni (State Sync & Verification)**
    *   _4.3.a_ Allineamento tra le posizioni aperte lette dall'exchange e quelle logiche in memoria nel bot.
    *   _4.3.b_ Identificazione e chiusura di "Ghost Trades" (posizioni chiuse sull'exchange ma ancora attive nel bot, o attive sull'exchange e assenti nel bot).
    *   _4.3.c_ Sincronizzazione dei trigger live (es. se un Take Profit o Stop Loss gestito dall'exchange viene colpito).

### Macro-Area 5: Dati, Stato di Backend e Interfaccia Utente (Persistence & Dashboard)
Questa area gestisce la persistenza a lungo termine di tutti i dati (storico dei trade, log operativi, parametri di configurazione) e la loro esposizione sia tramite API interne sia tramite la Dashboard UI per l'utente finale.

**Sotto-Aree di Test:**

*   **5.1 Persistenza dei Dati (Firebase/Database Sync)**
    *   _5.1.a_ Salvataggio consistente di ogni trade e dei suoi aggiornamenti in Firebase (creation, update, closing).
    *   _5.1.b_ Tolleranza agli errori in fase di scrittura (cosa succede se Firebase è irraggiungibile temporaneamente).
    *   _5.1.c_ Recupero sicuro dello stato al riavvio del bot (crash recovery e state reconstruction).

*   **5.2 Logging e Audit Trail (Analytics & Traceability)**
    *   _5.2.a_ Tracciamento cronologico esatto di ogni decisione del bot (Scanning, Rifiuti, Entrate, Uscite) per permettere debug retroattivi.
    *   _5.2.b_ Corretta classificazione e archiviazione delle ragioni di blocco dei trade (es. CHOP, Expectancy insufficiente).

*   **5.3 Backend API & Server Express**
    *   _5.3.a_ Esposizione sicura degli endpoint (es. `/api/system/state`, `/api/data`).
    *   _5.3.b_ Aggiornamento corretto dell'Expectancy Matrix statica richiamata in fase di startup.

*   **5.4 Interfaccia Utente e Dashboard (Frontend Sync & Coherence)**
    *   _5.4.a_ Sincronizzazione in tempo reale degli indicatori di sistema e posizioni aperte (React / Hooks / State).
    *   _5.4.b_ Corretta visualizzazione dello stato dei trade inclusi gli eventuali "Ghost Trades" e storico PnL.
    *   _5.4.c_ Coerenza matematica dei dati aggregati visualizzati (Win Rate, PnL totale, drawdowns calcolati frontend vs backend).
    *   _5.4.d_ Accuratezza del grafico (Charts): coerenza tra le candele renderizzate e i dati storici effettivi, corretto piazzamento dei marker di entrata/uscita.

