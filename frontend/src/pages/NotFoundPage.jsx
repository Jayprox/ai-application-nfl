import { Link } from 'react-router-dom';

export default function NotFoundPage() {
  return (
    <div className="text-center py-16">
      <h1 className="text-xl font-semibold text-slate-900 mb-2">Page not found</h1>
      <Link to="/teams" className="text-sm text-slate-600 underline hover:text-slate-900">
        Back to Teams
      </Link>
    </div>
  );
}
