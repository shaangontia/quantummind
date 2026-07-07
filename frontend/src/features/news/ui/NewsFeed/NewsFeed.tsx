import { useState } from 'react';
import { useNewsFeed } from '../../hooks/useNewsFeed.ts';
import { Badge } from '../../../../shared/ui/Badge/Badge.tsx';
import { Spinner } from '../../../../shared/ui/Spinner/Spinner.tsx';
import { EmptyState } from '../../../../shared/ui/EmptyState/EmptyState.tsx';
import type { SentimentLabel } from '../../../../api/news.api.types.ts';
import type { BadgeVariant } from '../../../../shared/ui/Badge/Badge.tsx';
import './NewsFeed.css';

const sentimentVariant = (label: SentimentLabel): BadgeVariant => {
  const map: Record<SentimentLabel, BadgeVariant> = {
    VERY_BULLISH: 'green',
    BULLISH: 'green',
    NEUTRAL: 'gray',
    BEARISH: 'red',
    VERY_BEARISH: 'red',
  };
  return map[label];
};

interface NewsFeedProps {
  compact?: boolean;
}

export const NewsFeed = ({ compact = false }: NewsFeedProps) => {
  const [highSignalOnly, setHighSignalOnly] = useState(false);
  const { items, isLoading, error } = useNewsFeed(highSignalOnly);

  const visibleItems = compact ? items.slice(0, 8) : items;

  return (
    <div className="news-feed">
      <div className="news-feed-header">
        <h2 className="section-title">NSE Announcements</h2>
        <div className="news-filters">
          <button
            className={`filter-btn ${!highSignalOnly ? 'active' : ''}`}
            onClick={() => setHighSignalOnly(false)}
          >
            All
          </button>
          <button
            className={`filter-btn ${highSignalOnly ? 'active' : ''}`}
            onClick={() => setHighSignalOnly(true)}
          >
            🔥 High Signal
          </button>
        </div>
      </div>

      {isLoading && <div className="news-loading"><Spinner /></div>}
      {error && <div className="news-error">⚠ {error}</div>}

      {!isLoading && !error && visibleItems.length === 0 && (
        <EmptyState icon="📰" title="No announcements" description="NSE feed will populate during market hours." />
      )}

      {!isLoading && visibleItems.length > 0 && (
        <ul className="news-list">
          {visibleItems.map((item, i) => (
            <li key={`${item.symbol}-${i}`} className="news-item">
              <div className="news-item-top">
                <span className="news-symbol">{item.symbol.replace('.NS', '')}</span>
                <Badge variant={sentimentVariant(item.sentimentLabel)}>
                  {item.sentimentLabel.replace('_', ' ')}
                </Badge>
                <span className="news-date">{item.date}</span>
              </div>
              <p className="news-company">{item.companyName}</p>
              <p className="news-headline">{item.headline}</p>
              <span className="news-category">{item.category}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
