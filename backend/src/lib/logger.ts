/**
 * Structured JSON logger for QuantumMind.
 * Every trading decision, price fetch, and cron cycle emits a structured event
 * to make audit trails machine-readable and debuggable.
 */

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface TradeEvent {
  job?: string;
  portfolioId?: number;
  symbol?: string;
  phase?: 'price-fetch' | 'signal' | 'risk' | 'execution' | 'adaptive' | 'cron' | 'health';
  action?: 'BUY' | 'SELL' | 'HOLD' | 'SKIP' | 'BLOCK';
  price?: number;
  source?: string;
  priceFresh?: boolean;
  riskApproved?: boolean;
  reason?: string;
  provider?: string;
  latencyMs?: number;
  statusCode?: number;
  [key: string]: unknown;
}

function emit(level: LogLevel, event: TradeEvent): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    svc: 'quantummind',
    ...event,
  };
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  info:  (event: TradeEvent) => emit('info',  event),
  warn:  (event: TradeEvent) => emit('warn',  event),
  error: (event: TradeEvent) => emit('error', event),
  debug: (event: TradeEvent) => emit('debug', event),

  trade(portfolioId: number, symbol: string, action: TradeEvent['action'], price: number, source: string, riskApproved: boolean, reason: string, extra: Partial<TradeEvent> = {}): void {
    emit('info', {
      job: 'trade-execution', portfolioId, symbol, phase: 'execution',
      action, price, source, priceFresh: true, riskApproved, reason, ...extra,
    });
  },

  signal(portfolioId: number, symbol: string, action: string, strength: string, reason: string, price: number): void {
    emit('info', {
      job: 'signal-engine', portfolioId, symbol, phase: 'signal',
      signalAction: action, strength, reason, price,
    });
  },

  priceEvent(symbol: string, provider: string, price: number, isFresh: boolean, latencyMs?: number, statusCode?: number): void {
    emit('info', {
      job: 'market-data', symbol, phase: 'price-fetch',
      provider, price, priceFresh: isFresh, latencyMs, statusCode,
    });
  },

  riskBlock(portfolioId: number, symbol: string, reason: string): void {
    emit('warn', {
      job: 'risk-engine', portfolioId, symbol, phase: 'risk', action: 'BLOCK', reason,
    });
  },

  cronCycle(event: { portfolioCount: number; tradesExecuted: number; signalsGenerated: number; durationMs: number; skipped?: boolean; skipReason?: string }): void {
    emit('info', { job: 'market-cycle', phase: 'cron', ...event });
  },
};
