/**
 * AdminOverlapPage — Admin-only view for portfolio overlap analytics.
 * Accessible via /admin/overlap — not shown in regular portfolio list.
 */
import { useNavigate } from 'react-router-dom';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { useGetPortfoliosQuery } from '../../../../store/portfolios/index.ts';
import { PortfolioOverlapPanel } from '../PortfolioOverlapPanel/index.ts';

export const AdminOverlapPage = () => {
  const navigate = useNavigate();
  const { data: portfolios = [], isLoading } = useGetPortfoliosQuery();

  return (
    <Box>
      {/* Page header */}
      <Box display="flex" alignItems="center" gap={1.5} mb={3}>
        <Button
          size="small"
          variant="text"
          startIcon={<ArrowBackIcon />}
          onClick={() => navigate('/')}
          sx={{ color: 'text.secondary' }}
        >
          Portfolios
        </Button>
      </Box>

      <Box mb={3}>
        <Typography variant="h4" fontWeight={700}>Portfolio Overlap</Typography>
        <Typography variant="body2" color="text.secondary" mt={0.5}>
          Admin view — cross-portfolio position analysis and policy differentiation report
        </Typography>
      </Box>

      {!isLoading && (
        <PortfolioOverlapPanel
          portfolios={portfolios.map(p => ({ id: p.id, name: p.name }))}
        />
      )}
    </Box>
  );
};
