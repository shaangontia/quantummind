import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Toolbar from '@mui/material/Toolbar';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Avatar from '@mui/material/Avatar';
import Chip from '@mui/material/Chip';
import { TarsChat } from '../TarsChat/TarsChat.tsx';
import { useGetCurrentUserQuery, useLogoutMutation } from '../../../store/auth/index.ts';
import { isNSEMarketOpen } from '../../../features/portfolios/model/portfolios.marketHours.ts';

const NAV_LINK_SX = {
  color: 'text.secondary',
  fontSize: '0.875rem',
  fontWeight: 500,
  px: 1.5,
  py: 0.75,
  borderRadius: 1,
  textDecoration: 'none',
  transition: 'color 0.15s, background 0.15s',
  '&:hover': { color: 'text.primary', bgcolor: 'background.paper' },
  '&.active': { color: 'primary.main', bgcolor: 'background.paper' },
};

export const AppLayout = () => {
  const navigate = useNavigate();
  const { data: user } = useGetCurrentUserQuery();
  const [logout] = useLogoutMutation();
  const marketOpen = isNSEMarketOpen();

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <Box display="flex" flexDirection="column" minHeight="100vh">
      <AppBar position="sticky" elevation={0}>
        <Toolbar sx={{ gap: 3, minHeight: '56px !important', px: 3 }}>
          {/* Logo */}
          <Button
            onClick={() => navigate('/')}
            sx={{
              gap: 1,
              color: 'text.primary',
              fontWeight: 700,
              fontSize: '1rem',
              background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
              '&:hover': { bgcolor: 'transparent' },
            }}
          >
            ⛛ QuantumMind
          </Button>
          <Chip
            label="AI TRADER"
            size="small"
            sx={{ bgcolor: 'rgba(139,92,246,0.1)', color: 'secondary.light', fontWeight: 700, fontSize: '0.65rem', letterSpacing: '0.08em', border: '1px solid rgba(139,92,246,0.3)', height: 20 }}
          />

          {/* Nav */}
          <Box display="flex" gap={0.5}>
            <Box component={NavLink} to="/" end sx={NAV_LINK_SX}>Portfolios</Box>
            {user?.isAdmin && (
              <>
                <Box component={NavLink} to="/admin/overlap" sx={NAV_LINK_SX}>Overlap</Box>
                <Box component={NavLink} to="/admin/decisions" sx={NAV_LINK_SX}>Decisions</Box>
                <Box component={NavLink} to="/admin/failed-decisions" sx={NAV_LINK_SX}>Failed</Box>
                <Box component={NavLink} to="/admin/portfolio-health" sx={NAV_LINK_SX}>Health</Box>
                <Box component={NavLink} to="/admin/candidate-trace" sx={NAV_LINK_SX}>Candidates</Box>
                <Box component={NavLink} to="/admin/replay-simulator" sx={NAV_LINK_SX}>Simulator</Box>
              </>
            )}
          </Box>

          <Box flex={1} />

          {/* Market status */}
          <Box display="flex" alignItems="center" gap={0.75}>
            <Box
              component="span"
              sx={{
                width: 8, height: 8, borderRadius: '50%',
                bgcolor: marketOpen ? 'success.main' : 'text.disabled',
                animation: marketOpen ? 'pulse 2s infinite' : 'none',
                '@keyframes pulse': { '0%,100%': { opacity: 1 }, '50%': { opacity: 0.5 } },
              }}
            />
            <Typography
              variant="caption"
              sx={{ color: marketOpen ? 'success.main' : 'text.disabled', fontWeight: 600, display: { xs: 'none', sm: 'block' } }}
            >
              {marketOpen ? 'Market Open' : 'Market Closed'}
            </Typography>
          </Box>

          {/* User */}
          {user && (
            <Box display="flex" alignItems="center" gap={1}>
              {user.avatarUrl && (
                <Avatar src={user.avatarUrl} alt={user.name ?? user.email} sx={{ width: 28, height: 28 }} />
              )}
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: { xs: 'none', md: 'block' } }}
                title={user.email}
              >
                {user.name ?? user.email}
              </Typography>
              <Button
                size="small"
                variant="outlined"
                onClick={() => void handleLogout()}
                sx={{ fontSize: '0.75rem', py: 0.25, px: 1.25 }}
              >
                Sign out
              </Button>
            </Box>
          )}
        </Toolbar>
      </AppBar>

      <Box component="main" flex={1} sx={{ maxWidth: 1440, mx: 'auto', width: '100%', p: { xs: 1.5, md: 3 } }}>
        <Outlet />
      </Box>

      <TarsChat />
    </Box>
  );
};
