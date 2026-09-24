// Ricostruisce il dataset 15m di Kraken Futures (e lo storico dei funding) dalle API pubbliche.
//
// Richiede accesso di rete a futures.kraken.com. Sostituisce i dati del dataset per i simboli
// scaricati (inclusi quelli recuperati da `npm run data:salvage`). Dopo il download:
//   npm run data:verify     → controlla checksum, buchi e coverage
//   npm run golden:update   → rigenera il golden (solo con approvazione: i risultati cambiano)
//
// Uso: npm run data:download -- [--from 2021-11-12] [--to 2026-05-09T00:00:00Z]
//                               [--symbols BTC,ETH,...] [--no-funding] [--root <dir>]
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { KRAKEN_NATIVE_SYMBOLS, defaultDatasetRoot, validateCandles, writeSymbolCandles } from '../../src/engine/data/dataset';
import { defaultFundingRoot, writeFundingRates } from '../../src/engine/data/funding';
import { downloadCandles, downloadFundingRates } from '../../src/engine/data/krakenHistory';

const DEFAULT_SYMBOLS = ['BTC', 'ETH', 'SOL', 'AVAX', 'XRP', 'DOGE', 'LINK', 'ADA'];

function parseArgs(argv: string[]) {
  const opts = {
    from: '2021-11-12T00:00:00Z',
    to: '2026-05-09T00:00:00Z',
    symbols: DEFAULT_SYMBOLS,
    funding: true,
    root: defaultDatasetRoot(),
    fundingRoot: defaultFundingRoot(),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--from') opts.from = argv[++i];
    else if (arg === '--to') opts.to = argv[++i];
    else if (arg === '--symbols') opts.symbols = argv[++i].split(',').map((s) => s.trim().toUpperCase());
    else if (arg === '--no-funding') opts.funding = false;
    else if (arg === '--root') opts.root = argv[++i];
    else throw new Error(`Argomento sconosciuto: ${arg}`);
  }
  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const fromMs = Date.parse(opts.from);
  const toMs = Date.parse(opts.to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) throw new Error('Intervallo --from/--to non valido');
  const stamp = new Date().toISOString().slice(0, 10);
  for (const symbol of opts.symbols) {
    const native = KRAKEN_NATIVE_SYMBOLS[symbol];
    if (!native) throw new Error(`Simbolo non mappato su Kraken Futures: ${symbol}`);
    console.log(`\n=== ${symbol} (${native}) ${opts.from} → ${opts.to}`);
    const candles = await downloadCandles(native, fromMs, toMs, {
      log: (msg) => process.stdout.write(`\r${msg}   `),
    });
    process.stdout.write('\n');
    const validation = validateCandles(candles);
    if (!validation.ok) throw new Error(`${symbol}: candele non valide: ${validation.errors.join('; ')}`);
    const meta = writeSymbolCandles(opts.root, symbol, candles, `kraken-futures charts API trade/15m, scaricato il ${stamp}`, native);
    console.log(`${symbol}: ${candles.length} candele, ${meta.chunks.length} chunk, ${meta.gaps.length} buchi`);
    for (const gap of meta.gaps) console.log(`  buco: ${gap.after} → ${gap.before} (${gap.minutes} min)`);
    if (opts.funding) {
      const rates = await downloadFundingRates(native);
      const inRange = rates.filter((r) => r.t >= fromMs && r.t <= toMs);
      const fmeta = writeFundingRates(opts.fundingRoot, symbol, inRange, `kraken-futures historicalfundingrates, scaricato il ${stamp}`);
      console.log(`${symbol}: ${fmeta.rows} funding rate (${fmeta.from} → ${fmeta.to})`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(`\nDownload fallito: ${(err as Error).message}`);
    process.exit(1);
  });
}
