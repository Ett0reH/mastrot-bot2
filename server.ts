import "dotenv/config";
import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import { ConfigError, describeConfig } from "./src/engine/config/config";
import { initRuntimeConfig } from "./src/engine/config/runtime";
import { LogAlertSink } from "./src/engine/ops/alerts";
import { createBotRuntime } from "./src/engine/runtime/factory";
import { RuntimeScheduler } from "./src/engine/runtime/scheduler";
import { createApp } from "./src/server/app";
import { createKrakenAdmin } from "./src/server/krakenAdmin";

function loadConfigOrExit() {
  try {
    return initRuntimeConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

const log = (level: "info" | "warn" | "error", message: string) =>
  console.log(JSON.stringify({ type: "log", level, message, at: new Date().toISOString() }));

async function startServer() {
  // Configurazione validata prima di tutto: con una configurazione non valida il server non parte.
  const { config, warnings } = loadConfigOrExit();
  console.log(`[config]\n${describeConfig(config)}`);
  for (const warning of warnings) console.warn(`[config] ATTENZIONE: ${warning}`);

  // Runtime del bot (F4): in demo e live la persistenza è obbligatoria, altrimenti il server non parte.
  let bundle;
  try {
    bundle = await createBotRuntime(config, new LogAlertSink(), log);
  } catch (error) {
    console.error(`[runtime] ${(error as Error).message}`);
    process.exit(1);
  }
  const { runtime } = bundle;
  const scheduler = new RuntimeScheduler(runtime);
  log("info", `runtime ${config.mode} avviato (istanza ${bundle.instanceId}, persistenza ${bundle.persistence})`);
  scheduler.start();

  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  const app = createApp({
    config,
    engine: {
      status: async () => runtime.statusPayload(),
      start: async () => {
        await runtime.resume();
        return runtime.statusPayload();
      },
      stop: async () => {
        await runtime.pause();
        return runtime.statusPayload();
      },
      reset: async () => {
        await runtime.reset();
        return runtime.statusPayload();
      },
      cronTick: async () => ({ isActive: runtime.statusPayload().isActive === true, heartbeat: scheduler.lastHeartbeat }),
      killSwitch: async (source) => runtime.killSwitch(source),
      resumeRisk: async (confirmation) => ({ operationalState: await runtime.resumeRisk(confirmation) }),
    },
    krakenAdmin: createKrakenAdmin(config),
    readBacktestReport: () => {
      try {
        return JSON.parse(fs.readFileSync(path.join(process.cwd(), "backtest_report_latest.json"), "utf8"));
      } catch {
        return null;
      }
    },
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    // Use *all for Express v5, or * for Express v4
    app.get('*all', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  // Arresto ordinato (deploy): stop dei cicli, stato salvato, lease rilasciato.
  const shutdown = async (signal: string) => {
    log("info", `${signal}: arresto del runtime`);
    scheduler.stop();
    await runtime.stop().catch((err) => log("error", `arresto: ${(err as Error).message}`));
    server.close(() => process.exit(0));
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

startServer();
