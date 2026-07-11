import MuiSkeleton from '@mui/material/Skeleton';

interface SkeletonBlockProps {
  height?: number | string;
  width?: string;
  borderRadius?: number;
}

export const SkeletonBlock = ({ height = 20, width = '100%', borderRadius = 6 }: SkeletonBlockProps) => (
  <MuiSkeleton
    variant="rectangular"
    height={height}
    width={width}
    sx={{ borderRadius: `${borderRadius}px`, bgcolor: 'rgba(255,255,255,0.06)' }}
  />
);
