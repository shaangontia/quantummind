"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchAnnouncements = fetchAnnouncements;
exports.getStockSentiment = getStockSentiment;
exports.getHighSignalAnnouncements = getHighSignalAnnouncements;
const https_1 = __importDefault(require("https"));
// Keyword sentiment map for corporate announcements
const BULLISH_STRONG = [
    'dividend', 'buyback', 'bonus', 'split', 'acquisition', 'merger', 'order win',
    'contract award', 'record profit', 'record revenue', 'beat estimates', 'upgrade',
    'delisting offer', 'open offer', 'fundraise', 'ipo', 'rights issue at premium'
];
const BULLISH_WEAK = [
    'capacity expansion', 'new plant', 'joint venture', 'strategic partnership',
    'quarterly results', 'board meeting', 'agm', 'annual report', 'credit rating upgrade',
    'bagged', 'secured', 'won', 'appointed ceo', 'new md'
];
const BEARISH_STRONG = [
    'fraud', 'sebi notice', 'raid', 'nclt', 'insolvency', 'bankruptcy', 'winding up',
    'criminal', 'arrest', 'default', 'npa', 'wilful defaulter', 'regulatory action',
    'fine imposed', 'penalty', 'suspension', 'delisted', 'downgrade', 'loss widened'
];
const BEARISH_WEAK = [
    'below estimates', 'profit decline', 'revenue decline', 'resignation', 'lawsuit',
    'litigation', 'legal notice', 'investigation', 'credit rating downgrade'
];
function scoreAnnouncement(text) {
    const lower = text.toLowerCase();
    let score = 0;
    for (const kw of BULLISH_STRONG) {
        if (lower.includes(kw))
            score += 2;
    }
    for (const kw of BULLISH_WEAK) {
        if (lower.includes(kw))
            score += 1;
    }
    for (const kw of BEARISH_STRONG) {
        if (lower.includes(kw))
            score -= 2;
    }
    for (const kw of BEARISH_WEAK) {
        if (lower.includes(kw))
            score -= 1;
    }
    const clamped = Math.max(-2, Math.min(2, score));
    const label = clamped >= 2 ? 'VERY_BULLISH' :
        clamped === 1 ? 'BULLISH' :
            clamped === 0 ? 'NEUTRAL' :
                clamped === -1 ? 'BEARISH' : 'VERY_BEARISH';
    return { score: clamped, label };
}
function nseGet(path) {
    return new Promise((resolve, reject) => {
        const opts = {
            hostname: 'www.nseindia.com',
            path,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://www.nseindia.com/',
            },
        };
        https_1.default.get(opts, (res) => {
            let data = '';
            res.on('data', (d) => { data += d; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                }
                catch (e) {
                    reject(new Error(`Parse error: ${data.slice(0, 100)}`));
                }
            });
        }).on('error', reject);
    });
}
// Fetch latest corporate announcements from NSE
async function fetchAnnouncements() {
    const raw = await nseGet('/api/corporate-announcements?index=equities');
    if (!Array.isArray(raw))
        return [];
    return raw.map((item) => {
        const text = `${item.desc || ''} ${item.attchmntText || ''}`;
        const { score, label } = scoreAnnouncement(text);
        return {
            symbol: `${item.symbol}.NS`,
            companyName: item.sm_name || item.symbol,
            date: item.an_dt || item.sort_date,
            category: item.desc || 'General',
            headline: (item.attchmntText || item.desc || '').slice(0, 200),
            sentimentScore: score,
            sentimentLabel: label,
        };
    });
}
// Get sentiment for a specific stock from recent announcements
async function getStockSentiment(symbol) {
    try {
        const all = await fetchAnnouncements();
        const nseSymbol = symbol.replace('.NS', '');
        const stockAnnouncements = all.filter(a => a.symbol.replace('.NS', '') === nseSymbol);
        if (stockAnnouncements.length === 0)
            return null;
        const avgScore = stockAnnouncements.reduce((sum, a) => sum + a.sentimentScore, 0) / stockAnnouncements.length;
        const label = avgScore >= 1.5 ? 'VERY_BULLISH' :
            avgScore >= 0.5 ? 'BULLISH' :
                avgScore >= -0.5 ? 'NEUTRAL' :
                    avgScore >= -1.5 ? 'BEARISH' : 'VERY_BEARISH';
        return { score: avgScore, label, announcements: stockAnnouncements };
    }
    catch {
        return null;
    }
}
// Scan all announcements for high-signal events across watchlist
async function getHighSignalAnnouncements() {
    const all = await fetchAnnouncements();
    return all.filter(a => Math.abs(a.sentimentScore) >= 2);
}
