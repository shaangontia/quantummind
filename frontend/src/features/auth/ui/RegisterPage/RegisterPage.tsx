import { useState, type FormEvent } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Divider from '@mui/material/Divider';
import Alert from '@mui/material/Alert';
import { useRegisterMutation } from '../../../../store/auth/index.ts';

const API_BASE = '/api';

const GOOGLE_ICON = (
  <svg viewBox="0 0 24 24" width={20} height={20} aria-hidden="true" style={{ flexShrink: 0 }}>
    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
  </svg>
);

export const RegisterPage = () => {
  const navigate = useNavigate();
  const [register, { isLoading }] = useRegisterMutation();

  const [email,     setEmail]     = useState('');
  const [password,  setPassword]  = useState('');
  const [confirm,   setConfirm]   = useState('');
  const [showEmail, setShowEmail] = useState(false);
  const [error,     setError]     = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== confirm)  { setError('Passwords do not match.');             return; }
    if (password.length < 8)   { setError('Password must be at least 8 characters.'); return; }
    try {
      await register({ email: email.trim().toLowerCase(), password }).unwrap();
      navigate('/', { replace: true });
    } catch (err: unknown) {
      setError(
        (err as { error?: string })?.error ??
        (err as { data?: { error?: string } })?.data?.error ??
        'Registration failed. Please try again.',
      );
    }
  };

  return (
    <Box display="flex" alignItems="center" justifyContent="center" minHeight="100vh" bgcolor="background.default">
      <Paper elevation={0} sx={{ p: 4, width: '100%', maxWidth: 400, mx: 2 }}>
        <Box display="flex" alignItems="center" gap={1} mb={3} justifyContent="center">
          <Typography fontSize="1.5rem">⚛</Typography>
          <Typography
            variant="h6" fontWeight={700}
            sx={{ background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}
          >
            QuantumMind
          </Typography>
        </Box>

        <Typography variant="h5" fontWeight={700} textAlign="center" mb={0.5}>Create account</Typography>
        <Typography variant="body2" color="text.secondary" textAlign="center" mb={3}>
          Start your AI-powered trading portfolio
        </Typography>

        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

        <Button
          fullWidth variant="outlined"
          startIcon={GOOGLE_ICON}
          onClick={() => { window.location.href = `${API_BASE}/auth/google`; }}
          sx={{ mb: 2, py: 1.25 }}
        >
          Continue with Google
        </Button>

        <Divider sx={{ mb: 2 }}><Typography variant="caption" color="text.secondary">or</Typography></Divider>

        {!showEmail ? (
          <Button fullWidth variant="text" onClick={() => setShowEmail(true)}>
            Register with email
          </Button>
        ) : (
          <Box component="form" onSubmit={e => void handleSubmit(e)} display="flex" flexDirection="column" gap={2}>
            <TextField label="Email" type="email" autoComplete="email" required fullWidth
              value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" />
            <TextField label="Password" type="password" autoComplete="new-password" required fullWidth
              inputProps={{ minLength: 8 }} value={password} onChange={e => setPassword(e.target.value)}
              placeholder="Min. 8 characters" />
            <TextField label="Confirm Password" type="password" autoComplete="new-password" required fullWidth
              value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="Re-enter password" />
            <Button type="submit" variant="contained" fullWidth disabled={isLoading} sx={{ py: 1.25 }}>
              {isLoading ? 'Creating account…' : 'Create account'}
            </Button>
          </Box>
        )}

        <Typography variant="body2" color="text.secondary" textAlign="center" mt={2.5}>
          Already have an account?{' '}
          <Box component={Link} to="/login" sx={{ color: 'primary.main', '&:hover': { textDecoration: 'underline' } }}>
            Sign in
          </Box>
        </Typography>
      </Paper>
    </Box>
  );
};
