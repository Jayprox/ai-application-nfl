/**
 * Shared loading/error block for every data-backed screen. Renders
 * nothing once data has loaded successfully — the page takes over from
 * there. Kept dumb on purpose (no data-shape awareness) so it works the
 * same for /teams, /players, and later /query.
 */
export default function AsyncState({ loading, error, loadingLabel = 'Loading…', onRetry }) {
  if (loading) {
    return <p className="text-sm text-slate-500">{loadingLabel}</p>;
  }
  if (error) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3">
        <p className="text-sm text-red-700">Couldn't load this: {error}</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 text-sm font-medium text-red-700 underline hover:no-underline"
          >
            Try again
          </button>
        )}
      </div>
    );
  }
  return null;
}
