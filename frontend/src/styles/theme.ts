import { createTheme, alpha } from '@mui/material/styles';

/**
 * QuantumMind dark theme — maps existing CSS variables to MUI design tokens.
 * Primary: blue (#3b82f6), Secondary: purple (#8b5cf6)
 */
export const theme = createTheme({
  palette: {
    mode: 'dark',
    primary:   { main: '#3b82f6', light: '#60a5fa', dark: '#1d4ed8', contrastText: '#fff' },
    secondary: { main: '#8b5cf6', light: '#a78bfa', dark: '#6d28d9', contrastText: '#fff' },
    success:   { main: '#10b981', light: '#34d399', dark: '#059669' },
    warning:   { main: '#f59e0b', light: '#fbbf24', dark: '#d97706' },
    error:     { main: '#ef4444', light: '#f87171', dark: '#dc2626' },
    background: {
      default: '#0a0e1a',
      paper:   '#1a2035',
    },
    text: {
      primary:   '#e2e8f0',
      secondary: '#94a3b8',
      disabled:  '#64748b',
    },
    divider: '#2d3748',
  },

  typography: {
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', sans-serif",
    fontSize: 14,
    h1: { fontWeight: 700 },
    h2: { fontWeight: 700 },
    h3: { fontWeight: 700 },
    h4: { fontWeight: 600 },
    h5: { fontWeight: 600 },
    h6: { fontWeight: 600 },
  },

  shape: { borderRadius: 8 },

  components: {
    MuiCssBaseline: {
      styleOverrides: {
        '*': { boxSizing: 'border-box', margin: 0, padding: 0 },
        'html, body, #root': { height: '100%', minHeight: '100vh' },
        body: { WebkitFontSmoothing: 'antialiased', MozOsxFontSmoothing: 'grayscale' },
        a: { color: 'inherit', textDecoration: 'none' },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: { backgroundImage: 'none', backgroundColor: '#1a2035', border: '1px solid #2d3748' },
      },
    },
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: { textTransform: 'none', fontWeight: 600, borderRadius: 6 },
        outlined: { borderColor: '#2d3748', '&:hover': { borderColor: '#3b82f6', background: alpha('#3b82f6', 0.08) } },
        text: { color: '#94a3b8', '&:hover': { background: alpha('#fff', 0.06) } },
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          backgroundColor: '#0d1220',
          '& .MuiOutlinedInput-notchedOutline': { borderColor: '#2d3748' },
          '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: '#3b82f6' },
          '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: '#3b82f6' },
        },
        input: { color: '#e2e8f0' },
      },
    },
    MuiInputLabel: {
      styleOverrides: { root: { color: '#94a3b8', '&.Mui-focused': { color: '#3b82f6' } } },
    },
    MuiSelect: {
      styleOverrides: { icon: { color: '#64748b' } },
    },
    MuiChip: {
      styleOverrides: { root: { fontWeight: 600, fontSize: '0.72rem' } },
    },
    MuiTableHead: {
      styleOverrides: { root: { '& .MuiTableCell-root': { background: '#111827', color: '#64748b', fontWeight: 600, fontSize: '0.75rem', letterSpacing: '0.04em', textTransform: 'uppercase', borderBottom: '1px solid #2d3748' } } },
    },
    MuiTableCell: {
      styleOverrides: { root: { borderBottom: '1px solid rgba(45,55,72,0.5)', padding: '10px 12px', color: '#e2e8f0' } },
    },
    MuiTableRow: {
      styleOverrides: { root: { '&:hover': { background: 'rgba(255,255,255,0.025)' } } },
    },
    MuiDialog: {
      styleOverrides: { paper: { backgroundColor: '#111827', border: '1px solid #2d3748', backgroundImage: 'none' } },
    },
    MuiAppBar: {
      styleOverrides: { root: { backgroundColor: '#0d1220', borderBottom: '1px solid #2d3748', backgroundImage: 'none' } },
    },
    MuiLinearProgress: {
      styleOverrides: { root: { backgroundColor: '#2d3748', borderRadius: 4 } },
    },
    MuiDivider: {
      styleOverrides: { root: { borderColor: '#2d3748' } },
    },
    MuiAlert: {
      styleOverrides: { root: { borderRadius: 8 } },
    },
    MuiTooltip: {
      styleOverrides: { tooltip: { backgroundColor: '#1e2740', border: '1px solid #2d3748', fontSize: '0.72rem' } },
    },
  },
});
