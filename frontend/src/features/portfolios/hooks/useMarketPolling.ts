import { useEffect, useState } from 'react';
import { marketPollingInterval } from '../model/portfolios.marketHours.ts';

/**
 * Returns the current RTK Query pollingInterval.
 * Re-evaluates every minute so components automatically start/stop polling
 * as the market opens or closes without requiring a page reload.
 */
export const useMarketPolling = (): number => {
  const [pollMs, setPollMs] = useState(marketPollingInterval);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setPollMs(marketPollingInterval());
    }, 60_000); // re-check every minute

    return () => window.clearInterval(timer);
  }, []);

  return pollMs;
};
