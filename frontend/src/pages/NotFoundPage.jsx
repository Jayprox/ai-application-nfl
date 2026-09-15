import { Link } from 'react-router-dom';

export default function NotFoundPage() {
  return (
    <div className="text-center py-16">
      <h1 className="font-display text-2xl font-semibold uppercase tracking-wide text-ink mb-2">Page not found</h1>
      <Link to="/board" className="text-sm text-ink-dim underline hover:text-ink">
        Back to the Board
      </Link>
    </div>
  );
}
