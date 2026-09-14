import { Link } from 'react-router-dom';

export default function NotFoundPage() {
  return (
    <div className="text-center py-16">
      <h1 className="text-xl font-semibold text-ink mb-2">Page not found</h1>
      <Link to="/teams" className="text-sm text-ink-dim underline hover:text-ink">
        Back to Teams
      </Link>
    </div>
  );
}
