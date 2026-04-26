import { execSync } from "child_process";
import fs from "fs";

console.log("Setting FASE 10 Flag OFF...");
let archPath = "src/server/core/architecture.ts";
let archCode = fs.readFileSync(archPath, "utf-8");
archCode = archCode.replace("enableQualityGatedLeverage: true,", "enableQualityGatedLeverage: false,");
fs.writeFileSync(archPath, archCode);

execSync("npx tsx src/server/backtest/run.ts", { stdio: "inherit" });
fs.renameSync("backtest_report_fase5.json", "backtest_report_fase10_off.json");

console.log("Setting FASE 10 Flag ON...");
archCode = fs.readFileSync(archPath, "utf-8");
archCode = archCode.replace("enableQualityGatedLeverage: false,", "enableQualityGatedLeverage: true,");
fs.writeFileSync(archPath, archCode);

execSync("npx tsx src/server/backtest/run.ts", { stdio: "inherit" });
fs.renameSync("backtest_report_fase5.json", "backtest_report_fase10_on.json");
