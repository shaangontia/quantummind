import './Badge.css';

export type BadgeVariant = 'green' | 'red' | 'yellow' | 'blue' | 'purple' | 'gray';

interface BadgeProps {
  children: React.ReactNode;
  variant?: BadgeVariant;
}

export const Badge = ({ children, variant = 'gray' }: BadgeProps) => (
  <span className={`badge badge-${variant}`}>{children}</span>
);
