// Phase 4 screen 2. Layout/route shell only — wiring this to real data
// from GET /teams is Phase 5 "Feature 1: Team browse + team detail".
export default function TeamBrowsePage() {
  return (
    <div>
      <h1 className="text-xl font-semibold text-slate-900 mb-1">Teams</h1>
      <p className="text-sm text-slate-500">
        All 32 teams will list here — wired to <code>GET /teams</code> in Feature 1.
      </p>
    </div>
  );
}
