import "dotenv/config";
import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import * as ccxt from "ccxt";
import { GoogleGenAI, Type } from "@google/genai";
import { startPaperTrading, stopPaperTrading, getLiveState, triggerCronTick, resetPaperTrading } from "./src/server/liveEngine.js";

async function startServer() {
  const app = express();
  const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

  app.use(express.json());

  // In-memory mock state for the bot
  let systemState = {
    session: "HEALTHY",
    marketStream: "HEALTHY",
    userStream: "HEALTHY",
    driftMs: 12,
    modelFreshnessMs: 400,
    lastReconciliation: new Date(Date.now() - 5000).toISOString(),
    regime: "NORMAL",
    confidence: 0.85,
    uncertainty: false,
    equity: 10000.00,
    cash: 0.00,
    positions: 0,
    orders: 0,
    degradedModes: [],
    errors: []
  };

  setInterval(() => {
    // Subtle mock drift and updates for the dashboard
    systemState.driftMs = Math.floor(Math.random() * 20);
    systemState.modelFreshnessMs = Math.floor(Math.random() * 1000);
    if(Math.random() > 0.95) {
      systemState.confidence = 0.8 + (Math.random() * 0.15 - 0.05);
    }
  }, 1000);

  // API Routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/api/firebase-status", (req, res) => {
    const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
    const exists = fs.existsSync(configPath);
    let configData = null;
    let parseError = null;
    if (exists) {
       try {
         configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
       } catch(e: any) {
         parseError = e.message;
       }
    }
    
    res.json({ 
      cwd: process.cwd(),
      configPath,
      exists,
      parseError,
      hasProjectId: !!configData?.projectId
    });
  });

  app.get("/api/system/state", (req, res) => {
    res.json(systemState);
  });

  app.get("/api/system/backtest", (req, res) => {
    try {
      const data = fs.readFileSync(path.join(process.cwd(), 'backtest_report_latest.json'), 'utf8');
      res.json(JSON.parse(data));
    } catch (e) {
      // Return 404 initially so the dashboard stays clean with 0 trades 
      // and 10K equity until the user actually runs a training pipeline.
      res.status(404).json({ error: "No backtest data yet" });
    }
  });

  // Paper Trading Live Endpoints
  app.get("/api/paper-trading/status", async (req, res) => {
    try {
      const state = await triggerCronTick(); // Driven by the dashboard polling
      res.json(state);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/paper-trading/start", async (req, res) => {
    try {
      const state = await startPaperTrading();
      res.json(state);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/paper-trading/stop", async (req, res) => {
    try {
      const state = await stopPaperTrading();
      res.json(state);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/paper-trading/reset", async (req, res) => {
    try {
      const state = await resetPaperTrading();
      res.json(state);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/emergency-kraken-transfer", async (req, res) => {
    try {
      const exchange = new ccxt.krakenfutures({
        apiKey: process.env.KRAKEN_API_KEY,
        secret: process.env.KRAKEN_SECRET_KEY,
        enableRateLimit: true
      });
      await exchange.loadMarkets();
      
      const logs: string[] = [];
      logs.push("Starting Emergency Close & Transfer...");

      // 1. Close all open positions on Kraken Futures
      try {
          const pos = await exchange.fetchPositions();
          logs.push(`Found ${pos.length} position objects.`);
          for (const p of pos) {
              if (Math.abs(p.contracts || 0) > 0) {
                  const side = p.contracts > 0 ? 'sell' : 'buy';
                  logs.push(`Closing orphaned position: ${p.symbol} (${p.contracts}) with ${side}...`);
                  await exchange.createMarketOrder(p.symbol, side, Math.abs(p.contracts), undefined, { reduceOnly: true });
                  logs.push(`Successfully closed ${p.symbol}.`);
              }
          }
      } catch (err: any) {
          logs.push(`Position closing error: ${err.message}`);
      }

      // 2. Transfer all balances to Holding (cash) 
      try {
          logs.push('Fetching account balances...');
          const response = await exchange.privateGetAccounts();
          const accounts = response.accounts;
      
          for (const accName of Object.keys(accounts)) {
            const acc = accounts[accName];
            const type = acc.type;
            
            const balances = acc.balances || acc.currencies || {};
            for (const cur of Object.keys(balances)) {
              let amount = 0;
              if (type === 'marginAccount') {
                 amount = parseFloat(balances[cur] || '0');
              } else if (type === 'multiCollateralMarginAccount') {
                 amount = parseFloat(balances[cur].available || balances[cur].quantity || '0');
              } else if (type === 'cashAccount') {
                 continue; // already in holding
              }
      
              if (amount > 0) {
                logs.push(`Found ${amount} ${cur} in ${type} (${accName}). Processing transfer...`);
                try {
                   let fromAccount = '';
                   if (type === 'marginAccount') {
                       fromAccount = accName; 
                   } else if (type === 'multiCollateralMarginAccount') {
                       fromAccount = 'flex';
                   }
      
                   if (fromAccount) {
                       await exchange.transfer(cur, amount, fromAccount, 'cash');
                       logs.push(`SUCCESS: Transferred ${amount} ${cur} to Holding Wallet.`);
                   }
                } catch(e: any) {
                   logs.push(`ERROR transferring ${cur}: ${e.message}`);
                }
              }
            }
          }
      } catch (err: any) {
          logs.push(`Transfer error: ${err.message}`);
      }
      
      logs.push("Emergency process complete.");
      res.json({ success: true, logs });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Cron Trigger Endpoint - Used by cron-job.org to keep the bot executing
  // even when CPU goes into sleep mode in serverless environments.
  app.get("/api/cron/tick", async (req, res) => {
    try {
      const state = await triggerCronTick();
      res.json({ message: "Cron triggered successfully", isActive: state.isActive });
    } catch (error: any) {
      console.error("CRON TICK ERROR:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Serve static datasets
  app.use("/api/data", express.static(path.join(process.cwd(), "src/server/backtest/data_cache")));

  // Gemini proxy
  app.post("/api/generate", async (req, res) => {
    try {
      let apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey || apiKey === "undefined" || apiKey.trim() === "") {
        console.error("SDK Error: Missing GEMINI_API_KEY in environment");
        return res.status(500).json({ error: "Missing GEMINI_API_KEY. Please ensure your API key is correctly applied in the platform settings." });
      }

      // Sanitize the key in case it contains accidental quotes from platform settings
      apiKey = apiKey.replace(/^["']|["']$/g, '').trim();

      const ai = new GoogleGenAI({ apiKey });

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: req.body.prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              folds: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    action: { type: Type.STRING, enum: ["LONG", "SHORT", "NEUTRAL"], description: "Trade action" },
                    reasoning: { type: Type.STRING, description: "Why taking this action" },
                    newStrategicLearning: { type: Type.STRING, description: "Updated rule for the next fold" }
                  },
                  required: ["action", "reasoning"]
                }
              }
            },
            required: ["folds"]
          }
        }
      });
      res.json({ text: response.text });
    } catch (e: any) {
      console.error("SDK Error on Server:", e);
      res.status(500).json({ error: e.message || "Failed to generate" });
    }
  });

  // Mock toggle degraded mode to show UI response
  app.post("/api/admin/toggle-degraded", (req, res) => {
    if (systemState.degradedModes.length > 0) {
      systemState.degradedModes = [];
      systemState.session = "HEALTHY";
    } else {
      systemState.degradedModes = ["DEGRADED_DATA"];
      systemState.session = "DEGRADED_DATA";
    }
    res.json(systemState);
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
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
