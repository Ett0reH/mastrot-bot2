// I run sulla finestra completa 2022-2026 (`--full`) hanno senso solo sul dataset completo. Sul
// dataset recuperato in F0 mancano circa 20 mesi: il backtest calcolerebbe le feature su barre di due
// anni prima e il confronto col percorso live (che ricostruisce solo la storia recente) sarebbe
// fuorviante. Con buchi di oltre 7 giorni il run si ferma e chiede `npm run data:download`.
import type { Candle } from '../../src/engine/data/dataset';
import { longGaps } from '../../src/engine/data/dataset';

const MAX_GAP_MS = 7 * 86_400_000;

export function assertCompleteDataset(data: Record<string, readonly Candle[]>, fromMs: number, toMs: number): void {
  const problems = Object.entries(data).flatMap(([symbol, candles]) => longGaps(candles, fromMs, toMs, MAX_GAP_MS).map((g) => `${symbol} senza dati dal ${g.from} al ${g.to}`));
  if (problems.length === 0) return;
  console.error(`Dataset incompleto per la finestra completa (buchi di oltre 7 giorni):\n- ${problems.join('\n- ')}\nRicostruisci il dataset con \`npm run data:download\` (serve rete verso futures.kraken.com).`);
  process.exit(2);
}
