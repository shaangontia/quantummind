"use strict";
/**
 * Structured JSON logger for QuantumMind.
 * Every trading decision, price fetch, and cron cycle emits a structured event
 * to make audit trails machine-readable and debuggable.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = void 0;
function emit(level, event) {
    const entry = {
        ts: new Date().toISOString(),
        level,
        svc: 'quantummind',
        ...event,
    };
    const line = JSON.stringify(entry);
    if (level === 'error')
        console.error(line);
    else if (level === 'warn')
        console.warn(line);
    else
        console.log(line);
}
exports.logger = {
    info: (event) => emit('info', event),
    warn: (event) => emit('warn', event),
    error: (event) => emit('error', event),
    debug: (event) => emit('debug', event),
    trade(portfolioId, symbol, action, price, source, riskApproved, reason, extra = {}) {
        emit('info', {
            job: 'trade-execution', portfolioId, symbol, phase: 'execution',
            action, price, source, priceFresh: true, riskApproved, reason, ...extra,
        });
    },
    signal(portfolioId, symbol, action, strength, reason, price) {
        emit('info', {
            job: 'signal-engine', portfolioId, symbol, phase: 'signal',
            signalAction: action, strength, reason, price,
        });
    },
    priceEvent(symbol, provider, price, isFresh, latencyMs, statusCode) {
        emit('info', {
            job: 'market-data', symbol, phase: 'price-fetch',
            provider, price, priceFresh: isFresh, latencyMs, statusCode,
        });
    },
    riskBlock(portfolioId, symbol, reason) {
        emit('warn', {
            job: 'risk-engine', portfolioId, symbol, phase: 'risk', action: 'BLOCK', reason,
        });
    },
    cronCycle(event) {
        emit('info', { job: 'market-cycle', phase: 'cron', ...event });
    },
};
