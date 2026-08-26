import { useParams } from 'react-router-dom';

// Phase 4 screen 3. Layout/route shell only — wiring this to real data
// from GET /teams/:id is Phase 5 "Feature 1: Team browse + team detail".
export default function TeamDetailPage() {
  const { teamId } = useParams();
  return (
    <div>
      <h1 className="text-xl font-semibold text-slate-900 mb-1">Team {teamId}</h1>
      <p className="text-sm text-slate-500">
        Roster + home/away and situational-split records will show here — wired to{' '}
        <code>GET /teams/:id</code> in Feature 1.
      </p>
    </div>
  );
}
