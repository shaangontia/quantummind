"use strict";
/**
 * QuantumMind ML Engine
 * Pure TypeScript ML - no external dependencies.
 * Provides: linear regression, momentum scoring,
 * volatility calculation, Kelly Criterion sizing,
 * and correlation-aware signal boosting.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getHistoricalReturns = getHistoricalReturns;
exports.computeMomentumScore = computeMomentumScore;
exports.kellyPositionSize = kellyPositionSize;
exports.computeKellySize = computeKellySize;
exports.computeCorrelationMatrix = computeCorrelationMatrix;
exports.getMLBoost = getMLBoost;
const https_1 = __importDefault(require("https"));
// ─── Helpers ─────────────────────────────────────────────────────────────────
function mean(arr) {
    return arr.reduce((s, x) => s + x, 0) / arr.length;
}
function stdDev(arr) {
    const m = mean(arr);
    return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
}
function covariance(a, b) {
    const ma = mean(a), mb = mean(b);
    return a.reduce((s, x, i) => s + (x - ma) * (b[i] - mb), 0) / a.length;
}
function correlation(a, b) {
    const sa = stdDev(a), sb = stdDev(b);
    if (sa === 0 || sb === 0)
        return 0;
    return covariance(a, b) / (sa * sb);
}
// Simple linear regression → slope (trend direction & magnitude)
function linearRegressionSlope(y) {
    const n = y.length;
    const x = Array.from({ length: n }, (_, i) => i);
    const mx = mean(x), my = mean(y);
    const num = x.reduce((s, xi, i) => s + (xi - mx) * (y[i] - my), 0);
    const den = x.reduce((s, xi) => s + (xi - mx) ** 2, 0);
    return den === 0 ? 0 : num / den;
}
// ─── Historical data fetching ─────────────────────────────────────────────────
function yahooGet(url) {
    return new Promise((resolve, reject) => {
        https_1.default.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }, (res) => {
            let d = '';
            res.on('data', (x) => { d += x; });
            res.on('end', () => { try {
                resolve(JSON.parse(d));
            }
            catch (e) {
                reject(e);
            } });
        }).on('error', reject);
    });
}
async function getHistoricalReturns(symbol, days = 60) {
    const sym = symbol.endsWith('.NS') ? symbol : `${symbol}.NS`;
    const json = await yahooGet(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=3mo`);
    const closes = (json.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [])
        .filter((c) => c !== null)
        .slice(-days);
    if (closes.length < 2)
        return [];
    const returns = [];
    for (let i = 1; i < closes.length; i++) {
        returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
    }
    return returns;
}
async function computeMomentumScore(symbol) {
    try {
        const returns = await getHistoricalReturns(symbol, 60);
        if (returns.length < 10)
            return null;
        const slope = linearRegressionSlope(returns); // trend direction
        const vol = stdDev(returns) * Math.sqrt(252); // annualised volatility
        const avgReturn = mean(returns) * 252; // annualised return
        const sharpe = vol > 0 ? avgReturn / vol : 0;
        // Normalise slope to [-1, +1] using tanh
        const score = Math.tanh(slope * 5000);
        const trend = score > 0.1 ? 'UP' : score < -0.1 ? 'DOWN' : 'FLAT';
        return { symbol, score, trend, volatility: vol, sharpeEstimate: sharpe, lookbackDays: returns.length };
    }
    catch {
        return null;
    }
}
function kellyPositionSize(winRate, // probability of winning trade
avgWin, // average gain on winning trade
avgLoss, // average loss on losing trade (positive number)
maxPosPct = 0.08 // position cap
) {
    if (avgLoss === 0)
        return 0;
    const b = avgWin / avgLoss;
    const q = 1 - winRate;
    const kelly = (b * winRate - q) / b;
    // Half-Kelly for safety, capped at maxPosPct
    return Math.max(0, Math.min(maxPosPct, kelly * 0.5));
}
async function computeKellySize(symbol, maxPosPct = 0.08) {
    const returns = await getHistoricalReturns(symbol, 90);
    const wins = returns.filter(r => r > 0);
    const losses = returns.filter(r => r < 0);
    const winRate = wins.length / Math.max(returns.length, 1);
    const avgWin = wins.length > 0 ? mean(wins) : 0.01;
    const avgLoss = losses.length > 0 ? Math.abs(mean(losses)) : 0.01;
    const kelly = kellyPositionSize(winRate, avgWin, avgLoss, maxPosPct);
    return {
        symbol,
        kellyFraction: (avgWin / avgLoss * winRate - (1 - winRate)) / (avgWin / avgLoss),
        adjustedFraction: kelly,
        recommendedPct: kelly * 100,
    };
}
async function computeCorrelationMatrix(symbols) {
    const returnsMap = new Map();
    await Promise.all(symbols.map(async (s) => {
        const r = await getHistoricalReturns(s, 60).catch(() => []);
        if (r.length > 10)
            returnsMap.set(s, r);
    }));
    const syms = Array.from(returnsMap.keys());
    const pairs = [];
    const overCorrelated = [];
    for (let i = 0; i < syms.length; i++) {
        for (let j = i + 1; j < syms.length; j++) {
            const a = returnsMap.get(syms[i]);
            const b = returnsMap.get(syms[j]);
            const minLen = Math.min(a.length, b.length);
            const corr = correlation(a.slice(-minLen), b.slice(-minLen));
            const warning = Math.abs(corr) > 0.80;
            pairs.push({ symbolA: syms[i], symbolB: syms[j], correlation: corr, warning });
            if (warning)
                overCorrelated.push([syms[i], syms[j]]);
        }
    }
    return { pairs, overCorrelated };
}
async function getMLBoost(symbol, riskTolerance = 'Medium') {
    const maxPosPct = riskTolerance === 'High' ? 0.08 : riskTolerance === 'Low' ? 0.03 : 0.05;
    const [momentum, kelly] = await Promise.all([
        computeMomentumScore(symbol).catch(() => null),
        computeKellySize(symbol, maxPosPct).catch(() => ({ recommendedPct: maxPosPct * 100, adjustedFraction: maxPosPct })),
    ]);
    let boost = 0;
    const reasons = [];
    if (momentum) {
        if (momentum.trend === 'UP' && momentum.score > 0.3) {
            boost += 1;
            reasons.push(`ML momentum: ${(momentum.score * 100).toFixed(0)} (UP, Sharpe ${momentum.sharpeEstimate.toFixed(2)})`);
        }
        else if (momentum.trend === 'DOWN' && momentum.score < -0.3) {
            boost -= 1;
            reasons.push(`ML momentum: bearish trend (score ${(momentum.score * 100).toFixed(0)})`);
        }
    }
    return {
        symbol,
        momentumBoost: boost,
        kellyMaxPos: kelly.adjustedFraction,
        reason: reasons.join('; ') || 'ML: neutral',
    };
}
