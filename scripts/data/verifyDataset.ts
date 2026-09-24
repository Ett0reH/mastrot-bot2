// Verifica il dataset 15m: checksum di ogni chunk, validità delle candele, coerenza con il manifest.
// Uso: npm run data:verify [-- --root <dir>]
import { defaultDatasetRoot, readManifest, verifyDataset } from '../../src/engine/data/dataset';

const rootArg = process.argv.indexOf('--root');
const root = rootArg >= 0 ? process.argv[rootArg + 1] : defaultDatasetRoot();
const manifest = readManifest(root);
for (const [symbol, meta] of Object.entries(manifest.symbols)) {
  const bars = meta.chunks.reduce((n, c) => n + c.bars, 0);
  console.log(`${symbol.padEnd(5)} ${String(bars).padStart(7)} candele  coverage: ${meta.coverage.map((r) => `${r.from.slice(0, 16)} → ${r.to.slice(0, 16)}`).join(' | ')}`);
}
const { ok, errors } = verifyDataset(root);
if (!ok) {
  for (const e of errors) console.error(`ERRORE: ${e}`);
  process.exit(1);
}
console.log('Dataset verificato: checksum e candele OK.');
