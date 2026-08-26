import { useParams } from 'react-router-dom';

// Phase 4 screen 5 — the app's main screen (see docs/vibe-coding-checklist.md
// Phase 4 component sketch). Layout/route shell only for now: scope tabs
// (season/last-5/career/game log) are Feature 3, split filters are
// Feature 4, and the injury badge is Feature 5 — all wired to POST /query
// and GET /players/:id.
export default function PlayerDetailPage() {
  const { playerId } = useParams();
  return (
    <div>
      <h1 className="text-xl font-semibold text-slate-900 mb-1">Player {playerId}</h1>
      <p className="text-sm text-slate-500">
        Season averages, last-5-game trends, career stats, split filters, and
        injury status will show here — wired to <code>POST /query</code> and{' '}
        <code>GET /players/:id</code> across Features 3–5.
      </p>
    </div>
  );
}
