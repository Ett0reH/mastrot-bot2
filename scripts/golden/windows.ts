// Finestre del golden backtest.
//
// Il dataset completo 2022-01-01 → 2026-05-09 (quello del report di riferimento con 713 trade)
// non è disponibile: le cache sono state troncate dal sync di AI Studio e l'accesso di rete a
// futures.kraken.com è bloccato in questo ambiente. Il golden usa quindi le due finestre di
// dati integri recuperati (vedi scripts/data/salvageLegacyCaches.ts). Servono come prova di
// NON regressione del refactor, non come validazione della strategia.
// Ogni finestra finisce su una candela delle :45, così le posizioni ancora aperte vengono
// chiuse con END_OF_DATA (il codice legacy le perderebbe se l'ultima candela non chiude un'ora).
export interface GoldenWindow {
  id: string;
  start: string;
  end: string;
  symbols: string[];
  note: string;
}

export const GOLDEN_WINDOWS: GoldenWindow[] = [
  {
    id: '2022H1',
    start: '2022-01-01T00:00:00Z',
    end: '2022-06-12T23:45:00Z',
    symbols: ['BTC', 'ETH', 'SOL', 'AVAX', 'XRP', 'DOGE', 'LINK', 'ADA'],
    note: 'Stessi 8 simboli del backtest di riferimento; include i crolli di gennaio e maggio 2022.',
  },
  {
    id: '2026Q2',
    start: '2026-04-23T00:00:00Z',
    end: '2026-05-08T23:45:00Z',
    symbols: ['BTC', 'ETH', 'SOL', 'LTC', 'XRP', 'DOGE', 'LINK', 'ADA'],
    note: 'Le cache brevi integre: manca AVAX, al suo posto LTC (unica cache breve disponibile).',
  },
];

/** Il backtest di riferimento, eseguibile solo dopo `npm run data:download`. */
export const FULL_REFERENCE_WINDOW: GoldenWindow = {
  id: 'FULL-2022-2026',
  start: '2022-01-01T00:00:00Z',
  end: '2026-05-09T00:00:00Z',
  symbols: ['BTC', 'ETH', 'SOL', 'AVAX', 'XRP', 'DOGE', 'LINK', 'ADA'],
  note: 'Stessi parametri del run che ha prodotto backtest_report_latest.json (713 trade, +35,7%).',
};
