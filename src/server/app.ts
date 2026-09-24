// App Express del bot: rotte API con autenticazione (F1, D03).
//
// - Le API di controllo (stato, start/stop/reset, debug ed emergenza Kraken) richiedono
//   `Authorization: Bearer <ADMIN_TOKEN>`; se ADMIN_TOKEN non è configurato sono disabilitate (503).
// - /api/cron/tick richiede CRON_TOKEN (header Bearer oppure ?token=).
// - Le risposte d'errore non contengono mai stack trace.
// Le dipendenze (motore, client Kraken, report) sono iniettate: i test usano versioni finte.
import { createHash, timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { EngineConfig } from '../engine/config/config';

export interface EngineControlApi {
  /** Stato del motore (il motore legacy esegue anche un tick: verrà eliminato in F4). */
  status(): Promise<unknown>;
  start(): Promise<unknown>;
  stop(): Promise<unknown>;
  reset(): Promise<unknown>;
  cronTick(): Promise<{ isActive: boolean }>;
}

export interface KrakenAdminApi {
  debugAccounts(): Promise<unknown>;
  emergencyCloseAndTransfer(): Promise<{ logs: string[] }>;
}

export interface AppDeps {
  config: EngineConfig;
  engine: EngineControlApi;
  krakenAdmin: KrakenAdminApi;
  readBacktestReport(): unknown | null;
  logError?(message: string, error: unknown): void;
}

/** Confronto a tempo costante (sugli hash, così anche lunghezze diverse non rivelano nulla). */
export function tokensMatch(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Stato di sistema mostrato dalla dashboard: dati statici, sostituiti da dati reali in F6 (D31).
const SYSTEM_STATE_PLACEHOLDER = {
  session: 'HEALTHY',
  marketStream: 'HEALTHY',
  userStream: 'HEALTHY',
  driftMs: 12,
  modelFreshnessMs: 400,
  regime: 'NORMAL',
  confidence: 0.85,
  uncertainty: false,
  equity: 10000.0,
  cash: 0.0,
  positions: 0,
  orders: 0,
  degradedModes: [] as string[],
  errors: [] as string[],
};

export function createApp(deps: AppDeps): express.Express {
  const { config } = deps;
  const logError = deps.logError ?? ((message: string, error: unknown) => console.error(message, error));
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
    const expected = config.auth.adminToken;
    if (!expected) {
      res.status(503).json({ error: 'ADMIN_TOKEN non configurato sul server: API di controllo disabilitate', code: 'ADMIN_DISABLED' });
      return;
    }
    const token = bearerToken(req);
    if (!token || !tokensMatch(token, expected)) {
      res.status(401).json({ error: 'Token amministratore mancante o non valido', code: 'UNAUTHORIZED' });
      return;
    }
    next();
  };

  const requireCron = (req: Request, res: Response, next: NextFunction) => {
    const expected = config.auth.cronToken;
    if (!expected) {
      res.status(503).json({ error: 'CRON_TOKEN non configurato: endpoint cron disabilitato', code: 'CRON_DISABLED' });
      return;
    }
    const token = bearerToken(req) ?? (typeof req.query.token === 'string' ? req.query.token : null);
    if (!token || !tokensMatch(token, expected)) {
      res.status(401).json({ error: 'Token cron mancante o non valido', code: 'UNAUTHORIZED' });
      return;
    }
    next();
  };

  const requireOrdersEnabled = (_req: Request, res: Response, next: NextFunction) => {
    if (!config.ordersEnabled) {
      res.status(409).json({ error: 'Non disponibile in modalità shadow (nessun accesso ai conti Kraken)', code: 'SHADOW_MODE' });
      return;
    }
    next();
  };

  /** Esegue l'handler; in caso d'errore risponde 500 con il solo messaggio (mai lo stack). */
  const run = (label: string, fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response) => {
    try {
      res.json(await fn(req));
    } catch (error) {
      logError(`[API] ${label} fallita`, error);
      res.status(500).json({ error: errorMessage(error) });
    }
  };

  // --- Pubbliche ---
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', mode: config.mode });
  });

  app.get('/api/system/state', (_req, res) => {
    res.json({ ...SYSTEM_STATE_PLACEHOLDER, lastReconciliation: new Date().toISOString(), tradingMode: config.mode });
  });

  app.get('/api/system/backtest', (_req, res) => {
    const report = deps.readBacktestReport();
    if (report === null) {
      res.status(404).json({ error: 'No backtest data yet' });
      return;
    }
    res.json(report);
  });

  // --- Controllo del motore (admin) ---
  app.get('/api/paper-trading/status', requireAdmin, run('status', () => deps.engine.status()));
  app.post('/api/paper-trading/start', requireAdmin, run('start', () => deps.engine.start()));
  app.post('/api/paper-trading/stop', requireAdmin, run('stop', () => deps.engine.stop()));
  app.post('/api/paper-trading/reset', requireAdmin, run('reset', () => deps.engine.reset()));

  // --- Kraken (admin, solo con ordini abilitati) ---
  app.get('/api/debug-kraken', requireAdmin, requireOrdersEnabled, run('debug-kraken', () => deps.krakenAdmin.debugAccounts()));
  app.post('/api/emergency-kraken-transfer', requireAdmin, requireOrdersEnabled, run('emergency-kraken-transfer', async () => {
    const { logs } = await deps.krakenAdmin.emergencyCloseAndTransfer();
    return { success: true, logs };
  }));

  // --- Cron (token dedicato) ---
  app.get('/api/cron/tick', requireCron, run('cron-tick', async () => {
    const state = await deps.engine.cronTick();
    return { message: 'Cron triggered successfully', isActive: state.isActive };
  }));

  // Rotte /api sconosciute: 404 JSON (non la pagina della SPA).
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Endpoint inesistente' });
  });

  return app;
}
