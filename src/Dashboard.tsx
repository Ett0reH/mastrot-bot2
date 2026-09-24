// Dashboard del bot (F6): solo dati reali letti dalle API del runtime, nessun valore di esempio.
// - /api/paper-trading/status: stato, posizioni con lo stato dello stop nativo, trade, journal, alert, metriche
// - /api/health/details: lease, età dei dati, cicli, protezione, errori recenti
// - /api/reports/daily: report giornalieri con il confronto con il backtest sugli stessi dati
// Tutte le API richiedono ADMIN_TOKEN (F1). Orari in UTC, come i dati del bot.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Activity, AlertTriangle, CheckCircle2, FileText, Shield, TrendingUp, XCircle } from 'lucide-react';
import { apiFetch, AuthRequiredError, type AuthProblem, getAdminToken, setAdminToken } from './lib/api';

// I payload arrivano dal server, che è la fonte di verità: tipizzati in modo lasco qui.
type Json = any;

const usd = (v?: number | null) => (v == null || !Number.isFinite(v) ? '—' : `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const signedUsd = (v?: number | null) => (v == null ? '—' : `${v > 0 ? '+' : ''}${usd(v)}`);
const pct = (v?: number | null, digits = 2) => (v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(digits)}%`);
const num = (v?: number | null, digits = 2) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(digits));
const size = (v?: number | null) => (v == null || !Number.isFinite(v) ? '—' : String(Number(v.toPrecision(6))));
const price = (v?: number | null) => (v == null || !Number.isFinite(v) ? '—' : v >= 100 ? v.toFixed(2) : v >= 1 ? v.toFixed(4) : v.toPrecision(4));
const utc = (v?: string | number | null) => (v == null ? '—' : `${new Date(v).toISOString().replace('T', ' ').slice(0, 16)} UTC`);
const hhmm = (v?: string | number | null) => (v == null ? '—' : new Date(v).toISOString().slice(11, 16));
function duration(ms?: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const minutes = Math.round(ms / 60_000);
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  return d > 0 ? `${d}g ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const MODE_STYLE: Record<string, string> = {
  shadow: 'text-sky-300 border-sky-400/40 bg-sky-400/10',
  demo: 'text-amber-300 border-amber-400/40 bg-amber-400/10',
  live: 'text-red-300 border-red-500/60 bg-red-500/15',
};
const PROTECTION: Record<string, [string, string]> = {
  NATIVE_STOP_OK: ['Stop nativo OK', 'text-emerald-400 border-emerald-400/40 bg-emerald-400/10'],
  UNPROTECTED: ['Senza stop', 'text-red-400 border-red-500/60 bg-red-500/15'],
  PENDING: ['In attesa', 'text-amber-300 border-amber-400/40 bg-amber-400/10'],
  SIMULATED: ['Stop simulato', 'text-white/60 border-white/20 bg-white/5'],
};
const ACTION_STYLE: Record<string, string> = {
  OPEN: 'text-emerald-400 font-semibold',
  CLOSE: 'text-sky-300 font-semibold',
  HOLD: 'text-white/60',
  NO_SIGNAL: 'text-white/30',
  REJECTED: 'text-red-400 font-semibold',
  NO_DATA: 'text-amber-300',
  PENDING_ORDER: 'text-violet-300',
};
const PARITY: Record<string, [string, string]> = {
  IDENTICAL: ['Identica', 'text-emerald-400 border-emerald-400/40 bg-emerald-400/10'],
  EXPLAINED: ['Differenze spiegate', 'text-sky-300 border-sky-400/40 bg-sky-400/10'],
  DIVERGENT: ['Divergente', 'text-red-400 border-red-500/60 bg-red-500/15'],
  NOT_AVAILABLE: ['Non disponibile', 'text-white/50 border-white/20 bg-white/5'],
};
const LEVEL_STYLE: Record<string, string> = { critical: 'text-red-400', warning: 'text-amber-300', info: 'text-white/50' };

function Badge({ text, className }: { text: string; className: string }) {
  return <span className={`inline-flex items-center px-2 py-0.5 rounded border text-[10px] font-bold tracking-wider uppercase whitespace-nowrap ${className}`}>{text}</span>;
}

function Panel({ title, right, children, className = '' }: { title: string; right?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`border border-white/5 bg-[#1A1C22]/80 rounded-lg overflow-hidden flex flex-col ${className}`}>
      <div className="px-5 py-3 border-b border-white/5 flex items-center justify-between gap-3">
        <span className="font-bold text-[11px] tracking-widest uppercase text-white/80">{title}</span>
        {right}
      </div>
      {children}
    </section>
  );
}

function Kpi({ label, value, sub, tone = 'text-white/90' }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="border border-white/5 bg-[#1A1C22]/80 rounded-lg p-4 min-h-[104px] flex flex-col justify-between">
      <div className="text-[10px] font-bold tracking-widest text-white/40 uppercase">{label}</div>
      <div>
        <div className={`text-2xl font-bold tracking-tight ${tone}`}>{value}</div>
        {sub && <div className="text-[11px] text-white/40 mt-0.5">{sub}</div>}
      </div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="p-10 text-center text-white/25 text-sm">{text}</div>;
}

function Row({ label, value, tone = 'text-white/85' }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="flex justify-between items-center gap-4 py-1.5 border-b border-white/5 last:border-0 text-[12px]">
      <span className="text-white/45">{label}</span>
      <span className={`font-mono text-right ${tone}`}>{value}</span>
    </div>
  );
}

export default function Dashboard() {
  const [tab, setTab] = useState<'live' | 'metrics' | 'reports'>('live');
  const [live, setLive] = useState<Json | null>(null);
  const [health, setHealth] = useState<Json | null>(null);
  const [reports, setReports] = useState<Json[]>([]);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [equityRange, setEquityRange] = useState<'1D' | '7D' | '30D'>('7D');
  const [authProblem, setAuthProblem] = useState<{ code: AuthProblem; message: string } | null>(null);
  const [tokenInput, setTokenInput] = useState('');
  const [hasToken, setHasToken] = useState<boolean>(() => !!getAdminToken());
  const [serverError, setServerError] = useState<string | null>(null);
  const [resetConfirm, setResetConfirm] = useState(false);
  const authBlocked = useRef(!getAdminToken());

  const reportAuthError = useCallback((err: unknown): boolean => {
    if (err instanceof AuthRequiredError) {
      authBlocked.current = true;
      setAuthProblem({ code: err.code, message: err.message });
      return true;
    }
    return false;
  }, []);

  /** GET autenticato: aggiorna lo stato o registra il problema (token o server non raggiungibile). */
  const load = useCallback(
    async (path: string, apply: (data: Json) => void) => {
      if (authBlocked.current) return;
      try {
        const res = await apiFetch(path);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        apply(await res.json());
        setServerError(null);
      } catch (err) {
        if (!reportAuthError(err)) setServerError(`Server non raggiungibile o in errore (${(err as Error).message})`);
      }
    },
    [reportAuthError],
  );

  useEffect(() => {
    if (!hasToken) {
      authBlocked.current = true;
      setAuthProblem({ code: 'UNAUTHORIZED', message: 'Inserisci ADMIN_TOKEN per vedere e controllare il bot.' });
      return;
    }
    const pollStatus = () => load('/api/paper-trading/status', setLive);
    const pollHealth = () => load('/api/health/details', setHealth);
    const pollReports = () => load('/api/reports/daily?limit=14', (data) => setReports(Array.isArray(data) ? data : []));
    pollStatus();
    pollHealth();
    pollReports();
    const timers = [setInterval(pollStatus, 3_000), setInterval(pollHealth, 10_000), setInterval(pollReports, 60_000)];
    return () => timers.forEach(clearInterval);
  }, [hasToken, load]);

  const saveToken = () => {
    const token = tokenInput.trim();
    if (!token) return;
    setAdminToken(token);
    setTokenInput('');
    authBlocked.current = false;
    setAuthProblem(null);
    setHasToken(true);
  };

  const logout = () => {
    setAdminToken(null);
    setHasToken(false);
    setLive(null);
    setHealth(null);
    setReports([]);
  };

  /** POST di controllo; restituisce il corpo JSON o null (errore già mostrato). */
  const post = async (path: string, label: string, body?: unknown): Promise<Json | null> => {
    try {
      const res = await apiFetch(path, { method: 'POST', ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        window.alert(`${label} non eseguito: ${data.error ?? `HTTP ${res.status}`}`);
        return null;
      }
      return data;
    } catch (err) {
      if (!reportAuthError(err)) window.alert(`${label}: ${(err as Error).message}`);
      return null;
    }
  };

  const handleResume = async () => {
    const data = await post('/api/paper-trading/start', 'Ripresa');
    if (data) setLive(data);
  };
  const handlePause = async () => {
    const data = await post('/api/paper-trading/stop', 'Pausa');
    if (data) setLive(data);
  };
  // Kill switch (F5, D30): chiude tutte le posizioni, cancella gli ordini, verifica il conto flat e ferma il bot.
  const handleKillSwitch = async () => {
    if (!window.confirm('KILL SWITCH: chiude TUTTE le posizioni, cancella gli ordini e ferma il bot. Continuare?')) return;
    const data = await post('/api/kill-switch', 'Kill switch');
    if (data) window.alert(`Kill switch: ${data.opState}\n${(data.steps ?? []).join('\n')}`);
  };
  const handleResumeRisk = async () => {
    const confirmation = window.prompt('Ripresa dopo REDUCE_ONLY o kill switch. Scrivi CONFERMO_RIPRESA per confermare:');
    if (!confirmation) return;
    const data = await apiFetch('/api/risk/resume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: confirmation }) })
      .then(async (res) => ({ ok: res.ok, body: await res.json() }))
      .catch((err) => {
        if (!reportAuthError(err)) window.alert(`Errore di ripresa: ${err.message}`);
        return null;
      });
    if (data) window.alert(data.ok ? `Stato operativo: ${data.body.operationalState}` : `Ripresa non eseguita: ${data.body.error}`);
  };
  const handleReset = async () => {
    if (!resetConfirm) {
      setResetConfirm(true);
      setTimeout(() => setResetConfirm(false), 5_000);
      return;
    }
    setResetConfirm(false);
    const data = await post('/api/paper-trading/reset', 'Reset');
    if (data) setLive(data);
  };
  const handleTestAlert = async () => {
    const data = await post('/api/alerts/test', 'Alert di prova');
    if (data) window.alert(`Alert di prova inviato su ${data.channel}`);
  };

  const equityData = useMemo(() => {
    const points: { t: number; equity: number }[] = (live?.equityHistory ?? []).map((p: Json) => ({ t: p.t, equity: p.equity }));
    const span = { '1D': 1, '7D': 7, '30D': 30 }[equityRange] * 86_400_000;
    const last = points.at(-1)?.t ?? 0;
    return points.filter((p) => p.t >= last - span);
  }, [live?.equityHistory, equityRange]);

  const mode: string = live?.tradingMode ?? health?.mode ?? '—';
  const metrics: Json = live?.metrics ?? null;
  const selectedReport = reports.find((r) => r.day === selectedDay) ?? reports[0] ?? null;
  const unprotected = (live?.openPositions ?? []).filter((p: Json) => p.protection === 'UNPROTECTED' || p.protection === 'PENDING');
  const opState: string | undefined = live?.operationalState;
  const warnings: string[] = [
    ...(health && !health.healthy ? health.issues : []),
    ...(live?.runtimeStatus && live.runtimeStatus !== 'RUNNING' ? [`Runtime ${live.runtimeStatus}${live.lastError ? `: ${live.lastError}` : ''}`] : []),
    ...(opState && opState !== 'RUNNING' ? [`Stato operativo ${opState}${opState === 'REDUCE_ONLY' ? ': solo uscite, ripresa manuale' : opState === 'HALTED' ? ': bot fermo dopo il kill switch' : ''}`] : []),
    ...(live?.dailyLossBlockUntil ? [`Perdita giornaliera oltre il limite: nessun ingresso fino a ${utc(live.dailyLossBlockUntil)}`] : []),
    ...(live?.paused ? ['Bot in pausa: nessun nuovo ingresso, uscite e stop attivi'] : []),
  ];

  return (
    <div className="min-h-screen bg-[#111216] text-[#E0E0E0] font-sans flex flex-col">
      <header className="flex-shrink-0 border-b border-white/5 bg-[#1A1C22]/90 px-4 md:px-8 flex items-center justify-between h-[60px] gap-4">
        <div className="flex items-center h-full gap-8">
          <div className="font-bold text-[#3B82F6] text-[18px] tracking-wider">ARBITER</div>
          <nav className="flex gap-6 h-full">
            {([['live', 'Dashboard'], ['metrics', 'Metriche'], ['reports', 'Report']] as const).map(([key, label]) => (
              <button key={key} onClick={() => setTab(key)} className={`h-full border-b-2 font-bold text-[12px] tracking-widest uppercase ${tab === key ? 'border-[#3B82F6] text-[#3B82F6]' : 'border-transparent text-white/40 hover:text-white/80'}`}>
                {label}
              </button>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-4">
          {live && <div className="font-mono text-[#93C5FD] text-sm hidden sm:block">{usd(live.balance)}</div>}
          <span data-testid="mode-badge" className={`px-3 py-1 rounded border font-mono text-[11px] font-bold tracking-widest ${MODE_STYLE[mode] ?? 'text-white/50 border-white/20'}`}>
            {mode.toUpperCase()}
          </span>
          {live?.dataSource && <Badge text={live.dataSource} className="text-violet-300 border-violet-400/40 bg-violet-400/10" />}
          {hasToken && (
            <button onClick={logout} className="text-[10px] font-mono tracking-widest text-white/40 hover:text-white/80 uppercase">
              Esci
            </button>
          )}
        </div>
      </header>

      {authProblem && (
        <div className="bg-[#FFB020]/10 border-b border-[#FFB020]/30 p-4 md:px-8">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 max-w-[1400px] mx-auto">
            <div>
              <h3 className="text-[#FFB020] font-bold uppercase tracking-widest text-[12px] mb-0.5">{authProblem.code === 'ADMIN_DISABLED' ? 'Controllo del bot disabilitato' : 'Accesso richiesto'}</h3>
              <p className="text-[#FFB020]/80 text-[11px] font-mono">{authProblem.code === 'ADMIN_DISABLED' ? 'Il server non ha ADMIN_TOKEN configurato: imposta la variabile e riavvia il server.' : authProblem.message}</p>
            </div>
            {authProblem.code === 'UNAUTHORIZED' && (
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  saveToken();
                }}
              >
                <input type="password" autoComplete="current-password" placeholder="ADMIN_TOKEN" value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} className="bg-[#1A1C22] border border-white/10 rounded px-3 py-2 text-[12px] font-mono text-white/90 w-64" />
                <button type="submit" className="bg-[#FFB020] text-black px-4 py-2 rounded font-bold text-[10px] tracking-widest uppercase">
                  Accedi
                </button>
              </form>
            )}
          </div>
        </div>
      )}

      {serverError && !authProblem && <div className="bg-red-500/10 border-b border-red-500/30 px-4 md:px-8 py-2 text-red-300 text-[12px] font-mono">{serverError}</div>}

      {warnings.length > 0 && (
        <div data-testid="warnings" className="bg-amber-400/10 border-b border-amber-400/30 px-4 md:px-8 py-3">
          <div className="max-w-[1400px] mx-auto flex gap-3 items-start">
            <AlertTriangle className="w-4 h-4 text-amber-300 mt-0.5 flex-shrink-0" />
            <ul className="text-amber-200/90 text-[12px] font-mono space-y-0.5">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <main className="flex-1 p-4 md:p-6 lg:p-8 pb-16">
        <div className="max-w-[1400px] mx-auto flex flex-col gap-5">
          {!live ? (
            <Empty text={authProblem ? 'Accedi per vedere lo stato del bot.' : 'In attesa dello stato del runtime…'} />
          ) : tab === 'live' ? (
            <>
              {/* Controlli */}
              <div className="flex flex-col md:flex-row justify-between md:items-center gap-4 rounded-lg border border-white/5 bg-[#1A1C22]/80 p-5">
                <div className="flex items-center gap-4 flex-wrap">
                  <div>
                    <div className="text-[10px] text-white/40 tracking-widest uppercase mb-1">Stato</div>
                    <div className="flex items-center gap-2">
                      <Badge text={live.status} className={live.isActive ? 'text-emerald-400 border-emerald-400/40 bg-emerald-400/10' : 'text-red-400 border-red-500/50 bg-red-500/10'} />
                      {live.entryBlock && <span className="text-[11px] text-white/40 font-mono">ingressi bloccati: {live.entryBlock}</span>}
                    </div>
                  </div>
                  <div className="text-[11px] text-white/40 font-mono leading-5">
                    <div>ultima decisione: {utc(live.lastDecisionAt)}</div>
                    <div>età dei dati: {live.dataAgeMs == null ? '—' : duration(live.dataAgeMs)}</div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-3">
                  {live.paused ? (
                    <button onClick={handleResume} className="bg-emerald-600 hover:bg-emerald-500 text-white px-5 py-2.5 rounded font-bold text-[11px] tracking-widest uppercase">
                      Riprendi ingressi
                    </button>
                  ) : (
                    <button onClick={handlePause} className="border border-white/20 text-white/80 hover:bg-white/5 px-5 py-2.5 rounded font-bold text-[11px] tracking-widest uppercase">
                      Pausa
                    </button>
                  )}
                  {(opState === 'REDUCE_ONLY' || opState === 'HALTED') && (
                    <button onClick={handleResumeRisk} className="border border-white/20 text-white/80 hover:bg-white/5 px-5 py-2.5 rounded font-bold text-[11px] tracking-widest uppercase">
                      Riprendi ({opState})
                    </button>
                  )}
                  {mode === 'shadow' && (
                    <button onClick={handleReset} className={`border px-5 py-2.5 rounded font-bold text-[11px] tracking-widest uppercase ${resetConfirm ? 'bg-red-600 text-white border-red-600' : 'border-red-500/40 text-red-300 hover:bg-red-500/10'}`}>
                      {resetConfirm ? 'Confermi il reset?' : 'Reset shadow'}
                    </button>
                  )}
                  <button onClick={handleKillSwitch} className="bg-[#B91C1C] hover:bg-[#991B1B] text-white px-5 py-2.5 rounded font-bold text-[11px] tracking-widest uppercase border border-[#B91C1C]">
                    Emergency Kill Switch
                  </button>
                </div>
              </div>

              {/* KPI */}
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
                <Kpi label="PnL netto" value={signedUsd(metrics?.pnl.net)} sub={`${pct(metrics?.pnl.totalReturnPct)} sul capitale di ${usd(live.initialBalance)}`} tone={(metrics?.pnl.net ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'} />
                <Kpi label="PnL realizzato" value={signedUsd(metrics?.pnl.realized)} sub={`non realizzato ${signedUsd(metrics?.pnl.unrealized)}`} />
                <Kpi label="Margine impegnato" value={pct(live.balance > 0 ? (live.marginUsed / live.balance) * 100 : null, 1)} sub={usd(live.marginUsed)} />
                <Kpi label="Posizioni aperte" value={String(live.openPositions.length)} sub={unprotected.length ? `${unprotected.length} senza stop confermato` : 'tutte protette'} tone={unprotected.length ? 'text-red-400' : 'text-white/90'} />
                <Kpi label="Drawdown" value={pct(metrics?.drawdown.currentPct)} sub={`massimo ${pct(metrics?.drawdown.maxPct)}`} />
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
                {/* Equity */}
                <Panel
                  title="Equity del bot"
                  className="lg:col-span-2 h-[340px]"
                  right={
                    <div className="flex gap-1 p-0.5 rounded border border-white/5 bg-black/20">
                      {(['1D', '7D', '30D'] as const).map((r) => (
                        <button key={r} onClick={() => setEquityRange(r)} className={`px-3 py-0.5 text-[10px] rounded ${equityRange === r ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white'}`}>
                          {r}
                        </button>
                      ))}
                    </div>
                  }
                >
                  {equityData.length < 2 ? (
                    <Empty text="Nessun punto di equity ancora (uno per ogni chiusura oraria)." />
                  ) : (
                    <div className="flex-1 pt-4 pr-4">
                      <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
                        <AreaChart data={equityData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                          <defs>
                            <linearGradient id="eq" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="#3B82F6" stopOpacity={0.35} />
                              <stop offset="95%" stopColor="#3B82F6" stopOpacity={0} />
                            </linearGradient>
                          </defs>
                          <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={(v) => new Date(v).toISOString().slice(5, 16).replace('T', ' ')} stroke="rgba(255,255,255,0.05)" tick={{ fill: 'rgba(255,255,255,0.3)', fontSize: 10 }} tickLine={false} axisLine={false} height={20} />
                          <YAxis domain={['auto', 'auto']} tickFormatter={(v) => `$${Math.round(v).toLocaleString('en-US')}`} stroke="rgba(255,255,255,0.05)" tick={{ fill: 'rgba(255,255,255,0.3)', fontSize: 10 }} width={70} tickLine={false} axisLine={false} />
                          <Tooltip contentStyle={{ backgroundColor: '#111216', borderColor: 'rgba(255,255,255,0.1)', fontSize: 12 }} formatter={(v: number) => [usd(v), 'Equity']} labelFormatter={(l) => utc(l as number)} />
                          <Area type="monotone" dataKey="equity" stroke="#93C5FD" strokeWidth={2} fill="url(#eq)" isAnimationActive={false} />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </Panel>

                {/* Health */}
                <Panel
                  title="Salute del runtime"
                  right={health ? health.healthy ? <Badge text="Sano" className="text-emerald-400 border-emerald-400/40 bg-emerald-400/10" /> : <Badge text="Problemi" className="text-red-400 border-red-500/50 bg-red-500/10" /> : null}
                >
                  {!health ? (
                    <Empty text="In attesa dell'health…" />
                  ) : (
                    <div className="px-5 py-3">
                      <Row label="Runtime" value={`${health.runtimeStatus} · ${health.operationalState}`} />
                      <Row label="Lease" value={health.lease.valid ? `valido (epoch ${health.lease.epoch}, scade ${hhmm(health.lease.expiresAt)})` : `NON valido: ${health.lease.reason}`} tone={health.lease.valid ? 'text-white/85' : 'text-red-400'} />
                      <Row label="Ultima candela" value={health.data.lastSlot ? `${utc(health.data.lastSlot)} (${duration(health.data.ageMs)} fa)` : 'nessuna'} tone={health.data.stale ? 'text-red-400' : 'text-white/85'} />
                      <Row label="Heartbeat" value={health.heartbeat ? (health.heartbeat.healthy ? `ok · protezione ${hhmm(health.heartbeat.lastProtectionAt)}` : health.heartbeat.issues.join('; ')) : '—'} tone={health.heartbeat && !health.heartbeat.healthy ? 'text-red-400' : 'text-white/85'} />
                      <Row label="Posizioni protette" value={health.allProtected ? 'tutte' : 'NO'} tone={health.allProtected ? 'text-emerald-400' : 'text-red-400'} />
                      <Row label="Scritture archivio oggi" value={`${health.persistence.writes.writes} / ${health.persistence.writes.budget}`} />
                      <Row label="Cicli" value={`${health.cycles.decisionTicks} decisioni · ${health.cycles.protectionTicks} protezione · ${health.cycles.failedTicks} falliti`} />
                      <div className="mt-3 text-[10px] font-bold tracking-widest text-white/40 uppercase">Errori recenti</div>
                      {health.recentErrors.length === 0 ? (
                        <div className="text-[11px] text-white/30 py-1">nessuno</div>
                      ) : (
                        <ul className="max-h-[110px] overflow-y-auto text-[11px] font-mono space-y-1 mt-1">
                          {health.recentErrors.slice(0, 8).map((e: Json, i: number) => (
                            <li key={i} className={LEVEL_STYLE[e.level === 'error' ? 'critical' : e.level] ?? 'text-white/60'}>
                              {hhmm(e.at)} {e.code ? `${e.code}: ` : ''}
                              {e.message}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </Panel>
              </div>

              {/* Posizioni */}
              <Panel title="Posizioni aperte" right={<span className="text-[10px] text-white/40 font-mono">stop della strategia alla chiusura 1H · stop nativo su Kraken</span>}>
                {live.openPositions.length === 0 ? (
                  <Empty text="Nessuna posizione aperta." />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-[12px] whitespace-nowrap">
                      <thead className="text-white/35 text-[10px] tracking-widest uppercase border-b border-white/5">
                        <tr>
                          {['Simbolo', 'Lato', 'Leva', 'Size', 'Ingresso', 'Ultimo', 'Stop strategia', 'Stop nativo', 'Protezione', 'PnL non realizzato'].map((h) => (
                            <th key={h} className="px-4 py-3 font-normal">
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {live.openPositions.map((p: Json) => {
                          const [label, style] = PROTECTION[p.protection] ?? [p.protection, 'text-white/60 border-white/20'];
                          return (
                            <tr key={p.id} className="border-b border-white/5">
                              <td className="px-4 py-3 font-semibold text-white/90">{p.symbol}</td>
                              <td className="px-4 py-3">
                                <Badge text={p.direction} className={p.direction === 'LONG' ? 'text-emerald-400 border-emerald-400/40' : 'text-red-400 border-red-500/40'} />
                              </td>
                              <td className="px-4 py-3 text-white/60">{num(p.leverage, 1)}x</td>
                              <td className="px-4 py-3">{size(p.size)}</td>
                              <td className="px-4 py-3">{price(p.entryPrice)}</td>
                              <td className="px-4 py-3">{price(p.lastPrice)}</td>
                              <td className="px-4 py-3 text-red-300">{price(p.currentStopLoss)}</td>
                              <td className="px-4 py-3 text-red-300">{price(p.nativeStopLevel)}</td>
                              <td className="px-4 py-3">
                                <Badge text={label} className={style} />
                              </td>
                              <td className={`px-4 py-3 font-semibold ${p.unrealizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{signedUsd(p.unrealizedPnl)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>

              <Panel title="Trade chiusi" right={<span className="text-[10px] text-white/40">{live.closedTrades.length} più recenti</span>}>
                  {live.closedTrades.length === 0 ? (
                    <Empty text="Nessun trade chiuso." />
                  ) : (
                    <div className="overflow-auto max-h-[360px]">
                      <table className="w-full text-left text-[12px] whitespace-nowrap">
                        <thead className="text-white/35 text-[10px] tracking-widest uppercase border-b border-white/5 sticky top-0 bg-[#1A1C22]">
                          <tr>
                            {['Chiuso', 'Simbolo', 'Lato', 'Prezzo ingresso', 'Prezzo uscita', 'Motivo', 'PnL', 'Fee'].map((h, i) => (
                              <th key={i} className="px-4 py-2.5 font-normal">
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {live.closedTrades.map((t: Json, i: number) => (
                            <tr key={i} className="border-b border-white/5">
                              <td className="px-4 py-2.5 text-white/50">{utc(t.exitTime)}</td>
                              <td className="px-4 py-2.5 font-semibold">{t.symbol.split('/')[0]}</td>
                              <td className="px-4 py-2.5">{t.type}</td>
                              <td className="px-4 py-2.5">{price(t.entryPrice)}</td>
                              <td className="px-4 py-2.5">{price(t.exitPrice)}</td>
                              <td className="px-4 py-2.5 text-white/50 text-[10px] uppercase">{t.reason}</td>
                              <td className={`px-4 py-2.5 font-semibold ${t.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{signedUsd(t.pnl)}</td>
                              <td className="px-4 py-2.5 text-white/50">{t.costs ? usd(t.costs.entryFee + t.costs.exitFee) : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
              </Panel>

              <Panel title="Alert" right={<span className="text-[10px] text-white/40">ultimi {live.alerts.length}</span>}>
                  {live.alerts.length === 0 ? (
                    <Empty text="Nessun alert." />
                  ) : (
                    <ul className="overflow-auto max-h-[360px] text-[12px] divide-y divide-white/5">
                      {live.alerts.map((a: Json, i: number) => (
                        <li key={i} className="px-5 py-2 flex gap-3">
                          <span className="text-white/35 font-mono whitespace-nowrap">{utc(a.at).slice(5)}</span>
                          <span className={`font-bold whitespace-nowrap ${LEVEL_STYLE[a.level]}`}>{a.code}</span>
                          <span className="text-white/70">{a.message}</span>
                        </li>
                      ))}
                    </ul>
                  )}
              </Panel>

              <Panel title="Journal delle decisioni" right={<span className="text-[10px] text-white/40">ogni decisione con il suo motivo, anche neutra o respinta</span>}>
                {live.recentDecisions.length === 0 ? (
                  <Empty text="Nessuna decisione ancora (il bot decide alla chiusura di ogni ora UTC)." />
                ) : (
                  <div className="overflow-auto max-h-[380px]">
                    <table className="w-full text-left text-[12px] whitespace-nowrap">
                      <thead className="text-white/35 text-[10px] tracking-widest uppercase border-b border-white/5 sticky top-0 bg-[#1A1C22]">
                        <tr>
                          {['Ora', 'Simbolo', 'Azione', 'Direzione', 'Motivo', 'Prezzo', 'Regime'].map((h) => (
                            <th key={h} className="px-4 py-2.5 font-normal">
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {live.recentDecisions.map((d: Json, i: number) => (
                          <tr key={i} className="border-b border-white/5">
                            <td className="px-4 py-2 text-white/45">{utc(d.time).slice(5)}</td>
                            <td className="px-4 py-2 font-semibold">{d.symbol}</td>
                            <td className={`px-4 py-2 ${ACTION_STYLE[d.action] ?? 'text-amber-300'}`}>{d.action}</td>
                            <td className="px-4 py-2 text-white/60">{d.direction ?? '—'}</td>
                            <td className="px-4 py-2 text-white/70 max-w-[420px] truncate" title={d.reason}>
                              {d.reason}
                            </td>
                            <td className="px-4 py-2 text-white/50">{price(d.price)}</td>
                            <td className="px-4 py-2 text-white/50">{d.regime ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>
            </>
          ) : tab === 'metrics' ? (
            <MetricsView live={live} metrics={metrics} onTestAlert={handleTestAlert} />
          ) : (
            <ReportsView reports={reports} selected={selectedReport} onSelect={setSelectedDay} />
          )}
        </div>
      </main>
    </div>
  );
}

function MetricsView({ live, metrics, onTestAlert }: { live: Json; metrics: Json; onTestAlert: () => void }) {
  if (!metrics) return <Empty text="Metriche non disponibili." />;
  const t = metrics.trades;
  const check = metrics.ledgerCheck;
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
      <Panel title="Rendimento" right={<TrendingUp className="w-4 h-4 text-emerald-400" />}>
        <div className="px-5 py-3">
          <Row label="PnL netto (con il non realizzato)" value={signedUsd(metrics.pnl.net)} />
          <Row label="PnL realizzato (trade chiusi)" value={signedUsd(metrics.pnl.realized)} />
          <Row label="PnL non realizzato" value={signedUsd(metrics.pnl.unrealized)} />
          <Row label="Rendimento sul capitale" value={pct(metrics.pnl.totalReturnPct)} />
          <Row label="Capitale del bot (CAPITAL_CAP_USD)" value={usd(live.initialBalance)} />
        </div>
      </Panel>
      <Panel title="Trade" right={<Activity className="w-4 h-4 text-sky-300" />}>
        <div className="px-5 py-3">
          <Row label="Trade chiusi" value={`${t.count} (${t.wins} vinti, ${t.losses} persi)`} />
          <Row label="Hit rate" value={pct(t.hitRatePct, 1)} />
          <Row label="Profit factor" value={t.profitFactor == null ? 'n/d (nessuna perdita)' : num(t.profitFactor)} />
          <Row label="Media vincente / perdente" value={`${usd(t.avgWin)} / ${usd(t.avgLoss)}`} />
          <Row label="Expectancy per trade" value={signedUsd(t.expectancy)} />
          <Row label="Migliore / peggiore" value={`${signedUsd(t.best)} / ${signedUsd(t.worst)}`} />
        </div>
      </Panel>
      <Panel title="Rischio" right={<Shield className="w-4 h-4 text-red-400" />}>
        <div className="px-5 py-3">
          <Row label="Drawdown massimo" value={pct(metrics.drawdown.maxPct)} />
          <Row label="Drawdown attuale" value={pct(metrics.drawdown.currentPct)} />
          <Row label="Tempo sott'acqua (totale)" value={duration(metrics.drawdown.timeUnderWaterMs)} />
          <Row label="Durata massima di un drawdown" value={duration(metrics.drawdown.maxDurationMs)} />
          <Row label="Sharpe / Sortino (giornalieri, annualizzati)" value={metrics.ratios.note ?? `${num(metrics.ratios.sharpe)} / ${num(metrics.ratios.sortino)}`} />
          <Row label="Limiti" value={`leva ${live.limits.maxLeverage}x · nozionale ${usd(live.limits.maxPositionNotionalUsd)} · ${live.limits.maxOpenPositions} posizioni`} />
          <Row label="Perdita giornaliera / drawdown" value={`${live.limits.maxDailyLossPct}% · REDUCE_ONLY al ${live.limits.drawdownReduceOnlyPct}%`} />
        </div>
      </Panel>
      <Panel title="Costi e ledger" right={check.consistent ? <CheckCircle2 className="w-4 h-4 text-emerald-400" /> : <XCircle className="w-4 h-4 text-red-400" />}>
        <div className="px-5 py-3">
          <Row label="PnL dei trade = equity realizzata − capitale" value={check.consistent ? 'coerente' : `differenza ${usd(check.diff)}`} tone={check.consistent ? 'text-emerald-400' : 'text-red-400'} />
          <Row label="Fee dei trade chiusi (bot)" value={usd(metrics.costs.fees)} />
          <Row label="Fee dal ledger di Kraken" value={check.ledgerFees == null ? 'n/d (shadow)' : `${usd(check.ledgerFees)} (differenza ${usd(check.feesDiff)})`} />
          <Row label="Funding (bot / Kraken)" value={check.ledgerFunding == null ? `${usd(metrics.costs.funding)} / n/d` : `${usd(metrics.costs.funding)} / ${usd(check.ledgerFunding)}`} />
          <Row label="Movimenti del conto" value={`${live.ledger.transfers.length} depositi/prelievi registrati`} />
          <div className="pt-3">
            <button onClick={onTestAlert} className="border border-white/20 text-white/80 hover:bg-white/5 px-4 py-2 rounded font-bold text-[10px] tracking-widest uppercase">
              Invia un alert di prova
            </button>
          </div>
        </div>
      </Panel>
    </div>
  );
}

function ReportsView({ reports, selected, onSelect }: { reports: Json[]; selected: Json | null; onSelect: (day: string) => void }) {
  if (reports.length === 0) return <Empty text="Nessun report giornaliero ancora: il primo arriva dopo la mezzanotte UTC." />;
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
      <Panel title="Giorni" right={<FileText className="w-4 h-4 text-white/40" />}>
        <ul className="divide-y divide-white/5">
          {reports.map((r) => {
            const [label, style] = PARITY[r.parity?.status ?? 'NOT_AVAILABLE'];
            return (
              <li key={r.day}>
                <button onClick={() => onSelect(r.day)} className={`w-full text-left px-5 py-3 flex items-center justify-between gap-3 hover:bg-white/[0.03] ${selected?.day === r.day ? 'bg-white/[0.05]' : ''}`}>
                  <div>
                    <div className="font-mono text-[12px] text-white/85">{r.day}</div>
                    <div className="text-[11px] text-white/40">
                      {signedUsd(r.equity.change)} · {r.pnl.trades} trade · {r.issues.length ? `${r.issues.length} da verificare` : 'regolare'}
                    </div>
                  </div>
                  <Badge text={label} className={style} />
                </button>
              </li>
            );
          })}
        </ul>
      </Panel>
      {selected && (
        <div className="lg:col-span-2 flex flex-col gap-5">
          <Panel title={`Report ${selected.day} (${selected.mode})`}>
            <div className="px-5 py-3 grid grid-cols-1 md:grid-cols-2 gap-x-8">
              <div>
                <Row label="Equity inizio → fine" value={`${usd(selected.equity.start)} → ${usd(selected.equity.end)}`} />
                <Row label="Variazione" value={`${signedUsd(selected.equity.change)} (${pct(selected.equity.changePct)})`} />
                <Row label="Drawdown nel giorno (equity oraria)" value={pct(selected.equity.maxDrawdownPct)} />
                <Row label="Trade chiusi" value={`${selected.pnl.trades} · ${signedUsd(selected.pnl.realized)}`} />
                <Row label="Fee bot / Kraken" value={`${usd(selected.fees.bot)} / ${selected.fees.ledger == null ? 'n/d' : usd(selected.fees.ledger)}`} />
                <Row label="Funding Kraken" value={selected.funding.ledger == null ? 'n/d' : usd(selected.funding.ledger)} />
              </div>
              <div>
                <Row label="Slippage decisioni (modello)" value={`${num(selected.slippage.strategy.avgBps)} bps (${selected.slippage.modelBps}) su ${selected.slippage.strategy.samples} fill`} tone={selected.slippage.strategy.withinModel === false ? 'text-red-400' : 'text-white/85'} />
                <Row label="Slippage stop nativi" value={selected.slippage.stops.samples ? `${num(selected.slippage.stops.avgBps)} bps su ${selected.slippage.stops.samples}` : '—'} />
                <Row label="Ingressi decisi / inviati" value={`${selected.entries.decided} / ${selected.entries.sent}`} />
                <Row label="Fill rate" value={pct(selected.entries.fillRatePct, 1)} />
                <Row label="Respinti (guardrail · tardivi)" value={`${selected.entries.rejectedByGuard} · ${selected.entries.stale + selected.entries.blocked}`} />
                <Row label="Alert (critici)" value={`${selected.alerts.total} (${selected.alerts.critical})`} />
              </div>
            </div>
            {selected.issues.length > 0 && (
              <ul className="px-5 pb-4 text-[12px] text-amber-200/90 font-mono space-y-1">
                {selected.issues.map((i: string, k: number) => (
                  <li key={k}>• {i}</li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="Confronto con il backtest sugli stessi dati" right={<Badge text={PARITY[selected.parity?.status ?? 'NOT_AVAILABLE'][0]} className={PARITY[selected.parity?.status ?? 'NOT_AVAILABLE'][1]} />}>
            <div className="px-5 py-3 text-[12px]">
              {!selected.parity || selected.parity.status === 'NOT_AVAILABLE' ? (
                <div className="text-white/50">{selected.parity?.reason ?? 'non calcolato'}</div>
              ) : (
                <>
                  <Row label="Metodo" value={selected.parity.mode === 'simulated' ? 'shadow: replay con il modello del backtest' : 'replay con i fill reali di Kraken'} />
                  <Row label="Intervallo" value={`${utc(selected.parity.fromSlot)} → ${utc(selected.parity.toSlot)}`} />
                  <Row label="Confrontati" value={`${selected.parity.compared.decisions} decisioni · ${selected.parity.compared.trades} trade`} />
                  <Row label="Differenze spiegate / non spiegate" value={`${selected.parity.explained} / ${selected.parity.unexplained}`} tone={selected.parity.unexplained ? 'text-red-400' : 'text-white/85'} />
                  {selected.parity.divergences.length > 0 && (
                    <div className="overflow-x-auto mt-3">
                      <table className="w-full text-left text-[11px]">
                        <thead className="text-white/35 text-[10px] uppercase tracking-widest">
                          <tr>
                            {['Ora', 'Simbolo', 'Bot', 'Backtest', 'Spiegazione'].map((h) => (
                              <th key={h} className="py-2 pr-3 font-normal">
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {selected.parity.divergences.map((d: Json, i: number) => (
                            <tr key={i} className="border-t border-white/5 align-top">
                              <td className="py-2 pr-3 whitespace-nowrap text-white/50">{hhmm(d.slotTime)}</td>
                              <td className="py-2 pr-3">{d.symbol}</td>
                              <td className="py-2 pr-3 text-white/70">{d.actual ?? '—'}</td>
                              <td className="py-2 pr-3 text-white/70">{d.replay ?? '—'}</td>
                              <td className={`py-2 pr-3 ${d.explanation ? 'text-sky-300' : 'text-red-400'}`}>{d.explanation ?? 'non spiegata'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </div>
          </Panel>
        </div>
      )}
    </div>
  );
}
