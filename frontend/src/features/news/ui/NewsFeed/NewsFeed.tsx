import { useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import ButtonGroup from '@mui/material/ButtonGroup';
import Alert from '@mui/material/Alert';
import Divider from '@mui/material/Divider';
import { useNewsFeed } from '../../hooks/useNewsFeed.ts';
import { Badge } from '../../../../shared/ui/Badge/Badge.tsx';
import { Spinner } from '../../../../shared/ui/Spinner/Spinner.tsx';
import { EmptyState } from '../../../../shared/ui/EmptyState/EmptyState.tsx';
import type { SentimentLabel } from '../../../../api/news.api.types.ts';
import type { BadgeVariant } from '../../../../shared/ui/Badge/Badge.tsx';

const sentimentVariant = (label: SentimentLabel): BadgeVariant => {
  const map: Record<SentimentLabel, BadgeVariant> = {
    VERY_BULLISH: 'green', BULLISH: 'green', NEUTRAL: 'gray', BEARISH: 'red', VERY_BEARISH: 'red',
  };
  return map[label];
};

interface NewsFeedProps { compact?: boolean; }

export const NewsFeed = ({ compact = false }: NewsFeedProps) => {
  const [highSignalOnly, setHighSignalOnly] = useState(false);
  const { items, isLoading, error } = useNewsFeed(highSignalOnly);
  const visibleItems = compact ? items.slice(0, 8) : items;

  return (
    <Box>
      <Box display="flex" alignItems="center" justifyContent="space-between" mb={2}>
        <Typography variant="h6" fontWeight={700}>NSE Announcements</Typography>
        <ButtonGroup size="small" variant="outlined">
          <Button onClick={() => setHighSignalOnly(false)} variant={!highSignalOnly ? 'contained' : 'outlined'}>All</Button>
          <Button onClick={() => setHighSignalOnly(true)}  variant={highSignalOnly  ? 'contained' : 'outlined'}>🔥 High Signal</Button>
        </ButtonGroup>
      </Box>

      {isLoading && <Box display="flex" justifyContent="center" py={3}><Spinner /></Box>}
      {error && <Alert severity="error" sx={{ mb: 2 }}>⚠ {error}</Alert>}

      {!isLoading && !error && visibleItems.length === 0 && (
        <EmptyState icon="📰" title="No announcements" description="NSE feed will populate during market hours." />
      )}

      {!isLoading && visibleItems.length > 0 && (
        <Box>
          {visibleItems.map((item, i) => (
            <Box key={`${item.symbol}-${i}`}>
              {i > 0 && <Divider sx={{ my: 1.5 }} />}
              <Box display="flex" alignItems="center" gap={1} mb={0.5} flexWrap="wrap">
                <Typography variant="body2" fontWeight={700}>{item.symbol.replace('.NS', '')}</Typography>
                <Badge variant={sentimentVariant(item.sentimentLabel)}>
                  {item.sentimentLabel.replace('_', ' ')}
                </Badge>
                <Typography variant="caption" color="text.secondary" ml="auto">{item.date}</Typography>
              </Box>
              <Typography variant="caption" color="text.secondary" display="block">{item.companyName}</Typography>
              <Typography variant="body2" mt={0.25}>{item.headline}</Typography>
              <Typography variant="caption" color="primary.light" mt={0.25} display="block">{item.category}</Typography>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
};
