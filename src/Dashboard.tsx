import React, { useEffect, useState, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Activity, Hexagon, Download, FileText, TrendingUp, Shield, Sliders, GitBranch } from 'lucide-react';
import { AreaChart, Area, ResponsiveContainer, Tooltip, YAxis, XAxis, ReferenceLine } from 'recharts';
import { runQuantPipeline, RegimePolicy, RegimeType } from './lib/quantEngine';
import { calculateMetrics } from './lib/metricsCalculator';

interface SystemState {
  session: string;
  marketStream: string;
  userStream: string;
  driftMs: number;
  modelFreshnessMs: number;
  lastReconciliation: string;
  regime: string;
  confidence: number;
  uncertainty: boolean;
  equity: number;
  cash: number;
  positions: number;
  orders: number;
  degradedModes: string[];
  errors: string[];
}

interface BacktestTrade {
  symbol: string;
  type?: 'LONG' | 'SHORT';
  entryTime: string;
  entryPrice: number;
  exitTime: string;
  exitPrice: number;
  pnl: number;
  pnlPercent: number;
  reason: string;
}

interface BacktestStats {
  totalRet: string;
  annRet: string;
  sharpe: string;
  sortino: string;
  calmar: string;
  maxDD: string;
  avgDD: string;
  ulcer: string;
  maxDDDuration: string;
  maxDDRecovery: string;
  trades: number;
  trailStops: number;
  hitRate: string;
  trailPct: string;
  profFactor: string;
  avgWin: string;
  avgLoss: string;
  folds: { fold: number, ret: number, sharpe: number }[];
  equityCurve?: {time: string, equity: number}[];
  regimes: { name: string, bars: number, ret: number, ann: number, sharpe: number, hr: number }[];
}

interface BacktestReport {
  finalEquity: number;
  netPnL: number;
  tradeCount: number;
  winRate: number;
  trades: BacktestTrade[];
  stats?: BacktestStats;
  mlModel?: {
    features: string[];
    weightsLong: number[];
    weightsShort: number[];
  }
}

export default function Dashboard() {
  const [state, setState] = useState<SystemState | null>(null);
  const [backtest, setBacktest] = useState<BacktestReport | null>(null);
  const [activeTab, setActiveTab] = useState<'live' | 'metrics'>('live');
  const [isTraining, setIsTraining] = useState(false);
  const [trainingProgress, setTrainingProgress] = useState<number>(0);
  const [liveState, setLiveState] = useState<any>(null);
  const [equityTimeframe, setEquityTimeframe] = useState<'1H'|'4H'|'1D'>('1H');
  const [resetConfirm, setResetConfirm] = useState(false);
  
  const handleTrain = async () => {
    setIsTraining(true);
    setTrainingProgress(0);
    
    try {
      // Simulate progress visually
      for (let i = 0; i <= 100; i += 5) {
         setTrainingProgress(i);
         await new Promise(r => setTimeout(r, 50));
      }

      // Fetch the latest full backtest from the backend 
      // (assumes 'npx tsx src/server/backtest/run.ts' ran recently)
      const res = await fetch('/api/system/backtest');
      if (res.ok) {
        const finalReport = await res.json();
        setBacktest(finalReport);
        setActiveTab('metrics');
      } else {
        alert("Nessun report trovato. Esegui il backtest da terminale.");
      }
    } catch (e: any) {
      console.error("[FATAL] Pipeline failed:", e.message);
      alert(`Pipeline Failed: ${e.message}`);
    }

    setIsTraining(false);
  };

  useEffect(() => {
    let isMounted = true;
    const fetchState = async () => {
      try {
        const res = await fetch('/api/system/state');
        if (!res.ok) {
          throw new Error('Server returned ' + res.status);
        }
        const data = await res.json();
        if (isMounted) setState(data);
      } catch (err) {
        // Silently handle backend restarts/unavailability without polluting logs
        // The interval will keep retrying until the server comes back up
      }
    };
    
    fetchState();
    const interval = setInterval(fetchState, 1500);

    const fetchLiveState = async () => {
      try {
        const res = await fetch('/api/paper-trading/status');
        if (res.ok) {
          const data = await res.json();
          if (isMounted) setLiveState(data);
        }
      } catch (err) {}
    };
    fetchLiveState();
    const liveInterval = setInterval(fetchLiveState, 2000);

    return () => {
      isMounted = false;
      clearInterval(interval);
      clearInterval(liveInterval);
    };
  }, []);

  useEffect(() => {
    const fetchBacktest = async () => {
      try {
        const res = await fetch('/api/system/backtest');
        if (res.ok) {
          const data = await res.json();
          setBacktest(data);
        }
      } catch (err) {
        console.error("Failed to fetch backtest report:", err);
      }
    };
    fetchBacktest();
  }, []);

  const metrics = useMemo(() => {
    return calculateMetrics(liveState);
  }, [liveState?.equityHistory, liveState?.openPositions, liveState?.balance, liveState?.recentTrades, liveState?.metricsHistory]);

  const chartData = useMemo(() => {
    let points = [];
    if (!liveState?.equityHistory || liveState.equityHistory.length === 0) {
      const now = Date.now();
      points = [
        { equity: 10000, timestamp: now - 1000 },
        { equity: 10000, timestamp: now }
      ];
    } else {
      points = liveState.equityHistory.map((d: any) => ({
        ...d,
        timestamp: new Date(d.time).getTime()
      }));
      
      // Fallback array for Recharts: It needs at least 2 points to draw an area map.
      // If we only have 1 data point (e.g. at boot), we append a live projection up to "now".
      if (points.length === 1) {
        points.push({
          ...points[0],
          timestamp: Date.now()
        });
      }
    }
    
    // Filter by timeframe
    const now = Date.now();
    let cutoff = 0;
    if (equityTimeframe === '1H') cutoff = now - 60 * 60 * 1000;
    else if (equityTimeframe === '4H') cutoff = now - 4 * 60 * 60 * 1000;
    else if (equityTimeframe === '1D') cutoff = now - 24 * 60 * 60 * 1000;
    
    let filtered = points.filter((p: any) => p.timestamp >= cutoff);
    if (filtered.length < 2) filtered = points;
    
    return filtered;
  }, [liveState?.equityHistory, equityTimeframe]);

  const { chartTicks, referenceLines } = useMemo(() => {
    if (chartData.length === 0) return { chartTicks: [], referenceLines: [] };
    const minTime = chartData[0].timestamp;
    const maxTime = chartData[chartData.length - 1].timestamp;

    const ticks = [];
    const refs = [];
    const startObj = new Date(minTime);
    startObj.setHours(0, 0, 0, 0); // Start edge of day
    let currentTick = startObj.getTime();
    
    // Add markers every 6 hours
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    while (currentTick <= maxTime) {
      if (currentTick >= minTime) {
        ticks.push(currentTick);
        const d = new Date(currentTick);
        const hrs = d.getHours();
        if (hrs === 0) {
            refs.push({ time: currentTick, label: d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' }), color: '#40C057', opacity: 0.2 });
        } else if (hrs === 12) {
            refs.push({ time: currentTick, label: '12h', color: '#666', opacity: 0.1 });
        } else {
            refs.push({ time: currentTick, label: '6h', color: '#333', opacity: 0.05 });
        }
      }
      currentTick += SIX_HOURS;
    }
    return { chartTicks: ticks, referenceLines: refs };
  }, [chartData]);

  if (!state) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#0E0E0E] text-[#808080] font-mono text-sm tracking-widest">
        <Activity className="mr-3 h-4 w-4 animate-spin text-[#40C057]" />
        INITIALIZING CORE SYSTEMS...
      </div>
    );
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'HEALTHY':
      case 'NORMAL':
      case 'CALM': return 'text-[#40C057] border-[#40C057]/30 bg-[#40C057]/10';
      case 'DEGRADED_DATA': 
      case 'TURBULENT': return 'text-[#FCC419] border-[#FCC419]/30 bg-[#FCC419]/10';
      case 'PANIC':
      case 'UNCERTAINTY_MODE': 
      case 'RISK_HALTED':
      case 'SYSTEM_HALTED': return 'text-[#FA5252] border-[#FA5252]/30 bg-[#FA5252]/10';
      default: return 'text-[#808080] border-[#333333] bg-[#1A1A1A]';
    }
  };

  const handleStartLive = async () => {
    try {
      const res = await fetch('/api/paper-trading/start', { method: 'POST' });
      
      const contentType = res.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
         throw new Error("Il server si sta riavviando o non è al momento disponibile (502/504). Riprova tra qualche istante.");
      }
      
      const data = await res.json();
      if (res.ok) setLiveState(data);
      else alert(`Error: ${data.error}`);
    } catch (err: any) {
      alert(`Errore di avvio: ${err.message}`);
    }
  };

  const handleStopLive = async () => {
    try {
      const res = await fetch('/api/paper-trading/stop', { method: 'POST' });
      const contentType = res.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
         throw new Error("Il server si sta riavviando o non è al momento disponibile. Riprova tra poco.");
      }
      const data = await res.json();
      setLiveState(data);
    } catch (err: any) {
      alert(`Errore di stop: ${err.message}`);
    }
  };

  const handleResetLive = async () => {
    if (!resetConfirm) {
      setResetConfirm(true);
      setTimeout(() => setResetConfirm(false), 5000);
      return;
    }
    setResetConfirm(false);
    
    try {
      const res = await fetch('/api/paper-trading/reset', { method: 'POST' });
      const contentType = res.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
         throw new Error("Il server si sta riavviando o non è al momento disponibile. Riprova tra poco.");
      }
      const data = await res.json();
      if (res.ok) {
        setLiveState(data);
      } else {
        alert(`Reset failed: ${data.error}`);
      }
    } catch (err: any) {
      alert(`Reset failed: ${err.message}`);
    }
  };

  return (
    <div className="min-h-screen bg-[#111216] text-[#E0E0E0] font-sans flex flex-col selection:bg-[#34D399]/30 relative">
      {/* Subtle Grid Background */}
      <div 
        className="absolute inset-0 z-0 opacity-20 pointer-events-none" 
        style={{ 
          backgroundImage: 'linear-gradient(#ffffff 1px, transparent 1px), linear-gradient(90deg, #ffffff 1px, transparent 1px)', 
          backgroundSize: '80px 80px',
          backgroundPosition: 'center center'
        }}
      ></div>
      <div className="absolute inset-0 z-0 bg-gradient-to-b from-transparent to-[#111216] pointer-events-none"></div>
      
      <div className="relative z-10 flex flex-col h-screen overflow-hidden">
        
        {/* Top Navbar */}
        <header className="flex-shrink-0 border-b border-white/5 bg-[#1A1C22]/80 backdrop-blur-md px-4 md:px-8 flex items-center justify-between h-[64px]">
          <div className="flex items-center h-full">
            <div className="font-sans font-bold text-[#3B82F6] text-[18px] tracking-wider mr-8">
              ARBITER
            </div>
            <div className="flex gap-6 h-full mt-0.5">
              <button 
                onClick={() => setActiveTab('live')}
                className={`h-full flex items-center border-b-2 font-bold text-[12px] tracking-widest transition-colors ${activeTab === 'live' ? 'border-[#3B82F6] text-[#3B82F6]' : 'border-transparent text-white/40 hover:text-white/80'}`}
              >
                DASHBOARD
              </button>
              <button 
                onClick={() => setActiveTab('metrics')}
                className={`h-full flex items-center border-b-[2px] font-bold text-[12px] tracking-widest transition-colors ${activeTab === 'metrics' ? 'border-[#3B82F6] text-[#3B82F6]' : 'border-transparent text-white/40 hover:text-white/80'}`}
              >
                METRICHE
              </button>
            </div>
          </div>
          
          <div className="flex items-center gap-4">
            <div className="font-mono text-[#3B82F6] font-medium text-sm tracking-tight hidden sm:block">
              ${(liveState?.balance || 10000).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}
            </div>
            <div className="border border-[#3B82F6]/30 bg-[#3B82F6]/5 text-[#3B82F6] px-3 py-1.5 text-[10px] items-center flex rounded font-mono tracking-widest font-bold">
              LIVE STATUS
            </div>
            <div className="hidden sm:flex items-center gap-3 text-white/40 ml-2">
              <Activity className="w-4 h-4 cursor-pointer hover:text-white/80" />
              <Hexagon className="w-4 h-4 cursor-pointer hover:text-white/80" />
            </div>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto custom-scrollbar p-4 md:p-6 lg:p-8 pb-20">
          <AnimatePresence mode="wait">
            {activeTab === 'live' ? (
              <motion.div 
                key="live"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.3 }}
                className="flex flex-col gap-6 w-full max-w-[1400px] mx-auto"
              >
                
                {/* Session Header Controls */}
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center rounded-xl border border-white/5 bg-[#1A1C22]/80 backdrop-blur-md p-6 gap-6">
                  <div className="flex items-center gap-6">
                    <div>
                      <div className="text-[10px] text-white/40 tracking-widest uppercase mb-1.5 font-mono">Current Session ID</div>
                      <div className="text-xl md:text-2xl font-bold tracking-tight text-white/90">SESSION: {state.session}</div>
                    </div>
                    {liveState?.isActive ? (
                      <div className={`px-4 py-1.5 rounded-full text-[11px] font-bold tracking-wider flex items-center gap-2 border ${liveState.status === 'ERROR_RECOVERING' ? 'bg-[#FFB020]/10 text-[#FFB020] border-[#FFB020]/30' : 'bg-[#10B981]/10 text-[#10B981] border-[#10B981]/30'}`}>
                        <div className={`w-2 h-2 rounded-full ${liveState.status === 'ERROR_RECOVERING' ? 'bg-[#FFB020] animate-pulse' : 'bg-[#10B981]'}`}></div>
                        {liveState.status === 'ERROR_RECOVERING' ? 'RECOVERING' : 'HEALTHY'}
                      </div>
                    ) : (
                      <div className="px-4 py-1.5 rounded-full text-[11px] font-bold tracking-wider flex items-center gap-2 border bg-rose-500/10 text-rose-500 border-rose-500/30">
                        <div className="w-2 h-2 rounded-full bg-rose-500"></div>
                        STOPPED
                      </div>
                    )}
                  </div>
                  
                  <div className="flex flex-wrap items-center gap-4 w-full md:w-auto">
                    {liveState?.isActive ? (
                       <button 
                         onClick={handleStopLive}
                         className="flex-1 md:flex-none border border-[#F43F5E]/50 text-[#F43F5E] hover:bg-[#F43F5E]/10 px-6 py-3 rounded shadow-lg font-bold text-[11px] tracking-widest uppercase flex items-center justify-center gap-2 transition-all"
                       >
                          <span className="w-2 h-2 bg-current rounded-full"></span> STOP BOT
                       </button>
                    ) : (
                       <button 
                         onClick={handleStartLive}
                         className="flex-1 md:flex-none bg-[#10B981] hover:bg-[#059669] text-white px-8 py-3 rounded shadow-lg shadow-[#10B981]/20 font-bold text-[11px] tracking-widest uppercase flex items-center justify-center gap-2 transition-all"
                       >
                          ▶ START BOT
                       </button>
                    )}
                    {!liveState?.isActive && (
                      <button 
                        onClick={handleResetLive}
                        className={`flex-1 md:flex-none border px-6 py-3 rounded font-bold text-[11px] tracking-widest uppercase flex items-center justify-center gap-2 transition-all ${resetConfirm ? 'bg-[#F43F5E] text-white border-[#F43F5E]' : 'border-[#F43F5E]/30 text-[#F43F5E]/80 hover:bg-[#F43F5E]/10 hover:text-[#F43F5E] hover:border-[#F43F5E]/60'}`}
                      >
                         {resetConfirm ? '↻ SEI SICURO?' : '↺ RESET SESSION'}
                      </button>
                    )}
                  </div>
                </div>

                {/* Metrics Grid */}
                <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
                  {/* PNL */}
                  <div className="border border-white/5 bg-[#1A1C22]/80 backdrop-blur-md rounded-lg p-5 flex flex-col justify-between min-h-[130px]">
                     <div className="flex justify-between items-start text-[10px] font-sans font-bold tracking-widest text-white/50 uppercase">
                        <span>Net PnL</span>
                        <Activity className="w-4 h-4 text-[#10B981]" />
                     </div>
                     <div className="pt-2">
                        <div className={`text-2xl lg:text-3xl font-bold tracking-tight mb-0.5 font-sans ${liveState?.balance >= (liveState?.initialBalance || 10000) ? 'text-[#10B981]' : liveState?.balance < (liveState?.initialBalance || 10000) ? 'text-[#F43F5E]' : 'text-white'}`}>
                          {liveState?.balance >= (liveState?.initialBalance || 10000) ? '+' : '-'}${Math.abs((liveState?.balance || (liveState?.initialBalance || 10000)) - (liveState?.initialBalance || 10000)).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}
                        </div>
                        <div className={`text-[11px] font-medium ${(liveState?.balance || (liveState?.initialBalance || 10000)) >= (liveState?.initialBalance || 10000) ? 'text-[#10B981]/70' : 'text-[#F43F5E]/70'}`}>
                          {liveState?.balance >= (liveState?.initialBalance || 10000) ? '+' : ''}{(((liveState?.balance || (liveState?.initialBalance || 10000)) - (liveState?.initialBalance || 10000)) / (liveState?.initialBalance || 10000) * 100).toFixed(2)}% since start
                        </div>
                     </div>
                  </div>

                  {/* Equity Change */}
                  <div className="border border-white/5 bg-[#1A1C22]/80 backdrop-blur-md rounded-lg p-5 flex flex-col justify-between min-h-[130px]">
                     <div className="flex justify-between items-start text-[10px] font-sans font-bold tracking-widest text-white/50 uppercase">
                        <span>Equity % Change</span>
                        <div className="w-4 h-4 flex items-end gap-[2px] justify-end opacity-70">
                           <div className="w-1 h-1.5 border border-[#3B82F6]"></div>
                           <div className="w-1 h-2.5 border border-[#3B82F6]"></div>
                           <div className="w-1 h-3.5 border border-[#3B82F6]"></div>
                        </div>
                     </div>
                     <div className="flex items-baseline gap-2 pt-2">
                        <div className="text-[#3B82F6] text-2xl font-bold tracking-tight font-sans">
                          {liveState?.balance >= 10000 ? '+' : ''}{(((liveState?.balance || 10000) - 10000) / 10000 * 100).toFixed(2)}%
                        </div>
                        <div className="text-white/40 text-[10px] font-sans font-medium tracking-wide">
                          Current Session
                        </div>
                     </div>
                  </div>

                  {/* Equity Engaged */}
                  <div className="border border-white/5 bg-[#1A1C22]/80 backdrop-blur-md rounded-lg p-5 flex flex-col justify-between min-h-[130px]">
                     <div className="flex justify-between items-start text-[10px] font-sans font-bold tracking-widest text-white/50 uppercase">
                        <span>Equity Engaged</span>
                        <div className="w-4 h-4 rounded-full border border-rose-400/50 flex items-center justify-center opacity-70">
                          <div className="w-full h-[1px] bg-rose-400/50"></div>
                        </div>
                     </div>
                     <div className="pt-2">
                        <div className="text-white/90 text-2xl font-bold tracking-tight mb-0.5 font-sans">
                          {liveState?.openPositions?.length > 0 ? '42%' : '0%'}
                        </div>
                        <div className="text-white/40 text-[11px] font-sans">Margin Utilization</div>
                     </div>
                  </div>

                  {/* Open Positions */}
                  <div className="border border-white/5 bg-[#1A1C22]/80 backdrop-blur-md rounded-lg p-5 flex flex-col justify-between min-h-[130px]">
                     <div className="flex justify-between items-start text-[10px] font-sans font-bold tracking-widest text-white/50 uppercase">
                        <span>Open Positions</span>
                        <div className="w-4 h-4 border border-rose-400/50 rotate-45 flex items-center justify-center opacity-70">
                          <div className="w-1.5 h-1.5 border border-rose-400/50"></div>
                        </div>
                     </div>
                     <div className="pt-2">
                        <div className="text-white/90 text-2xl font-bold tracking-tight mb-0.5 font-sans">
                          {(liveState?.openPositions?.length || 0).toString().padStart(2, '0')}
                        </div>
                        <div className="text-white/40 text-[11px] font-sans">
                          Exposure: ${liveState?.openPositions?.reduce((sum: number, p: any) => sum + ((p.size || p.contracts || 0) * (p.entryPrice || 0) / (p.leverage || 1)), 0).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}
                        </div>
                     </div>
                  </div>

                  {/* Regime */}
                  <div className="col-span-2 md:col-span-1 border border-white/5 bg-[#1A1C22]/80 backdrop-blur-md rounded-lg p-5 flex flex-col min-h-[130px]">
                     <div className="flex justify-between items-start text-[10px] font-sans font-bold tracking-widest text-white/50 uppercase mb-2">
                        <span>Current Cycle Regimes</span>
                        <Hexagon className="w-4 h-4 text-[#10B981] opacity-70" />
                     </div>
                     <div className="flex-1 overflow-y-auto custom-scrollbar pr-1">
                        {/* Global Regime */}
                        <div className="flex justify-between items-center mb-1 bg-white/5 px-2 py-1 rounded">
                           <span className="text-[10px] text-white/50 font-bold uppercase">GLOBAL (BTC)</span>
                           <span className={`text-[11px] font-bold tracking-tight font-sans uppercase ${liveState?.regime === 'BULL' || liveState?.regime === 'EUPHORIA' ? 'text-[#10B981]' : liveState?.regime === 'BEAR' || liveState?.regime === 'CRASH' ? 'text-[#F43F5E]' : 'text-[#3B82F6]'}`}>
                              {liveState?.regime || 'UNKNOWN'}
                           </span>
                        </div>
                        {/* Local Regimes */}
                        {liveState?.regimes && Object.entries(liveState.regimes).map(([sym, reg]: [string, any]) => {
                           const symParts = sym.split('/');
                           const displaySym = symParts[0] || sym;
                           return (
                             <div key={sym} className="flex justify-between items-center mb-1 px-2 py-1 border-b border-white/5 last:border-0">
                                <span className="text-[10px] text-white/40 font-bold">{displaySym}</span>
                                <span className={`text-[10px] font-semibold tracking-tight uppercase ${reg === 'BULL' || reg === 'EUPHORIA' ? 'text-[#10B981]/80' : reg === 'BEAR' || reg === 'CRASH' ? 'text-[#F43F5E]/80' : 'text-[#3B82F6]/80'}`}>
                                   {reg || 'UNKNOWN'}
                                </span>
                             </div>
                           );
                        })}
                     </div>
                  </div>
                </div>

                {/* Equity Chart */}
                <div className="border border-white/5 bg-[#1A1C22]/80 backdrop-blur-md rounded-lg overflow-hidden flex flex-col h-[400px]">
                  <div className="px-6 py-4 flex flex-col sm:flex-row items-start sm:items-center justify-between border-b border-white/5 gap-3">
                    <div className="flex items-center gap-3">
                      <span className="font-bold text-xs tracking-widest uppercase text-white/90 font-sans">Equity Chart</span>
                      <span className="text-[10px] tracking-widest text-white/30 font-sans">SESSION REAL-TIME</span>
                    </div>
                    <div className="flex gap-1.5 p-1 rounded-md border border-white/5 bg-black/20">
                       <button onClick={() => setEquityTimeframe('1H')} className={`px-4 py-1 text-[10px] font-sans font-medium rounded transition-colors ${equityTimeframe === '1H' ? 'bg-white/10 text-white' : 'text-white/40 hover:bg-white/5 hover:text-white'}`}>1H</button>
                       <button onClick={() => setEquityTimeframe('4H')} className={`px-4 py-1 text-[10px] font-sans font-medium rounded transition-colors ${equityTimeframe === '4H' ? 'bg-white/10 text-white' : 'text-white/40 hover:bg-white/5 hover:text-white'}`}>4H</button>
                       <button onClick={() => setEquityTimeframe('1D')} className={`px-4 py-1 text-[10px] font-sans font-medium rounded transition-colors ${equityTimeframe === '1D' ? 'bg-white/10 text-white' : 'text-white/40 hover:bg-white/5 hover:text-white'}`}>1D</button>
                    </div>
                  </div>
                  <div className="flex-1 w-full pt-6 pr-4">
                    <ResponsiveContainer minWidth={0} minHeight={0} width="100%" height="100%">
                      <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                        <defs>
                          <linearGradient id="colorEq" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#3B82F6" stopOpacity={0.4}/>
                            <stop offset="95%" stopColor="#3B82F6" stopOpacity={0}/>
                          </linearGradient>
                        </defs>
                        <XAxis 
                          dataKey="timestamp" 
                          type="number" 
                          scale="time" 
                          domain={['auto', 'auto']}
                          tickFormatter={(val) => new Date(val).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                          stroke="rgba(255,255,255,0.05)"
                          tickLine={false}
                          axisLine={false}
                          height={20}
                          tick={{fill: 'rgba(255,255,255,0.3)', fontSize: 10, fontFamily: 'sans-serif'}}
                        />
                        <YAxis 
                          domain={['auto', 'auto']} 
                          stroke="rgba(255,255,255,0.05)" 
                          tick={{fill: 'rgba(255,255,255,0.2)', fontSize: 10, fontFamily: 'sans-serif', fontWeight: 600}}
                          tickFormatter={(val) => `$${(val/1000).toFixed(0)}K`}
                          width={60}
                          tickLine={false}
                          axisLine={false}
                          tickMargin={10}
                        />
                        <Tooltip 
                          contentStyle={{ backgroundColor: '#111216', borderColor: 'rgba(255,255,255,0.1)', color: '#fff', fontSize: '12px', fontFamily: 'sans-serif', borderRadius: '4px' }}
                          itemStyle={{ color: '#3B82F6', fontWeight: 600 }}
                          formatter={(val: number) => [`$${val.toFixed(2)}`, 'Equity']}
                          labelFormatter={(label) => new Date(label).toLocaleTimeString()}
                        />
                        {(referenceLines || []).map((ref, idx) => (
                          <ReferenceLine 
                            key={idx} 
                            x={ref.time} 
                            stroke={ref.color} 
                            strokeOpacity={0.2} 
                            strokeDasharray="3 3"
                          />
                        ))}
                        {/* Horizontal Grid lines simulation */}
                        {[10000, 11000, 12000, 13000].map((val) => (
                          <ReferenceLine key={val} y={val} stroke="rgba(255,255,255,0.05)" strokeDasharray="3 3" />
                        ))}
                        <Area 
                          type="monotone" 
                          dataKey="equity" 
                          stroke="#93C5FD" 
                          strokeWidth={2}
                          fillOpacity={1} 
                          fill="url(#colorEq)" 
                          isAnimationActive={true}
                        />
                      </AreaChart>
                   </ResponsiveContainer>
                  </div>
                </div>

                {/* Active Trades Table */}
                <div className="border border-white/5 bg-[#1A1C22]/80 backdrop-blur-md rounded-lg overflow-hidden flex flex-col">
                  <div className="px-6 py-4 border-b border-white/5 flex items-center justify-between">
                    <span className="font-bold text-xs tracking-widest uppercase text-white/90 font-sans">Active Trades</span>
                    <span className="text-[10px] tracking-widest text-white/40 font-sans uppercase">
                      TOTAL EXPOSURE: {liveState?.openPositions?.map((p:any)=>`${(p.size || p.contracts || 0).toFixed(2)} ${(p.symbol||'').split('/')[0]}`).join(' • ') || '0.00 BTC'}
                    </span>
                  </div>
                  <div className="p-0 overflow-x-auto">
                    {(!liveState?.openPositions || liveState.openPositions.length === 0) ? (
                      <div className="p-16 flex flex-col items-center justify-center text-white/20 font-sans text-sm">
                         No Active Positions found
                      </div>
                    ) : (
                      <table className="w-full text-left font-sans text-[11px] whitespace-nowrap">
                        <thead className="text-white/30 text-[10px] font-bold tracking-widest border-b border-white/5">
                          <tr>
                            <th className="px-6 py-4 font-normal uppercase">Symbol</th>
                            <th className="px-6 py-4 font-normal uppercase">Side</th>
                            <th className="px-6 py-4 font-normal uppercase">Leverage</th>
                            <th className="px-6 py-4 font-normal uppercase">Size</th>
                            <th className="px-6 py-4 font-normal uppercase">Entry Price</th>
                            <th className="px-6 py-4 font-normal uppercase">Trailing Stop</th>
                            <th className="px-6 py-4 font-normal uppercase">% Trailing</th>
                            <th className="px-6 py-4 font-normal uppercase text-right">Unrealized PNL</th>
                          </tr>
                        </thead>
                        <tbody>
                          {liveState.openPositions.map((p: any, i: number) => {
                            const isLong = p.direction === 'LONG';
                            const trlDistPercent = Math.abs((p.currentStopLoss - p.entryPrice) / p.entryPrice * 100).toFixed(2);
                            return (
                            <tr key={i} className="border-b border-white/5 hover:bg-white/[0.02] transition-colors">
                              <td className="px-6 py-5 text-white/90 font-semibold">{p.symbol.replace('/','-')}</td>
                              <td className="px-6 py-5">
                                  <span className={`px-2 py-1 rounded border text-[9px] tracking-widest uppercase font-bold ${isLong ? 'bg-transparent text-[#10B981] border-[#10B981]/50' : 'bg-transparent text-[#F43F5E] border-[#F43F5E]/50'}`}>
                                     {p.direction}
                                  </span>
                              </td>
                              <td className="px-6 py-5 text-white/50">{p.leverage || 1}.0x</td>
                              <td className="px-6 py-5 text-white/90 font-medium">{(p.size || p.contracts || 0).toFixed(2)} {p.symbol.split('/')[0]}</td>
                              <td className="px-6 py-5 text-white/70 font-medium">${p.entryPrice?.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</td>
                              <td className="px-6 py-5 text-[#F43F5E] font-medium">${p.currentStopLoss?.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</td>
                              <td className="px-6 py-5 text-white/50">{trlDistPercent}%</td>
                              <td className={`px-6 py-5 text-right font-bold tracking-tight ${p.unrealizedPnl >= 0 ? 'text-[#10B981]' : 'text-[#F43F5E]'}`}>
                                {p.unrealizedPnl >= 0 ? '+' : '-'}${Math.abs(p.unrealizedPnl || 0).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}
                              </td>
                            </tr>
                          )})}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>

              </motion.div>
            ) : (
                            <motion.div 
                 key="metrics"
                 initial={{ opacity: 0, scale: 0.98 }}
                 animate={{ opacity: 1, scale: 1 }}
                 exit={{ opacity: 0, scale: 0.98 }}
                 transition={{ duration: 0.3 }}
                 className="flex flex-col w-full max-w-[1400px] mx-auto gap-4 pb-10"
              >
                {/* Header Section */}
                <div className="flex flex-col md:flex-row items-start md:items-end justify-between pb-2 gap-4">
                  <div className="flex flex-col">
                    <h2 className="font-sans font-bold text-[22px] tracking-wide text-[#93C5FD] mb-1 uppercase drop-shadow-md">Quantitative Strategy Analysis</h2>
                    <p className="font-sans text-[10px] tracking-widest text-white/30 uppercase">Instance: ARB_K_OMEGA_9 | Last Update: 14:02:11 UTC</p>
                  </div>
                  <div className="flex gap-2">
                    <button 
                      onClick={() => {
                        if (!metrics) return;
                        const output = JSON.stringify(metrics, null, 2);
                        const blob = new Blob([output], { type: 'text/plain' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `arbiter_metrics_${new Date().toISOString().slice(0, 10)}.txt`;
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        URL.revokeObjectURL(url);
                      }}
                      className="px-4 py-2 flex items-center gap-2 rounded border border-white/10 text-white/80 hover:bg-white/5 hover:text-white text-[11px] font-bold tracking-widest uppercase transition-colors"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Export Metrics (CSV)
                    </button>
                    <button className="px-4 py-2 flex items-center gap-2 rounded border border-white/10 text-white/80 hover:bg-white/5 hover:text-white text-[11px] font-bold tracking-widest uppercase transition-colors">
                      <FileText className="w-3.5 h-3.5" />
                      PDF
                    </button>
                  </div>
                </div>

                {/* Metrics Group style */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {(() => {
                  const groups = [
                    {
                      title: '01 // PURE RETURN',
                      icon: <TrendingUp className="w-3.5 h-3.5 text-[#10B981]" />,
                      items: [
                        { label: 'Total Return', key: 'totalReturn', fmt: (v: number) => `${(v * 100).toFixed(2)}%`, polarity: true },
                        { label: 'CAGR', key: 'cagr', fmt: (v: number) => `${(v * 100).toFixed(2)}%`, polarity: true },
                        { label: 'Net Profit', key: 'netProfit', fmt: (v: number) => `$${v.toFixed(2)}`, polarity: true, defaultColor: 'text-[#93C5FD]' },
                        { label: 'Avg Trade', key: 'avgTrade', fmt: (v: number) => `$${v.toFixed(2)}`, polarity: true, defaultColor: 'text-[#93C5FD]' },
                      ]
                    },
                    {
                      title: '02 // RISK-ADJUSTED RETURN',
                      icon: <Shield className="w-3.5 h-3.5 text-[#F43F5E]" />,
                      items: [
                        { label: 'Max Drawdown', key: 'maxDD', fmt: (v: number) => `${(v * 100).toFixed(2)}%`, polarity: false },
                        { label: 'Sharpe Ratio', key: 'sharpe', fmt: (v: number) => v.toFixed(2), polarity: true },
                        { label: 'Sortino Ratio', key: 'sortino', fmt: (v: number) => v.toFixed(2), polarity: true },
                        { label: 'Calmar Ratio', key: 'calmar', fmt: (v: number) => v.toFixed(1), polarity: true, defaultColor: 'text-[#93C5FD]' },
                        { label: 'Ulcer Index', key: 'ulcerIndex', fmt: (v: number) => v.toFixed(3), polarity: false, defaultColor: 'text-white/40' },
                      ]
                    },
                    {
                      title: '03 // OPERATIONAL QUALITY',
                      icon: <Sliders className="w-3.5 h-3.5 text-white/50" />,
                      items: [
                        { label: 'Trades Count', key: 'tradesCount', fmt: (v: number) => v.toFixed(1), polarity: true, defaultColor: 'text-white/70' },
                        { label: 'Profit Factor', key: 'profitFactor', fmt: (v: number) => v.toFixed(2), polarity: true, defaultColor: 'text-[#10B981]' },
                        { label: 'Hit Rate', key: 'hitRate', fmt: (v: number) => `${(v * 100).toFixed(1)}%`, polarity: false, defaultColor: 'text-[#10B981]' },
                        { label: 'Expectancy', key: 'expectancy', fmt: (v: number) => v.toFixed(2), polarity: true, defaultColor: 'text-[#93C5FD]' },
                        { label: 'Avg Win/Loss', key: 'winLossRatio', fmt: (v: number) => `${v.toFixed(1)}:1`, polarity: true },
                      ]
                    },
                    {
                      title: '04 // RETURN ROBUSTNESS',
                      icon: <GitBranch className="w-3.5 h-3.5 text-[#10B981]" />,
                      items: [
                        { label: 'Recovery Factor', key: 'recoveryFactor', fmt: (v: number) => v.toFixed(2), polarity: true, defaultColor: 'text-[#10B981]' },
                        { label: 'Time Under Water', key: 'timeUnderWater', fmt: (v: number) => `${Math.floor(v/60)}h ${v%60}m`, polarity: false, defaultColor: 'text-white/70' },
                        { label: 'Max DD Duration', key: 'maxDDDuration', fmt: (v: number) => `${Math.floor(v/60)}m ${(v%60).toFixed(0).padStart(2,'0')}s`, polarity: false, defaultColor: 'text-[#F43F5E]' },
                        { label: 'Stability by regime', key: 'stabilityByRegime', fmt: (v: string) => v, polarity: false, defaultColor: 'text-[#93C5FD]' },
                        { label: 'Out-of-sample perf.', key: 'oosPerformance', fmt: (v: string) => v, polarity: false, defaultColor: 'text-[#10B981]' },
                      ]
                    }
                  ];

                  return groups.map((group, groupIdx) => (
                    <div key={groupIdx} className="bg-[#1A1C22]/80 border border-white/10 rounded-md overflow-hidden flex flex-col backdrop-blur-md">
                      <div className="px-5 py-3.5 border-b border-white/5 text-[11px] font-bold tracking-widest text-[#93C5FD] uppercase font-sans flex items-center justify-between">
                        <span>{group.title}</span>
                        {group.icon}
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-left font-sans whitespace-nowrap">
                          <thead className="text-white/30 text-[10px] font-bold uppercase tracking-widest border-b border-white/5">
                            <tr>
                              <th className="px-5 py-3 font-normal">Metric</th>
                              <th className="px-5 py-3 font-normal text-right">Current (T0)</th>
                              <th className="px-5 py-3 font-normal text-right">Prev (T-15m)</th>
                              <th className="px-5 py-3 font-normal text-right">24h (T-24h)</th>
                            </tr>
                          </thead>
                          <tbody className="text-[12px] font-mono">
                            {group.items.map((item: any, i: number) => {
                              const v0 = (metrics?.t0 as any)?.[item.key] ?? '-';
                              const v1 = (metrics?.t1 as any)?.[item.key] ?? '-';
                              const v24 = (metrics?.t24h as any)?.[item.key] ?? '-';
                              
                              const renderVal = (v: any) => {
                                if (v === '-') return <span className="text-white/20">-</span>;
                                if (typeof v === 'string') return <span className="text-white/80">{item.fmt(v)}</span>;
                                
                                let colorClass = 'text-white/80';
                                if (item.defaultColor) {
                                  colorClass = item.defaultColor;
                                } else {
                                  if (item.polarity) {
                                    colorClass = v > 0 ? 'text-[#10B981]' : v < 0 ? 'text-[#F43F5E]' : 'text-white/50';
                                  } else {
                                    colorClass = v > 0 ? 'text-[#F43F5E]' : v < 0 ? 'text-[#10B981]' : 'text-white/50';
                                  }
                                }
                                return <span className={`font-semibold ${colorClass}`}>{item.fmt(v)}</span>;
                              };

                              return (
                                <tr key={i} className="hover:bg-white/[0.02]">
                                  <td className="px-5 py-3 text-white/90 font-sans font-medium">{item.label}</td>
                                  <td className="px-5 py-3 text-right font-medium">{renderVal(v0)}</td>
                                  <td className="px-5 py-3 text-right font-medium">{renderVal(v1)}</td>
                                  <td className="px-5 py-3 text-right font-medium">{renderVal(v24)}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ));
                })()}
                </div>

                {/* Bottom Section */}
                <div className="flex justify-center w-full mt-4 h-full min-h-[240px]">
                  {/* Status Box */}
                  <div className="bg-[#1A1C22]/80 border border-white/10 rounded-md flex flex-col justify-between backdrop-blur-md p-6 max-w-md w-full">
                    <div className="flex flex-col items-center justify-center pt-2">
                       <span className="text-[10px] text-white/30 uppercase tracking-widest font-sans font-bold mb-2">Current Status</span>
                       <span className="text-3xl font-bold font-sans tracking-tight text-[#10B981] drop-shadow-[0_0_15px_rgba(16,185,129,0.3)]">OPERATIONAL</span>
                    </div>

                    <div className="flex flex-col gap-3 mt-8 w-full text-[10px] font-sans border-t border-white/5 pt-6">
                      <div className="flex justify-between items-center w-full">
                         <span className="text-white/40 tracking-widest uppercase font-bold">Uptime</span>
                         <span className="text-white/90 font-mono text-[11px] font-medium">14d 02h 11m</span>
                      </div>
                      <div className="flex justify-between items-center w-full">
                         <span className="text-white/40 tracking-widest uppercase font-bold">Signal Strength</span>
                         <span className="text-[#10B981] font-mono text-[11px] font-medium">98.4%</span>
                      </div>
                      <div className="flex justify-between items-center w-full">
                         <span className="text-white/40 tracking-widest uppercase font-bold">Risk Cap</span>
                         <span className="text-white/90 font-mono text-[11px] font-medium">$12,000.00</span>
                      </div>
                    </div>

                    <button 
                      onClick={() => {
                        handleStopLive();
                        setActiveTab('live');
                      }}
                      className="w-full bg-[#B91C1C] hover:bg-[#991B1B] text-white rounded font-bold text-[10px] tracking-widest uppercase py-3.5 mt-6 transition-colors border border-[#B91C1C] shadow-[0_0_15px_rgba(185,28,28,0.2)]"
                    >
                      Emergency Kill Switch
                    </button>
                  </div>

                </div>

              </motion.div>

            )}\n          </AnimatePresence>
        </main>
      </div>
    </div>
  );

}
