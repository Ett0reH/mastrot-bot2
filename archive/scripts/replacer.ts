// @ts-nocheck
import fs from 'fs';

const JS_NEW_JSX = `
  return (
    <div className="h-screen bg-[#050510] bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-[#111122] via-[#050510] to-black text-slate-100 font-sans flex flex-col selection:bg-emerald-500/30 overflow-hidden relative">
      {/* Background ambient glow */}
      <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] rounded-full bg-emerald-500/5 blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-20%] right-[-10%] w-[50%] h-[50%] rounded-full bg-indigo-500/5 blur-[120px] pointer-events-none" />
      
      {/* Floating Header */}
      <motion.header 
        initial={{ y: -20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        className="shrink-0 mx-4 md:mx-auto mt-4 w-full max-w-[1240px] rounded-[18px] border border-white/10 bg-white/5 backdrop-blur-xl px-5 py-3 flex items-center justify-between z-10 shadow-2xl shadow-black/50"
      >
        <div className="flex items-center gap-3">
          <div className="p-1.5 bg-gradient-to-br from-emerald-400 to-emerald-600 rounded-lg shadow-[0_0_15px_rgba(52,211,153,0.3)]">
             <Hexagon className="h-4 w-4 text-white" />
          </div>
          <span className="font-mono text-xs font-bold tracking-[0.2em] text-white">ARBITER <span className="text-white/40 font-normal">v1.0.4</span></span>
        </div>
        
        <div className="hidden md:flex items-center gap-1 bg-black/40 rounded-full p-1 border border-white/5">
          <button 
            onClick={() => setActiveTab('live')}
            className={\`px-4 py-1.5 rounded-full font-mono text-[10px] uppercase tracking-wider font-semibold transition-all flex items-center gap-2 \${activeTab === 'live' ? 'bg-white/10 text-white shadow-sm' : 'text-white/40 hover:text-white hover:bg-white/5'}\`}
          >
            <span className={\`w-1.5 h-1.5 rounded-full \${liveState?.isActive ? 'bg-emerald-400 animate-pulse' : 'bg-white/20'}\`}></span>
            Paper Trading
          </button>
          <button 
            onClick={() => setActiveTab('metrics')}
            className={\`px-4 py-1.5 rounded-full font-mono text-[10px] uppercase tracking-wider font-semibold transition-all flex items-center gap-2 \${activeTab === 'metrics' ? 'bg-white/10 text-white shadow-sm' : 'text-white/40 hover:text-white hover:bg-white/5'}\`}
          >
            Strategy Metrics
          </button>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-[10px] text-white/40 font-mono tracking-widest hidden lg:inline">SESSION: <span className="text-white/80">BNS-SPOT-1092-A</span></span>
          <div className={\`px-3 py-1.5 rounded-full font-mono border text-[9px] tracking-widest uppercase flex items-center gap-2 bg-black/40 \${getStatusColor(state.session)}\`}>
            <span className="w-1.5 h-1.5 rounded-full bg-current"></span>
            {state.session}
          </div>
        </div>
      </motion.header>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col p-4 md:p-6 w-full max-w-[1240px] mx-auto gap-6 overflow-hidden z-10 mt-2">
        
        {/* Mobile Navigation Fallback */}
        <div className="md:hidden flex items-center gap-1 bg-black/40 rounded-2xl p-1 border border-white/5 shrink-0">
          <button 
            onClick={() => setActiveTab('live')}
            className={\`flex-1 py-2.5 rounded-xl font-mono text-[10px] uppercase tracking-wider transition-all flex justify-center items-center gap-2 \${activeTab === 'live' ? 'bg-white/10 text-white' : 'text-white/40'}\`}
          >
            <span className={\`w-1.5 h-1.5 rounded-full \${liveState?.isActive ? 'bg-emerald-400 animate-pulse' : 'bg-transparent'}\`}></span> Live
          </button>
          <button 
            onClick={() => setActiveTab('metrics')}
            className={\`flex-1 py-2.5 rounded-xl font-mono text-[10px] uppercase tracking-wider transition-all \${activeTab === 'metrics' ? 'bg-white/10 text-white' : 'text-white/40'}\`}
          >
            Metrics
          </button>
        </div>

        <AnimatePresence mode="wait">
        {activeTab === 'live' ? (
          <motion.div 
             key="live"
             initial={{ opacity: 0, y: 10, scale: 0.98 }}
             animate={{ opacity: 1, y: 0, scale: 1 }}
             exit={{ opacity: 0, y: -10, scale: 0.98 }}
             transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
             className="flex-1 flex flex-col w-full gap-4 md:gap-5 pb-10 overflow-y-auto custom-scrollbar pr-2"
          >
            <div className="flex flex-col md:flex-row justify-between md:items-end gap-4 mb-2 shrink-0 px-2">
              <div className="flex flex-col gap-1.5">
                <h2 className="font-sans font-semibold text-2xl tracking-tight text-white flex items-center gap-2">Live Execution <span className="px-2.5 py-0.5 rounded-md bg-white/10 text-[10px] uppercase tracking-widest text-white/70 font-mono align-middle">Alpaca Paper</span></h2>
                <p className="font-sans text-sm text-white/50">Virtual engine stream with real-time quantitative monitoring.</p>
                {(liveState?.status === 'ERROR' || liveState?.status === 'ERROR_RECOVERING') && liveState?.lastError && (
                  <p className="font-mono text-[11px] text-rose-400 mt-1 max-w-xl bg-rose-500/10 p-2 rounded-md border border-rose-500/20">{liveState.lastError}</p>
                )}
              </div>
              
              <div className="flex items-center gap-3 bg-white/5 border border-white/10 rounded-2xl p-1.5 backdrop-blur-md">
                 <div className="flex items-center gap-3 px-3 border-r border-white/10">
                   <div className={\`w-2 h-2 rounded-full \${liveState?.isActive ? (liveState.status === 'ERROR_RECOVERING' ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400 animate-pulse shadow-[0_0_12px_rgba(52,211,153,0.5)]') : (liveState?.status === 'ERROR' || liveState?.status === 'LIQUIDATED' || liveState?.status === 'SYSTEM_HALTED') ? 'bg-rose-500' : 'bg-white/20'}\`}></div>
                   <span className={\`font-mono text-[10px] uppercase tracking-widest \${(liveState?.status === 'ERROR' || liveState?.status === 'LIQUIDATED' || liveState?.status === 'SYSTEM_HALTED') ? 'text-rose-400 font-bold' : (liveState?.status === 'ERROR_RECOVERING' ? 'text-amber-400' : 'text-white/70')}\`}>
                     {liveState?.status === 'RUNNING' 
                        ? (liveState?.openPositions?.length > 0 ? 'ACTIVE' : 'AWAITING') 
                        : (liveState?.status || 'STOPPED')}
                   </span>
                 </div>
                 
                 <div className="flex items-center gap-1.5 pr-1.5">
                   {!liveState?.isActive && (
                     <button onClick={handleResetLive} title="Hard Reset (Back to 10k)" className="px-3 py-1.5 rounded-xl text-[10px] font-mono tracking-widest uppercase font-bold bg-transparent text-white/50 hover:bg-white/10 hover:text-white transition-all">
                        ↺ Reset
                     </button>
                   )}
                   {liveState?.isActive ? (
                     <button onClick={handleStopLive} className="px-4 py-1.5 rounded-xl text-[10px] font-mono tracking-widest uppercase font-bold bg-rose-500/20 text-rose-400 border border-rose-500/30 hover:bg-rose-500/30 transition-all">
                        Stop
                     </button>
                   ) : (
                     <button onClick={handleStartLive} className="px-4 py-1.5 rounded-xl text-[10px] font-mono tracking-widest uppercase font-bold bg-white text-black hover:bg-white/90 shadow-lg shadow-white/10 transition-all">
                        Start Engine
                     </button>
                   )}
                 </div>
              </div>
            </div>

            {/* Bento Grid layout for Live Metrics */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-5 shrink-0">
              <div className="bg-white/5 p-5 rounded-3xl border border-white/5 flex flex-col justify-center backdrop-blur-md relative overflow-hidden group">
                 <div className="absolute inset-0 bg-gradient-to-br from-white/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
                 <p className="text-[11px] font-mono text-white/40 uppercase tracking-widest mb-1 relative z-10">Wallet Balance</p>
                 <div className="flex items-baseline gap-2 relative z-10 mt-1">
                   <p className="text-3xl font-sans font-medium text-white tracking-tight">${liveState?.balance?.toFixed(2) || '10000.00'}</p>
                   {liveState?.balance !== undefined && (
                     <span className={\`text-xs font-mono font-bold tracking-tight px-2 py-0.5 rounded-md \${liveState.balance >= 10000 ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'}\`}>
                       {liveState.balance >= 10000 ? '+' : ''}{(((liveState.balance - 10000) / 10000) * 100).toFixed(3)}%
                     </span>
                   )}
                 </div>
              </div>
              <div className="bg-white/5 p-5 rounded-3xl border border-white/5 flex flex-col justify-center backdrop-blur-md relative overflow-hidden group">
                 <div className="absolute inset-0 bg-gradient-to-br from-white/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
                 <p className="text-[11px] font-mono text-white/40 uppercase tracking-widest mb-1 relative z-10">Active Positions</p>
                 <p className="text-3xl font-sans font-medium text-white tracking-tight mt-1 relative z-10">{liveState?.openPositions?.length || 0}</p>
              </div>
              <div className="bg-white/5 p-5 rounded-3xl border border-white/5 flex flex-col justify-center backdrop-blur-md relative overflow-hidden group">
                 <div className="absolute inset-0 bg-gradient-to-br from-white/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
                 <p className="text-[11px] font-mono text-white/40 uppercase tracking-widest mb-1 relative z-10">Current Cycle Regime</p>
                 <p className={\`text-2xl font-sans font-medium tracking-tight mt-1 capitalize relative z-10 \${liveState?.regime === 'BULL' || liveState?.regime === 'EUPHORIA' ? 'text-emerald-400' : liveState?.regime === 'BEAR' || liveState?.regime === 'CRASH' ? 'text-rose-400' : 'text-amber-400'}\`}>
                   {liveState?.regime || 'UNKNOWN'}
                 </p>
                 <Hexagon className={\`absolute -right-4 -bottom-4 w-24 h-24 opacity-10 \${liveState?.regime === 'BULL' ? 'text-emerald-400 animate-spin-slow' : 'text-white'}\`} />
              </div>
            </div>

            {/* Live Chart Area */}
            {liveState?.equityHistory && liveState.equityHistory.length > 0 && (
            <div className="bg-white/5 border border-white/10 rounded-[24px] overflow-hidden flex flex-col w-full shrink-0 backdrop-blur-md relative">
              <div className="px-6 py-4 flex items-center justify-between shrink-0 z-10">
                <span className="font-sans font-medium text-sm text-white">Equity Timeline</span>
              </div>
              <div className="w-full h-[320px] pt-0 pr-2">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 20 }}>
                    <defs>
                      <linearGradient id="liveEqGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#34D399" stopOpacity={0.3}/>
                        <stop offset="95%" stopColor="#34D399" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <XAxis 
                      dataKey="timestamp" 
                      type="number" 
                      scale="time" 
                      domain={['auto', 'auto']}
                      tickFormatter={(tick) => {
                        const d = new Date(tick);
                        const day = d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
                        const hrs = d.getHours().toString().padStart(2, '0');
                        return \`\${day} \${hrs}:00\`;
                      }}
                      stroke="rgba(255,255,255,0.05)"
                      tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10, fontFamily: 'monospace' }}
                      minTickGap={20}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis 
                      domain={['auto', 'auto']} 
                      stroke="rgba(255,255,255,0.05)" 
                      tick={{fill: 'rgba(255,255,255,0.4)', fontSize: 10, fontFamily: 'monospace'}}
                      tickFormatter={(val) => \`\$\${val.toFixed(0)}\`}
                      width={60}
                      tickLine={false}
                      axisLine={false}
                    />
                    <Tooltip 
                      contentStyle={{ backgroundColor: 'rgba(10,10,20,0.9)', backdropFilter: 'blur(10px)', borderColor: 'rgba(255,255,255,0.1)', color: '#fff', fontSize: '12px', fontFamily: 'sans-serif', borderRadius: '12px', padding: '12px' }}
                      itemStyle={{ color: '#34D399', fontWeight: 500 }}
                      formatter={(val: number) => [\`\$\${val.toFixed(2)}\`, 'Equity']}
                      labelFormatter={(label) => new Date(label).toLocaleTimeString()}
                    />
                    {(referenceLines || []).map((ref, idx) => (
                      <ReferenceLine 
                        key={idx} 
                        x={ref.time} 
                        stroke={ref.color} 
                        strokeOpacity={ref.opacity} 
                        label={{ position: 'top', value: ref.label, fill: 'rgba(255,255,255,0.5)', fontSize: 9, fontFamily: 'monospace' }}
                        strokeDasharray="3 3"
                      />
                    ))}
                    <Area 
                      type="monotone" 
                      dataKey="equity" 
                      stroke="#34D399" 
                      strokeWidth={2.5}
                      fillOpacity={1} 
                      fill="url(#liveEqGradient)" 
                      isAnimationActive={true}
                      animationDuration={400}
                    />
                  </AreaChart>
                 </ResponsiveContainer>
              </div>
            </div>
            )}

            {/* Positions Table */}
            <div className="bg-white/5 border border-white/10 rounded-[24px] overflow-hidden flex flex-col flex-1 min-h-[300px] shrink-0 backdrop-blur-md">
              <div className="px-6 py-4 border-b border-white/5 flex items-center justify-between">
                <span className="font-sans font-medium text-sm text-white">Active Portfolio</span>
              </div>
              <div className="p-0 overflow-y-auto custom-scrollbar flex-1">
                {(!liveState?.openPositions || liveState.openPositions.length === 0) ? (
                  <div className="p-12 flex flex-col items-center justify-center text-white/30 font-sans text-sm h-full font-medium">
                     <div className="w-12 h-12 rounded-full border border-white/10 flex items-center justify-center mb-3 bg-white/5">
                        <Activity className="w-5 h-5 opacity-50" />
                     </div>
                     No Active Positions
                  </div>
                ) : (
                  <div className="overflow-x-auto px-2">
                    <table className="w-full text-left font-mono text-[12px] whitespace-nowrap">
                      <thead className="text-white/40 text-[10px] uppercase tracking-widest sticky top-0 bg-black/40 backdrop-blur-xl z-20">
                        <tr>
                          <th className="px-4 py-4 font-medium rounded-tl-xl">Symbol</th>
                          <th className="px-4 py-4 font-medium">Side</th>
                          <th className="px-4 py-4 font-medium">Leverage</th>
                          <th className="px-4 py-4 font-medium">Size</th>
                          <th className="px-4 py-4 font-medium">Entry Price</th>
                          <th className="px-4 py-4 font-medium text-right">Trailing Stop</th>
                          <th className="px-4 py-4 font-medium text-right rounded-tr-xl">Unrealized PnL</th>
                        </tr>
                      </thead>
                      <tbody>
                        {liveState.openPositions.map((p: any, i: number) => (
                          <tr key={i} className="border-b border-white/5 hover:bg-white/[0.02] transition-colors group">
                            <td className="px-4 py-4 text-white font-medium">{p.symbol}</td>
                            <td className="px-4 py-4">
                                <span className={\`px-2 py-1 rounded-md text-[10px] font-bold \${p.direction === 'LONG' ? 'bg-emerald-500/10 text-emerald-400' : p.direction === 'SHORT' ? 'bg-rose-500/10 text-rose-400' : 'bg-white/10 text-white'}\`}>
                                   {p.direction?.toUpperCase()}
                                </span>
                            </td>
                            <td className="px-4 py-4 text-amber-400">x{p.leverage || 1}</td>
                            <td className="px-4 py-4 text-white/60">{p.size ? p.size.toFixed(4) : (p.contracts ? p.contracts.toFixed(4) : '0.00')}</td>
                            <td className="px-4 py-4 text-white/60">\${p.entryPrice?.toFixed(4)}</td>
                            <td className="px-4 py-4 text-right text-white/60">\${p.currentStopLoss?.toFixed(4)}</td>
                            <td className={\`px-4 py-4 text-right font-medium tracking-tight \${p.unrealizedPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}\`}>
                              {p.unrealizedPnl >= 0 ? '+' : '-'}\${Math.abs(p.unrealizedPnl || 0).toFixed(4)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>

          </motion.div>
        ) : activeTab === 'metrics' ? (
          <motion.div 
             key="metrics"
             initial={{ opacity: 0, scale: 0.98 }}
             animate={{ opacity: 1, scale: 1 }}
             exit={{ opacity: 0, scale: 0.98 }}
             transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
             className="flex-1 overflow-y-auto custom-scrollbar flex flex-col w-full gap-8 pb-10 px-2"
          >
            <div className="flex flex-col md:flex-row justify-between md:items-end gap-4 mb-2 shrink-0">
              <div className="flex flex-col gap-1.5">
                <h2 className="font-sans font-semibold text-2xl tracking-tight text-white flex items-center gap-2">Strategy Intelligence</h2>
                <p className="font-sans text-sm text-white/50">Continuous statistical tracking of virtual engine performance.</p>
              </div>
              <button 
                onClick={() => {
                  if (!metrics) return;
                  const output = JSON.stringify(metrics, null, 2);
                  const blob = new Blob([output], { type: 'text/plain' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = \`arbiter_metrics_\${new Date().toISOString().slice(0, 10)}.txt\`;
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  URL.revokeObjectURL(url);
                }}
                className="px-5 py-2.5 rounded-xl font-sans text-xs font-medium bg-white/10 text-white border border-white/10 hover:bg-white hover:text-black transition-all shadow-lg"
              >
                ⤓ Export JSON
              </button>
            </div>

            {(() => {
              const groups = [
                {
                  title: '1. Yield Generation',
                  items: [
                    { label: 'Total Return', key: 'totalReturn', fmt: (v: number) => \`\${(v * 100).toFixed(2)}%\`, polarity: true },
                    { label: 'Annualized Return / CAGR', key: 'cagr', fmt: (v: number) => \`\${(v * 100).toFixed(2)}%\`, polarity: true },
                    { label: 'Net Profit', key: 'netProfit', fmt: (v: number) => \`\$\${v.toFixed(2)}\`, polarity: true },
                    { label: 'Average Trade', key: 'avgTrade', fmt: (v: number) => \`\$\${v.toFixed(2)}\`, polarity: true },
                  ]
                },
                {
                  title: '2. Risk Adjusted Profile',
                  items: [
                    { label: 'Max Drawdown', key: 'maxDD', fmt: (v: number) => \`\${(v * 100).toFixed(2)}%\`, polarity: false },
                    { label: 'Sharpe Ratio', key: 'sharpe', fmt: (v: number) => v.toFixed(2), polarity: true },
                    { label: 'Sortino Ratio', key: 'sortino', fmt: (v: number) => v.toFixed(2), polarity: true },
                    { label: 'Calmar Ratio', key: 'calmar', fmt: (v: number) => v.toFixed(2), polarity: true },
                    { label: 'Ulcer Index', key: 'ulcerIndex', fmt: (v: number) => v.toFixed(2), polarity: false },
                  ]
                },
                {
                  title: '3. Execution Quality',
                  items: [
                    { label: 'Profit Factor', key: 'profitFactor', fmt: (v: number) => v.toFixed(2), polarity: true, defaultColor: true },
                    { label: 'Hit Rate', key: 'hitRate', fmt: (v: number) => \`\${(v * 100).toFixed(1)}%\`, polarity: false, defaultColor: true },
                    { label: 'Expectancy', key: 'expectancy', fmt: (v: number) => \`\$\${v.toFixed(2)}\`, polarity: true },
                    { label: 'Avg Win', key: 'avgWin', fmt: (v: number) => \`\$\${v.toFixed(2)}\`, polarity: true },
                    { label: 'Avg Loss', key: 'avgLoss', fmt: (v: number) => \`-\$\${Math.abs(v).toFixed(2)}\`, polarity: false },
                    { label: 'Win/Loss Ratio', key: 'winLossRatio', fmt: (v: number) => v.toFixed(2), polarity: true, defaultColor: true },
                    { label: 'Trade Count', key: 'tradesCount', fmt: (v: number) => v.toString(), polarity: false, defaultColor: true },
                  ]
                },
                {
                  title: '4. System Robustness',
                  items: [
                    { label: 'Recovery Factor', key: 'recoveryFactor', fmt: (v: number) => v.toFixed(2), polarity: true, defaultColor: true },
                    { label: 'Time Under Water (Mins)', key: 'timeUnderWater', fmt: (v: number) => v.toString(), polarity: false, defaultColor: true },
                    { label: 'Max DD Duration (Mins)', key: 'maxDDDuration', fmt: (v: number) => v.toString(), polarity: false, defaultColor: true },
                    { label: 'Stability by regime', key: 'stabilityByRegime', fmt: (v: string) => v, polarity: false, defaultColor: true },
                    { label: 'Out-of-sample performance', key: 'oosPerformance', fmt: (v: string) => v, polarity: false, defaultColor: true },
                    { label: 'Cost sensitivity', key: 'costSensitivity', fmt: (v: string) => v, polarity: false, defaultColor: true },
                  ]
                }
              ];

              return (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  {groups.map((group, groupIdx) => (
                    <div key={groupIdx} className="bg-white/[0.03] border border-white/5 rounded-[24px] overflow-hidden flex flex-col backdrop-blur-sm">
                      <div className="px-6 py-5 border-b border-white/5 bg-white/[0.02]">
                        <h3 className="font-sans font-medium text-sm text-white tracking-wide">{group.title}</h3>
                      </div>
                      <div className="overflow-x-auto px-2">
                        <table className="w-full text-left font-mono whitespace-nowrap border-collapse">
                          <thead className="text-white/40 text-[10px] uppercase tracking-widest">
                            <tr>
                              <th className="px-4 py-4 font-normal">Metric</th>
                              <th className="px-4 py-4 font-normal text-right">T 0</th>
                              <th className="px-4 py-4 font-normal text-right">T -15m</th>
                              <th className="px-4 py-4 font-normal text-right">T -24h</th>
                            </tr>
                          </thead>
                          <tbody className="text-[12px]">
                            {group.items.map((item: any, i: number) => {
                              const v0 = (metrics?.t0 as any)?.[item.key] ?? '-';
                              const v1 = (metrics?.t1 as any)?.[item.key] ?? '-';
                              const v24 = (metrics?.t24h as any)?.[item.key] ?? '-';
                              
                              const renderVal = (v: any) => {
                                if (v === '-') return <span className="text-white/20">-</span>;
                                if (typeof v === 'string') return <span className="text-white/80">{item.fmt(v)}</span>;
                                
                                let colorClass = 'text-white/80';
                                if (!item.defaultColor) {
                                  if (item.polarity) {
                                    colorClass = v > 0 ? 'text-emerald-400' : v < 0 ? 'text-rose-400' : 'text-white/50';
                                  } else {
                                    colorClass = v > 0 ? 'text-rose-400' : v < 0 ? 'text-emerald-400' : 'text-white/50';
                                  }
                                }
                                return <span className={colorClass}>{item.fmt(v)}</span>;
                              };

                              return (
                                <tr key={i} className="border-t border-white/5 hover:bg-white/5 transition-colors">
                                  <td className="px-4 py-3.5 text-white/50 font-sans border-r border-white/5">{item.label}</td>
                                  <td className="px-4 py-3.5 text-right font-medium">{renderVal(v0)}</td>
                                  <td className="px-4 py-3.5 text-right font-medium">{renderVal(v1)}</td>
                                  <td className="px-4 py-3.5 text-right font-medium">{renderVal(v24)}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()}

          </motion.div>
        ) : null}
        </AnimatePresence>
      </main>
    </div>
  );
`;

const content = fs.readFileSync('src/Dashboard.tsx', 'utf-8');
const lines = content.split('\\n');
const returnIdx = lines.findIndex(l => l.includes('return (') && !l.includes('return <span') && !l.includes('return <div'));
if (returnIdx > -1) {
  lines.splice(returnIdx, lines.length - returnIdx, JS_NEW_JSX);
  fs.writeFileSync('src/Dashboard.tsx', lines.join('\\n'));
  console.log('Replaced successfully');
} else {
  console.log('Regex fail');
}

