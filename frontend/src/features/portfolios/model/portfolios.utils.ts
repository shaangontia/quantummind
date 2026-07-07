export const formatINR = (value: number): string =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(value);

export const formatPct = (value: number): string =>
  `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;

export const formatDate = (iso: string): string =>
  new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

export const riskColor = (risk: string): string => {
  const map: Record<string, string> = { Low: 'green', Medium: 'yellow', High: 'red' };
  return map[risk] ?? 'gray';
};

export const signalColor = (type: string): string => {
  const map: Record<string, string> = { BUY: 'green', SELL: 'red', HOLD: 'yellow', WATCH: 'blue' };
  return map[type] ?? 'gray';
};
