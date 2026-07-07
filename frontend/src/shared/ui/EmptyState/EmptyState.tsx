import './EmptyState.css';

interface EmptyStateProps {
  icon?: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
}

export const EmptyState = ({ icon = '📭', title, description, action }: EmptyStateProps) => (
  <div className="empty-state">
    <span className="empty-icon">{icon}</span>
    <h3 className="empty-title">{title}</h3>
    {description && <p className="empty-desc">{description}</p>}
    {action && <div className="empty-action">{action}</div>}
  </div>
);
