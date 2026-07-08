/**
 * NSE market hours utility.
 * NSE trades Mon–Fri, 09:15–15:30 IST (UTC+05:30).
 */

const IST_OFFSET_MINUTES = 5 * 60 + 30;
const MARKET_OPEN_MINUTES  = 9 * 60 + 15;   // 09:15 IST
const MARKET_CLOSE_MINUTES = 15 * 60 + 30;  // 15:30 IST

/** Returns true if the NSE is currently open. */
export const isNSEMarketOpen = (): boolean => {
  const now = new Date();
  const utcDay = now.getUTCDay(); // 0 = Sunday, 6 = Saturday
  if (utcDay === 0 || utcDay === 6) return false;

  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const istMinutes = (utcMinutes + IST_OFFSET_MINUTES) % (24 * 60);

  return istMinutes >= MARKET_OPEN_MINUTES && istMinutes < MARKET_CLOSE_MINUTES;
};

/** Polling interval in ms — 60 s during market hours, 0 (disabled) outside. */
export const marketPollingInterval = (): number =>
  isNSEMarketOpen() ? 60_000 : 0;
