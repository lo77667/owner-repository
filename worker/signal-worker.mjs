import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, 'data');
const SIGNALS_FILE = path.join(DATA_DIR, 'signals.json');
const REPORTS_DIR = path.join(DATA_DIR, 'reports');

const PAIRS = (process.env.SIGNAL_PAIRS || 'EUR/USD,GBP/USD,USD/JPY,USD/CHF,AUD/USD,USD/CAD,NZD/USD,EUR/GBP,EUR/JPY,GBP/JPY,AUD/JPY,EUR/AUD')
  .split(',').map((x) => x.trim()).filter(Boolean);
const MIN_CONFIDENCE = Number(process.env.MIN_CONFIDENCE || 55);
const RR = Number(process.env.RISK_REWARD || 2);
const MAX_HOLD_HOURS = Number(process.env.MAX_HOLD_HOURS || 24);
const SLOT_HOURS = Number(process.env.SIGNAL_SLOT_HOURS || 3);
const TIMEOUT_MS = 15000;

const env = {
  twelve: process.env.TWELVE_DATA_KEY || '',
  news: process.env.NEWS_API_KEY || '',
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChat: process.env.TELEGRAM_CHAT_ID || '',
};

function assertConfig(mode) {
  const required = mode === 'signal' ? ['twelve', 'telegramToken', 'telegramChat'] : [];
  const missing = required.filter((key) => !env[key]);
  if (missing.length) throw new Error(`Missing required environment variables for ${mode}: ${missing.join(', ')}`);
}

async function ensureStorage() {
  await fs.mkdir(REPORTS_DIR, { recursive: true });
  try { await fs.access(SIGNALS_FILE); }
  catch { await fs.writeFile(SIGNALS_FILE, JSON.stringify({ version: 1, signals: [], runs: [], reports: [] }, null, 2)); }
}

async function readStore() {
  await ensureStorage();
  const raw = JSON.parse(await fs.readFile(SIGNALS_FILE, 'utf8'));
  return { version: 1, signals: raw.signals || [], runs: raw.runs || [], reports: raw.reports || [] };
}

async function writeStore(store) {
  const tmp = `${SIGNALS_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2));
  await fs.rename(tmp, SIGNALS_FILE);
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'oracle-merged-worker/1.0' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function fetchCandles(pair) {
  if (!env.twelve) throw new Error('TWELVE_DATA_KEY is not configured');
  const url = new URL('https://api.twelvedata.com/time_series');
  url.search = new URLSearchParams({
    symbol: pair,
    interval: '1h',
    outputsize: '150',
    order: 'ASC',
    apikey: env.twelve,
  });
  const data = await fetchJson(url);
  if (data.status === 'error' || !Array.isArray(data.values)) throw new Error(data.message || `No candles for ${pair}`);
  return data.values.map((row) => ({
    t: Date.parse(row.datetime),
    o: toNumber(row.open), h: toNumber(row.high), l: toNumber(row.low), c: toNumber(row.close),
    v: toNumber(row.volume) || 0,
  })).filter((x) => [x.t, x.o, x.h, x.l, x.c].every(Number.isFinite));
}

async function fetchNews() {
  if (!env.news) return [];
  const url = new URL('https://newsapi.org/v2/everything');
  url.search = new URLSearchParams({
    q: 'forex OR currency OR central bank OR interest rates',
    language: 'en',
    sortBy: 'publishedAt',
    pageSize: '50',
    apiKey: env.news,
  });
  try {
    const data = await fetchJson(url);
    return (data.articles || []).map((a) => ({ title: a.title || '', description: a.description || '', publishedAt: a.publishedAt || '' }));
  } catch (error) {
    console.warn(`News fetch failed: ${error.message}`);
    return [];
  }
}

function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((sum, value) => sum + value, 0) / period;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i += 1) {
    const delta = values[i] - values[i - 1];
    if (delta >= 0) gains += delta; else losses -= delta;
  }
  if (losses === 0) return 100;
  return 100 - (100 / (1 + gains / losses));
}

function atr(candles, period = 14) {
  if (candles.length <= period) return null;
  const trs = [];
  for (let i = candles.length - period; i < candles.length; i += 1) {
    const current = candles[i];
    const previous = candles[i - 1];
    trs.push(Math.max(current.h - current.l, Math.abs(current.h - previous.c), Math.abs(current.l - previous.c)));
  }
  return trs.reduce((sum, value) => sum + value, 0) / trs.length;
}

function adxApprox(candles, period = 14) {
  if (candles.length <= period + 1) return null;
  let plus = 0, minus = 0, tr = 0;
  for (let i = candles.length - period; i < candles.length; i += 1) {
    const c = candles[i], p = candles[i - 1];
    const up = c.h - p.h, down = p.l - c.l;
    plus += up > down && up > 0 ? up : 0;
    minus += down > up && down > 0 ? down : 0;
    tr += Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
  }
  if (!tr) return 0;
  const plusDI = 100 * plus / tr, minusDI = 100 * minus / tr;
  return 100 * Math.abs(plusDI - minusDI) / Math.max(plusDI + minusDI, 1);
}

function sentiment(text) {
  const positive = ['surge', 'rally', 'gain', 'rise', 'growth', 'strong', 'bullish', 'beat', 'upgrade', 'recovery', 'boost', 'soar', 'hawkish'];
  const negative = ['crash', 'plunge', 'fall', 'drop', 'loss', 'weak', 'bearish', 'miss', 'downgrade', 'fear', 'crisis', 'recession', 'slump', 'dovish'];
  const lower = text.toLowerCase();
  const p = positive.reduce((n, word) => n + (lower.includes(word) ? 1 : 0), 0);
  const n = negative.reduce((n, word) => n + (lower.includes(word) ? 1 : 0), 0);
  return Math.max(-1, Math.min(1, (p - n) / Math.max(3, p + n)));
}

function newsBias(pair, articles) {
  const [base, quote] = pair.split('/');
  const aliases = { USD: ['usd', 'dollar', 'fed'], EUR: ['eur', 'euro', 'ecb'], GBP: ['gbp', 'pound', 'boe'], JPY: ['jpy', 'yen', 'boj'], AUD: ['aud', 'australian', 'rba'], CAD: ['cad', 'canada', 'boc'], CHF: ['chf', 'swiss', 'snb'], NZD: ['nzd', 'new zealand', 'rbnz'] };
  let score = 0, weight = 0;
  for (const article of articles) {
    const text = `${article.title} ${article.description}`.toLowerCase();
    const baseHit = (aliases[base] || []).some((x) => text.includes(x));
    const quoteHit = (aliases[quote] || []).some((x) => text.includes(x));
    if (!baseHit && !quoteHit) continue;
    const s = sentiment(text);
    score += (baseHit ? s : 0) - (quoteHit ? s : 0);
    weight += 1;
  }
  return weight ? Math.max(-1, Math.min(1, score / weight)) : 0;
}

function pipSize(pair) { return pair.includes('JPY') ? 0.01 : 0.0001; }
function decimals(pair) { return pair.includes('JPY') ? 3 : 5; }
function fmt(pair, value) { return Number(value).toFixed(decimals(pair)); }
function slotKey(date = new Date()) {
  const slotHour = Math.floor(date.getUTCHours() / SLOT_HOURS) * SLOT_HOURS;
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), slotHour));
  return d.toISOString();
}

function analyzePair(pair, candles, articles) {
  const closes = candles.map((c) => c.c);
  const price = closes.at(-1);
  const fast = sma(closes, 20), slow = sma(closes, 50), r = rsi(closes), a = atr(candles), strength = adxApprox(candles);
  if (![price, fast, slow, r, a, strength].every(Number.isFinite)) return null;
  const news = newsBias(pair, articles);
  let buy = 0, sell = 0;
  const reasons = [];
  if (price > fast && fast > slow) { buy += 26; reasons.push('trend_up'); }
  if (price < fast && fast < slow) { sell += 26; reasons.push('trend_down'); }
  if (r >= 52 && r <= 70) { buy += 18; reasons.push('rsi_bullish'); }
  if (r <= 48 && r >= 30) { sell += 18; reasons.push('rsi_bearish'); }
  if (strength >= 20) { buy += price >= fast ? 12 : 0; sell += price < fast ? 12 : 0; reasons.push('adx_trend'); }
  if (news > 0.12) { buy += 16; reasons.push('news_positive'); }
  if (news < -0.12) { sell += 16; reasons.push('news_negative'); }
  const direction = buy >= sell ? 'BUY' : 'SELL';
  const raw = Math.max(buy, sell);
  const confidence = Math.min(95, Math.round(45 + raw * 0.72));
  const pips = a / pipSize(pair);
  const slDistance = a * 1.35;
  const tpDistance = slDistance * RR;
  return {
    pair, direction, confidence, price, atr: a, rsi: r, adx: strength, newsBias: news,
    entry: price,
    stopLoss: direction === 'BUY' ? price - slDistance : price + slDistance,
    takeProfit: direction === 'BUY' ? price + tpDistance : price - tpDistance,
    riskPips: Number(pips * 1.35).toFixed(1),
    rewardPips: Number(pips * 1.35 * RR).toFixed(1),
    reasons: reasons.slice(0, 6),
  };
}

async function mapLimit(items, limit, fn) {
  const results = [], queue = [...items];
  async function worker() {
    while (queue.length) {
      const item = queue.shift();
      try { results.push(await fn(item)); }
      catch (error) { results.push({ pair: item, error: error.message }); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function closeAgainstCandle(signal, candle) {
  const long = signal.direction === 'BUY';
  if (long && candle.l <= signal.stopLoss) return { outcome: 'LOSS', exit: signal.stopLoss, reason: 'SL' };
  if (long && candle.h >= signal.takeProfit) return { outcome: 'WIN', exit: signal.takeProfit, reason: 'TP' };
  if (!long && candle.h >= signal.stopLoss) return { outcome: 'LOSS', exit: signal.stopLoss, reason: 'SL' };
  if (!long && candle.l <= signal.takeProfit) return { outcome: 'WIN', exit: signal.takeProfit, reason: 'TP' };
  return null;
}

function updateOpenSignals(store, candlesByPair, now = Date.now()) {
  let changed = 0;
  for (const signal of store.signals.filter((x) => x.status === 'OPEN')) {
    const candles = candlesByPair[signal.pair] || [];
    const relevant = candles.filter((c) => c.t > signal.createdAt && c.t <= now);
    let result = null;
    for (const candle of relevant) { result = closeAgainstCandle(signal, candle); if (result) break; }
    if (!result && now - signal.createdAt >= MAX_HOLD_HOURS * 3600000 && candles.length) {
      const exit = candles.at(-1).c;
      result = { outcome: (signal.direction === 'BUY' ? exit > signal.entry : exit < signal.entry) ? 'WIN' : 'LOSS', exit, reason: 'TIME' };
    }
    if (result) {
      signal.status = 'CLOSED'; signal.outcome = result.outcome; signal.exit = result.exit; signal.exitReason = result.reason;
      signal.closedAt = now; signal.pips = Number(((signal.direction === 'BUY' ? result.exit - signal.entry : signal.entry - result.exit) / pipSize(signal.pair)).toFixed(1));
      changed += 1;
    }
  }
  return changed;
}

function estimateHealth(signals) {
  const closed = signals.filter((x) => x.status === 'CLOSED');
  const wins = closed.filter((x) => x.outcome === 'WIN').length;
  const losses = closed.filter((x) => x.outcome === 'LOSS').length;
  const pips = closed.reduce((sum, x) => sum + (x.pips || 0), 0);
  const expected = (wins + 1) / (closed.length + 2);
  return { total: closed.length, wins, losses, winRate: closed.length ? wins / closed.length : null, totalPips: Number(pips.toFixed(1)), posteriorWinRate: Number(expected.toFixed(4)), note: 'Bayesian posterior mean; not a guaranteed forecast.' };
}

function periodStart(period, now = new Date()) {
  const d = new Date(now);
  if (period === 'daily') d.setUTCHours(0, 0, 0, 0);
  if (period === 'weekly') { const day = d.getUTCDay(); d.setUTCDate(d.getUTCDate() - day); d.setUTCHours(0, 0, 0, 0); }
  if (period === 'monthly') { d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0); }
  return d.getTime();
}

function buildReport(store, period, now = new Date()) {
  const start = periodStart(period, now);
  const signals = store.signals.filter((x) => x.createdAt >= start && x.status === 'CLOSED');
  return { generatedAt: now.toISOString(), period, start: new Date(start).toISOString(), signals: signals.length, health: estimateHealth(signals), byPair: Object.fromEntries(PAIRS.map((pair) => [pair, estimateHealth(signals.filter((x) => x.pair === pair))])) };
}

async function sendTelegram(text) {
  if (!env.telegramToken || !env.telegramChat) { console.warn('Telegram not configured; message skipped.'); return false; }
  const url = `https://api.telegram.org/bot${env.telegramToken}/sendMessage`;
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: env.telegramChat, text, parse_mode: 'HTML', disable_web_page_preview: true }) });
  if (!response.ok) throw new Error(`Telegram HTTP ${response.status}`);
  return true;
}

function formatSignal(signal) {
  return `<b>ORACLE MERGED SIGNAL</b>\n${signal.direction === 'BUY' ? 'BUY' : 'SELL'} <b>${signal.pair}</b>\nConfidence: <b>${signal.confidence}%</b>\nEntry: ${fmt(signal.pair, signal.entry)}\nSL: ${fmt(signal.pair, signal.stopLoss)}\nTP: ${fmt(signal.pair, signal.takeProfit)}\nSlot: ${signal.slot}\nReasons: ${signal.reasons.join(', ')}\n\nEducational/personal signal only; not a guarantee.`;
}

async function runSignal() {
  assertConfig('signal');
  const store = await readStore();
  const slot = slotKey();
  if (store.signals.some((x) => x.slot === slot)) { console.log(`Slot already processed: ${slot}`); return; }
  const articles = await fetchNews();
  const results = await mapLimit(PAIRS, 2, async (pair) => ({ pair, candles: await fetchCandles(pair) }));
  const candlesByPair = Object.fromEntries(results.filter((x) => x.candles).map((x) => [x.pair, x.candles]));
  updateOpenSignals(store, candlesByPair);
  const candidates = results.map((x) => x.candles ? analyzePair(x.pair, x.candles, articles) : null).filter(Boolean).sort((a, b) => b.confidence - a.confidence);
  if (!candidates.length) throw new Error('No valid pair analysis was produced');
  const top = candidates[0];
  const signal = { id: `sig_${slot.replace(/\W/g, '')}_${top.pair.replace('/', '')}`, slot, createdAt: Date.now(), status: 'OPEN', quality: top.confidence >= MIN_CONFIDENCE ? 'QUALIFIED' : 'LOW_CONFIDENCE', ...top, source: { candles: 'Twelve Data 1h', news: env.news ? 'NewsAPI' : 'none' } };
  store.signals.push(signal);
  store.runs.push({ at: new Date().toISOString(), mode: 'signal', slot, candidates: candidates.slice(0, 5).map((x) => ({ pair: x.pair, direction: x.direction, confidence: x.confidence })) });
  await writeStore(store);
  await sendTelegram(formatSignal(signal));
  console.log(JSON.stringify({ created: signal.id, quality: signal.quality, pair: signal.pair, direction: signal.direction, confidence: signal.confidence }));
}

async function runReport(period) {
  const store = await readStore();
  const report = buildReport(store, period);
  const file = path.join(REPORTS_DIR, `${period}.json`);
  await fs.writeFile(file, JSON.stringify(report, null, 2));
  store.reports = store.reports.filter((x) => x.period !== period).concat(report);
  await writeStore(store);
  const h = report.health;
  const rate = h.winRate === null ? 'n/a' : `${(h.winRate * 100).toFixed(1)}%`;
  const future = `${(h.posteriorWinRate * 100).toFixed(1)}%`;
  if (env.telegramToken && env.telegramChat) await sendTelegram(`<b>ORACLE ${period.toUpperCase()} REPORT</b>\nClosed signals: ${h.total}\nWins/Losses: ${h.wins}/${h.losses}\nObserved win rate: ${rate}\nTotal pips: ${h.totalPips}\nPosterior estimate: ${future}\n\nThe posterior is an uncertainty-aware estimate, not a promise.`);
  console.log(JSON.stringify({ period, health: report.health }));
}

async function main() {
  const mode = process.argv.find((x) => x.startsWith('--mode='))?.split('=')[1] || 'signal';
  if (mode === 'signal') await runSignal();
  else if (['daily', 'weekly', 'monthly'].includes(mode)) await runReport(mode);
  else if (mode === 'all-reports') for (const period of ['daily', 'weekly', 'monthly']) await runReport(period);
  else throw new Error(`Unknown mode: ${mode}`);
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
