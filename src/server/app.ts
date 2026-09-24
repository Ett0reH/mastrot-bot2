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
  /** Stato del runtime: solo lettura, nessuna logica eseguita (D24). */
  status(): Promise<unknown>;
  /** Riprende gli ingressi. */
  start(): Promise<unknown>;
  /** Pausa: nessun nuovo ingresso; uscite e stop nativi restano attivi. */
  stop(): Promise<unknown>;
  /** Solo shadow: stato nuovo. */
  reset(): Promise<unknown>;
  /** Heartbeat per il cron esterno: verifica che i cicli del runtime girino (503 se no), non esegue logica. */
  cronTick(): Promise<{ isActive: boolean; healthy?: boolean; issues?: string[] }>;
  /** Health dettagliato (F6): modalità, lease, età dei dati, cicli, protezione delle posizioni, errori recenti. */
  health(): Promise<unknown>;
  /** Invia un alert di prova sul canale configurato e ne riporta l'esito. */
  testAlert(): Promise<unknown>;
  /** Report giornalieri (F6): gli ultimi `limit`, dal più recente. */
  dailyReports(limit: number): Promise<unknown[]>;
  /** Report di un giorno UTC (YYYY-MM-DD), null se non esiste. */
  dailyReport(day: string): Promise<unknown | null>;
  /** Kill switch (F5): chiude tutto, verifica il conto flat, ferma il bot. Idempotente. */
  killSwitch(source: string): Promise<unknown>;
  /** Ripresa da REDUCE_ONLY o HALTED con la frase di conferma. */
  resumeRisk(confirmation: string): Promise<unknown>;
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
  // Solo liveness del processo (per il load balancer): i dettagli stanno in /api/health/details.
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', mode: config.mode });
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

  // --- Osservabilità (F6) ---
  app.get('/api/health/details', requireAdmin, run('health', () => deps.engine.health()));
  app.post('/api/alerts/test', requireAdmin, run('alert-test', () => deps.engine.testAlert()));
  app.get('/api/reports/daily', requireAdmin, run('daily-reports', (req) => {
    const limit = Math.min(90, Math.max(1, Number.parseInt(String(req.query.limit ?? '30'), 10) || 30));
    return deps.engine.dailyReports(limit);
  }));
  app.get('/api/reports/daily/:day', requireAdmin, async (req, res) => {
    const day = String(req.params.day);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      res.status(400).json({ error: 'Giorno non valido: usare YYYY-MM-DD' });
      return;
    }
    try {
      const report = await deps.engine.dailyReport(day);
      if (report === null) res.status(404).json({ error: `Nessun report per il ${day}` });
      else res.json(report);
    } catch (error) {
      logError('[API] daily-report fallita', error);
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  // --- Guardrail (F5): kill switch e ripresa manuale ---
  app.post('/api/kill-switch', requireAdmin, run('kill-switch', () => deps.engine.killSwitch('api')));
  app.post('/api/risk/resume', requireAdmin, run('risk-resume', (req) => deps.engine.resumeRisk(typeof req.body?.confirm === 'string' ? req.body.confirm : '')));

  // --- Kraken (admin, solo con ordini abilitati) ---
  app.get('/api/debug-kraken', requireAdmin, requireOrdersEnabled, run('debug-kraken', () => deps.krakenAdmin.debugAccounts()));
  app.post('/api/emergency-kraken-transfer', requireAdmin, requireOrdersEnabled, run('emergency-kraken-transfer', async () => {
    const { logs } = await deps.krakenAdmin.emergencyCloseAndTransfer();
    return { success: true, logs };
  }));

  // --- Cron (token dedicato): solo heartbeat, il motore gira con il proprio scheduler (D24) ---
  // 503 se i cicli del runtime sono fermi: anche il servizio di cron vede il problema.
  app.get('/api/cron/tick', requireCron, async (_req, res) => {
    try {
      const state = await deps.engine.cronTick();
      res.status(state.healthy === false ? 503 : 200).json({ message: 'heartbeat', ...state });
    } catch (error) {
      logError('[API] cron-tick fallita', error);
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  // Rotte /api sconosciute: 404 JSON (non la pagina della SPA).
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Endpoint inesistente' });
  });

  return app;
}
