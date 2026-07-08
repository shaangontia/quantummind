"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
require("dotenv/config");
const routes_js_1 = __importDefault(require("./api/routes.js"));
const marketMonitor_js_1 = require("./scheduler/marketMonitor.js");
const tradingGuards_js_1 = require("./services/tradingGuards.js");
const PORT = process.env.PORT || 3001;
const app = (0, express_1.default)();
app.use((0, cors_1.default)({ origin: ['http://localhost:5173', 'http://localhost:3000'] }));
app.use(express_1.default.json());
app.use('/api', routes_js_1.default);
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'QuantumMind', ts: new Date().toISOString() }));
async function bootstrap() {
    // Ensure guard tables exist (idempotent)
    await (0, tradingGuards_js_1.ensureTradingConfigTable)();
    app.listen(PORT, () => {
        console.log(`\n🚀 QuantumMind Backend → http://localhost:${PORT}`);
        console.log(`   Health: http://localhost:${PORT}/health`);
        console.log(`   API:    http://localhost:${PORT}/api/portfolios\n`);
    });
    (0, marketMonitor_js_1.startScheduler)();
}
bootstrap().catch(console.error);
