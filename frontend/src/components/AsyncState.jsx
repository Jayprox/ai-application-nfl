/**
 * Shared loading/error block for every data-backed screen. Renders
 * nothing once data has loaded successfully — the page takes over from
 * there. Kept dumb on purpose (no data-shape awareness) so it works the
 * same for /teams, /players, and later /query.
 */
export default function AsyncState({ loading, error, loadingLabel = 'Loading…', onRetry }) {
  if (loading) {
    return <p className="text-sm text-ink-dim">{loadingLabel}</p>;
  }
  if (error) {
    return (
      <div className="rounded-md border border-negative/30 bg-negative/10 px-4 py-3">
        <p className="text-sm text-negative">Couldn't load this: {error}</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 text-sm font-medium text-negative underline hover:no-underline"
          >
            Try again
          </button>
        )}
      </div>
    );
  }
  return null;
}
