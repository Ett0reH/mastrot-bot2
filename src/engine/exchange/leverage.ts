// Leva e margine isolated (F3: D13, D20).
//
// Kraken (DerivativesClient.setLeverageSettings, endpoint leveragepreferences): "When specifying
// a max leverage, the contract's margin mode will be isolated". Prima di ogni ingresso la leva
// viene impostata e RILETTA: se non corrisponde, niente ingresso (il legacy restituiva true
// anche quando l'impostazione falliva e si finiva in cross margin senza saperlo).
// La leva della strategia può essere frazionaria (es. 1,7x); su Kraken si imposta l'intero
// superiore: il margine allocato è un po' minore, ma la liquidazione resta molto oltre gli stop
// (lo stop della strategia rispetta stop × leva ≤ 15%). La leva salvata sul trade è quella della
// strategia e non cambia mai.
import type { KrakenAdapter } from './krakenAdapter';

export function exchangeLeverage(strategyLeverage: number): number {
  if (!(strategyLeverage > 0) || !Number.isFinite(strategyLeverage)) throw new Error(`Leva non valida: ${strategyLeverage}`);
  return Math.max(1, Math.ceil(strategyLeverage - 1e-9));
}

export type LeverageResult = { outcome: 'ok'; leverage: number; changed: boolean } | { outcome: 'failed'; reason: string };

export async function ensureIsolatedLeverage(adapter: KrakenAdapter, symbol: string, strategyLeverage: number): Promise<LeverageResult> {
  const wanted = exchangeLeverage(strategyLeverage);
  let current: number | undefined;
  try {
    current = (await adapter.leverageSettings()).find((p) => p.symbol === symbol)?.maxLeverage;
  } catch (err) {
    return { outcome: 'failed', reason: `lettura della leva fallita: ${(err as Error).message}` };
  }
  if (current === wanted) return { outcome: 'ok', leverage: wanted, changed: false };
  const set = await adapter.setLeverage(symbol, wanted);
  if (set.outcome === 'failed') return { outcome: 'failed', reason: `impostazione della leva fallita: ${set.error.message}` };
  let after: number | undefined;
  try {
    after = (await adapter.leverageSettings()).find((p) => p.symbol === symbol)?.maxLeverage;
  } catch (err) {
    return { outcome: 'failed', reason: `verifica della leva fallita: ${(err as Error).message}` };
  }
  if (after !== wanted) return { outcome: 'failed', reason: `leva non applicata: attesa ${wanted}x isolated, letta ${after === undefined ? 'nessuna (cross margin)' : `${after}x`}` };
  return { outcome: 'ok', leverage: wanted, changed: true };
}
