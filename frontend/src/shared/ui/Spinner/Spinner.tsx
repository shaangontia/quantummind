import CircularProgress from '@mui/material/CircularProgress';
import Box from '@mui/material/Box';

interface SpinnerProps {
  size?: number;
}

export const Spinner = ({ size = 24 }: SpinnerProps) => (
  <Box display="flex" alignItems="center" justifyContent="center">
    <CircularProgress size={size} thickness={4} />
  </Box>
);
