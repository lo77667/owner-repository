
/* ========================================================================
   MERGED ORACLE LAYER
   Non-destructive adapter: keeps the full Market Tower application intact
   and adds a unified signal journal, 3-hour slots, and report views.
   Secrets remain worker-side; this browser layer never contains credentials.
   ======================================================================== */
(() => {
  const Merged = {
    key: 'oracle_merged_signal_journal_v1',
    slotHours: 3,
    maxDaily: 8,
    minConfidence: 55,
    pairs: ['EURUSD','GBPUSD','USDJPY','USDCHF','AUDUSD','USDCAD','NZDUSD','EURGBP','EURJPY','GBPJPY','AUDJPY','EURAUD'],
    state: { signals: [], reports: [] },
  };

  const read = () => {
    try { return { ...Merged.state, ...(JSON.parse(localStorage.getItem(Merged.key)) || {}) }; }
    catch { return { ...Merged.state }; }
  };
  const write = (state) => { Merged.state = state; localStorage.setItem(Merged.key, JSON.stringify(state)); };
  const pairLabel = (p) => `${p.slice(0, 3)}/${p.slice(3, 6)}`;
  const pip = (p) => p.includes('JPY') ? 0.01 : 0.0001;
  const dec = (p) => p.includes('JPY') ? 3 : 5;
  const fmt = (p, x) => Number(x || 0).toFixed(dec(p));
  const nowSlot = (d = new Date()) => {
    const h = Math.floor(d.getUTCHours() / Merged.slotHours) * Merged.slotHours;
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h)).toISOString();
  };
  const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);

  function series(pair) {
    return (window.AppState && AppState.ohlcv && AppState.ohlcv[pair]) || [];
  }
  function smaLocal(values, period) {
    if (values.length < period) return null;
    return values.slice(-period).reduce((a, b) => a + b, 0) / period;
  }
  function rsiLocal(values, period = 14) {
    if (values.length <= period) return null;
    let gains = 0, losses = 0;
    for (let i = values.length - period; i < values.length; i += 1) {
      const d = values[i] - values[i - 1];
      if (d >= 0) gains += d; else losses -= d;
    }
    return losses === 0 ? 100 : 100 - (100 / (1 + gains / losses));
  }
  function scorePair(pair) {
    const candles = series(pair);
    if (candles.length < 30) return null;
    const closes = candles.map((c) => Number(c.c)).filter(Number.isFinite);
    const price = closes.at(-1), fast = smaLocal(closes, 20), slow = smaLocal(closes, 50), r = rsiLocal(closes);
    const localAtr = typeof window.atr === 'function' ? window.atr(candles, 14) : null;
    const localAdx = typeof window.adx === 'function' ? window.adx(candles, 14) : null;
    if (![price, fast, r].every(Number.isFinite)) return null;
    let buy = 0, sell = 0, reasons = [];
    if (Number.isFinite(slow) && price > fast && fast > slow) { buy += 30; reasons.push('trend-up'); }
    if (Number.isFinite(slow) && price < fast && fast < slow) { sell += 30; reasons.push('trend-down'); }
    if (r >= 52 && r <= 70) { buy += 22; reasons.push('RSI-bullish'); }
    if (r <= 48 && r >= 30) { sell += 22; reasons.push('RSI-bearish'); }
    if (Number.isFinite(localAdx) && localAdx >= 20) {
      if (price >= fast) buy += 14; else sell += 14;
      reasons.push('ADX-trend');
    }
    const newsBias = (window.AppState?.newsEvents || []).slice(0, 20).reduce((sum, item) => {
      const text = `${item.title || ''} ${item.description || ''}`.toLowerCase();
      const base = pair.slice(0, 3).toLowerCase(), quote = pair.slice(3).toLowerCase();
      const pos = ['surge','rally','gain','rise','growth','strong','bullish','beat','upgrade','recovery'];
      const neg = ['crash','plunge','fall','drop','loss','weak','bearish','miss','downgrade','fear','crisis'];
      const s = pos.filter((w) => text.includes(w)).length - neg.filter((w) => text.includes(w)).length;
      return sum + ((text.includes(base) ? s : 0) - (text.includes(quote) ? s : 0));
    }, 0);
    if (newsBias > 0) { buy += Math.min(14, newsBias * 2); reasons.push('news-positive'); }
    if (newsBias < 0) { sell += Math.min(14, Math.abs(newsBias) * 2); reasons.push('news-negative'); }
    const direction = buy >= sell ? 'BUY' : 'SELL';
    const raw = Math.max(buy, sell);
    const confidence = Math.min(95, Math.round(45 + raw * 0.7));
    const risk = Number.isFinite(localAtr) && localAtr > 0 ? localAtr * 1.35 : Math.abs(price - fast) || price * 0.001;
    const reward = risk * 2;
    return { pair, direction, confidence, entry: price, stopLoss: direction === 'BUY' ? price - risk : price + risk, takeProfit: direction === 'BUY' ? price + reward : price - reward, rsi: r, adx: localAdx, newsBias, reasons };
  }

  function posterior(signals) {
    const closed = signals.filter((s) => s.status === 'CLOSED');
    const wins = closed.filter((s) => s.outcome === 'WIN').length;
    const losses = closed.filter((s) => s.outcome === 'LOSS').length;
    const pips = closed.reduce((n, s) => n + Number(s.pips || 0), 0);
    return { total: closed.length, wins, losses, winRate: closed.length ? wins / closed.length : null, pips, posterior: (wins + 1) / (closed.length + 2) };
  }

  function renderStats(state) {
    const today = state.signals.filter((s) => s.day === dayKey());
    const active = state.signals.filter((s) => s.status === 'OPEN');
    const h = posterior(state.signals);
    const items = [['Today', `${today.length}/${Merged.maxDaily}`], ['Open', active.length], ['Closed', h.total], ['Observed', h.winRate == null ? 'n/a' : `${(h.winRate * 100).toFixed(1)}%`], ['Estimate', `${(h.posterior * 100).toFixed(1)}%`]];
    document.getElementById('mergedSignalStats').innerHTML = items.map(([label, value]) => `<div class="stat-card"><div class="stat-label">${label}</div><div class="stat-value">${value}</div></div>`).join('');
  }

  function renderSignals(state) {
    const list = [...state.signals].reverse().slice(0, 24);
    document.getElementById('mergedSignalsList').innerHTML = list.length ? list.map((s) => `<div class="signal-card ${s.direction === 'SELL' ? 'sell' : ''}"><div class="flex justify-between items-center mb-2"><b>${s.direction} ${pairLabel(s.pair)}</b><span class="badge ${s.quality === 'QUALIFIED' ? 'badge-buy' : 'badge-amber'}">${s.confidence}% • ${s.quality}</span></div><div class="grid grid-cols-2 gap-2 text-xs" style="color:var(--text-secondary)"><span>Entry <b>${fmt(s.pair, s.entry)}</b></span><span>Status <b>${s.status}</b></span><span>SL <b>${fmt(s.pair, s.stopLoss)}</b></span><span>TP <b>${fmt(s.pair, s.takeProfit)}</b></span></div><div class="text-xs mt-2" style="color:var(--text-dim)">${(s.reasons || []).join(' · ')}<br>${new Date(s.createdAt).toUTCString()}</div></div>`).join('') : '<div class="glass-card p-4 text-xs" style="color:var(--text-dim)">No signal has been recorded yet.</div>';
  }

  function renderTracker(state) {
    const h = posterior(state.signals);
    const items = [['Total closed', h.total], ['Wins', h.wins], ['Losses', h.losses], ['Pips', h.pips.toFixed(1)], ['Posterior', `${(h.posterior * 100).toFixed(1)}%`]];
    document.getElementById('mergedTrackerStats').innerHTML = items.map(([label, value]) => `<div class="stat-card"><div class="stat-label">${label}</div><div class="stat-value">${value}</div></div>`).join('');
    document.getElementById('mergedTrackerList').innerHTML = state.signals.filter((s) => s.status === 'CLOSED').slice(-20).reverse().map((s) => `<div class="glass-card p-3 text-xs flex justify-between"><span><b>${s.direction} ${pairLabel(s.pair)}</b> · ${s.outcome} · ${s.exitReason || ''}</span><span>${Number(s.pips || 0).toFixed(1)} pips</span></div>`).join('') || '<div class="glass-card p-4 text-xs" style="color:var(--text-dim)">Closed outcomes will appear after the worker or manual tracker records them.</div>';
  }

  function renderReports(state) {
    const h = posterior(state.signals);
    const cards = ['daily', 'weekly', 'monthly'].map((period) => {
      const span = period === 'daily' ? 1 : period === 'weekly' ? 7 : 30;
      const start = Date.now() - span * 86400000;
      const local = state.signals.filter((s) => s.createdAt >= start);
      const ph = posterior(local);
      return `<div class="glass-card p-4"><div class="stat-label">${period.toUpperCase()} REPORT</div><div class="stat-value mt-2">${local.length}</div><div class="text-xs mt-2" style="color:var(--text-secondary)">Closed: ${ph.total}<br>Wins/Losses: ${ph.wins}/${ph.losses}<br>Observed: ${ph.winRate == null ? 'n/a' : `${(ph.winRate * 100).toFixed(1)}%`}<br>Posterior: ${(ph.posterior * 100).toFixed(1)}%</div></div>`;
    }).join('');
    document.getElementById('mergedReports').innerHTML = cards;
  }

  function render() { const state = read(); renderStats(state); renderSignals(state); renderTracker(state); renderReports(state); }

  async function generateCurrent() {
    const state = read();
    const slot = nowSlot();
    if (state.signals.some((s) => s.slot === slot)) { if (typeof window.toast === 'function') window.toast('Current three-hour slot already recorded', 'info'); return; }
    const dayCount = state.signals.filter((s) => s.day === dayKey()).length;
    if (dayCount >= Merged.maxDaily) { if (typeof window.toast === 'function') window.toast('Daily limit of eight recorded slots reached', 'info'); return; }
    const candidates = Merged.pairs.map(scorePair).filter(Boolean).sort((a, b) => b.confidence - a.confidence);
    if (!candidates.length) { if (typeof window.toast === 'function') window.toast('Market data is not ready for analysis', 'error'); return; }
    const top = candidates[0];
    const signal = { id: `ui_${slot.replace(/\W/g, '')}_${top.pair}`, slot, day: dayKey(), createdAt: Date.now(), status: 'OPEN', quality: top.confidence >= Merged.minConfidence ? 'QUALIFIED' : 'LOW_CONFIDENCE', ...top, source: 'merged-browser-adapter' };
    state.signals.push(signal); write(state); render();
    if (typeof window.toast === 'function') window.toast(`Recorded ${signal.direction} ${pairLabel(signal.pair)} for current slot`, 'success');
  }

  async function loadWorkerStore() {
    try {
      const response = await fetch('data/signals.json', { cache: 'no-store' });
      if (!response.ok) return;
      const remote = await response.json();
      const local = read();
      const ids = new Set(local.signals.map((s) => s.id));
      local.signals = local.signals.concat((remote.signals || []).filter((s) => !ids.has(s.id)));
      write(local); render();
    } catch { /* local-only mode is valid */ }
  }

  function init() {
    render();
    document.getElementById('mergedRunSignal')?.addEventListener('click', generateCurrent);
    loadWorkerStore();
    setInterval(() => { loadWorkerStore(); render(); }, 15 * 60 * 1000);
    setInterval(() => { if (new Date().getUTCMinutes() < 5) generateCurrent(); }, 60 * 1000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
