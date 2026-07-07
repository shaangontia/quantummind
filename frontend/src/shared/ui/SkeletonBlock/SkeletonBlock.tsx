import './SkeletonBlock.css';

interface SkeletonBlockProps {
  height?: number | string;
  width?: string;
  borderRadius?: number;
}

export const SkeletonBlock = ({ height = 20, width = '100%', borderRadius = 6 }: SkeletonBlockProps) => (
  <div
    className="skeleton-block"
    style={{ height, width, borderRadius }}
    aria-hidden="true"
  />
);
