import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

interface EmptyStateProps {
  icon?: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
}

export const EmptyState = ({ icon = '📭', title, description, action }: EmptyStateProps) => (
  <Box
    display="flex"
    flexDirection="column"
    alignItems="center"
    justifyContent="center"
    textAlign="center"
    py={4}
    gap={1.5}
  >
    <Typography fontSize="2rem" lineHeight={1}>{icon}</Typography>
    <Typography variant="h6" color="text.primary" fontWeight={600}>{title}</Typography>
    {description && (
      <Typography variant="body2" color="text.secondary" maxWidth={380}>{description}</Typography>
    )}
    {action && <Box mt={1}>{action}</Box>}
  </Box>
);
