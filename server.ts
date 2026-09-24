import "dotenv/config";
import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import { ConfigError, describeConfig } from "./src/engine/config/config";
import { initRuntimeConfig } from "./src/engine/config/runtime";
import { createApp } from "./src/server/app";
import { createKrakenAdmin } from "./src/server/krakenAdmin";
import { startPaperTrading, stopPaperTrading, triggerCronTick, resetPaperTrading } from "./src/server/liveEngine.js";

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

async function startServer() {
  // Configurazione validata prima di tutto: con una configurazione non valida il server non parte.
  const { config, warnings } = loadConfigOrExit();
  console.log(`[config]\n${describeConfig(config)}`);
  for (const warning of warnings) console.warn(`[config] ATTENZIONE: ${warning}`);

  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  const app = createApp({
    config,
    engine: {
      status: triggerCronTick, // il motore legacy esegue un tick a ogni richiesta di stato (rimosso in F4)
      start: startPaperTrading,
      stop: stopPaperTrading,
      reset: resetPaperTrading,
      cronTick: triggerCronTick,
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

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
