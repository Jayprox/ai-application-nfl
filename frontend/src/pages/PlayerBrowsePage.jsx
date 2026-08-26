// Phase 4 screen 4. Layout/route shell only — wiring this to real search
// against GET /players is Phase 5 "Feature 2: Player search/browse".
export default function PlayerBrowsePage() {
  return (
    <div>
      <h1 className="text-xl font-semibold text-slate-900 mb-1">Players</h1>
      <p className="text-sm text-slate-500">
        Search by name/team/position will live here — wired to{' '}
        <code>GET /players</code> in Feature 2.
      </p>
    </div>
  );
}
