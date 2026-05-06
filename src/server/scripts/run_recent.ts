import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const runFile = path.join(__dirname, "../backtest/run.ts");
let code = fs.readFileSync(runFile, "utf8");

code = code.replace(
  'const start = "2021-01-01T00:00:00Z";',
  'const start = "2026-04-20T00:00:00Z";'
);
code = code.replace(
  'const end = "2026-05-01T00:00:00Z";',
  'const end = "2026-05-05T00:00:00Z";'
);
code = code.replace(
  'backtest_report_2020_2026.json',
  'backtest_report_2w.json'
);

// We also need to change the mega cache file path read if we want to fetch new data.
// But actually run.ts fetches new data if cache isn't there for the specific dates, wait, NO.
// ` megaCacheFile ` has hardcoded "2021-01-01_2026-05-01". If the file exists, it uses it.
// We probably want fresh data for our dates!
code = code.replace(
  'const megaCacheFile = path.join(cacheDir, `${symbol.replace("/", "_")}_15Min_2021-01-01_2026-05-01.json`);',
  'const megaCacheFile = path.join(cacheDir, `${symbol.replace("/", "_")}_15Min_2026-04-20_2026-05-05.json`);'
);

const newFile = path.join(__dirname, "../backtest/run_2w.ts");
fs.writeFileSync(newFile, code);
console.log("Created run_2w.ts");
