import './Spinner.css';

interface SpinnerProps {
  size?: number;
}

export const Spinner = ({ size = 24 }: SpinnerProps) => (
  <span className="spinner" style={{ width: size, height: size }} role="status" aria-label="Loading" />
);
