import './StatCard.css';

interface StatCardProps {
  label: string;
  value: string;
  sub?: string;
  trend?: 'up' | 'down' | 'neutral';
  accent?: string;
}

export const StatCard = ({ label, value, sub, trend, accent }: StatCardProps) => (
  <div className="stat-card">
    <span className="stat-label">{label}</span>
    <span className="stat-value" style={accent ? { color: accent } : undefined}>{value}</span>
    {sub && (
      <span className={`stat-sub ${trend === 'up' ? 'tag-positive' : trend === 'down' ? 'tag-negative' : 'tag-neutral'}`}>
        {sub}
      </span>
    )}
  </div>
);
