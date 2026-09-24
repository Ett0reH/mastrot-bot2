import "dotenv/config";
import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import { ConfigError, describeConfig } from "./src/engine/config/config";
import { initRuntimeConfig } from "./src/engine/config/runtime";
import { channelSink, FanoutAlertSink } from "./src/engine/ops/alertChannels";
import { LogAlertSink, makeAlert } from "./src/engine/ops/alerts";
import { configSecrets, CycleContext, Logger } from "./src/engine/ops/logger";
import { createBotRuntime } from "./src/engine/runtime/factory";
import { HeartbeatMonitor } from "./src/engine/runtime/heartbeat";
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

async function startServer() {
  // Configurazione validata prima di tutto: con una configurazione non valida il server non parte.
  const { config, warnings } = loadConfigOrExit();
  console.log(`[config]\n${describeConfig(config)}`);
  for (const warning of warnings) console.warn(`[config] ATTENZIONE: ${warning}`);

  // Log JSON con correlation id (F6); i segreti della configurazione non finiscono mai nei log.
  const cycle = new CycleContext();
  const logger = new Logger({ cycle, secrets: configSecrets(config) });
  // Alert: sempre sul log, più il canale configurato (Telegram o webhook).
  const channel = channelSink(config, () => Date.now());
  const alerts = new FanoutAlertSink(
    [
      { name: "log", sink: new LogAlertSink((line) => console.log(line), { cycle, redact: (text) => logger.redact(text) }) },
      ...(channel ? [channel] : []),
    ],
    logger,
  );

  // Runtime del bot (F4): in demo e live la persistenza è obbligatoria, altrimenti il server non parte.
  let bundle;
  try {
    bundle = await createBotRuntime(config, alerts, logger, cycle);
  } catch (error) {
    logger.error(`[runtime] ${(error as Error).message}`);
    process.exit(1);
  }
  const { runtime } = bundle;
  const heartbeat = new HeartbeatMonitor(Date.now(), (level, code, message) => runtime.raiseAlert(level, code, message));
  const scheduler = new RuntimeScheduler(runtime, undefined, { heartbeat });
  logger.info(`runtime ${config.mode} avviato (istanza ${bundle.instanceId}, persistenza ${bundle.persistence}, alert ${channel?.name ?? "solo log"})`);
  scheduler.start();
  // Watchdog con un proprio timer: se lo scheduler si ferma, l'alert parte comunque.
  const watchdog = setInterval(() => void heartbeat.check(Date.now()).catch((err) => logger.error(`watchdog: ${(err as Error).message}`)), 60_000);

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
      cronTick: async () => {
        const beat = await heartbeat.check(Date.now());
        return { isActive: runtime.statusPayload().isActive === true, healthy: beat.healthy, issues: beat.issues, lastProtectionAt: beat.lastProtectionAt, lastDecisionAt: beat.lastDecisionAt };
      },
      health: async () => runtime.health(await heartbeat.check(Date.now())),
      testAlert: async () => {
        if (!channel) throw new Error("ALERT_CHANNEL=none: nessun canale da provare (gli alert vanno solo nel log)");
        const alert = makeAlert(Date.now(), "info", "TEST", `Alert di prova (${config.mode}) delle ${new Date().toISOString()}`);
        await channel.sink.send(alert);
        return { sent: true, channel: channel.name, at: alert.at };
      },
      killSwitch: async (source) => runtime.killSwitch(source),
      resumeRisk: async (confirmation) => ({ operationalState: await runtime.resumeRisk(confirmation) }),
    },
    krakenAdmin: createKrakenAdmin(config),
    logError: (message, error) => logger.error(`${message}: ${error instanceof Error ? error.message : String(error)}`),
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
    logger.info(`${signal}: arresto del runtime`);
    clearInterval(watchdog);
    scheduler.stop();
    await runtime.stop().catch((err) => logger.error(`arresto: ${(err as Error).message}`));
    server.close(() => process.exit(0));
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

startServer();
