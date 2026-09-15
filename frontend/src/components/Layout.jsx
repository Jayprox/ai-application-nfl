import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import NavGroup from './NavGroup';

const navLinkClass = ({ isActive }) =>
  `px-3 py-1.5 rounded-md text-sm font-medium transition-colors whitespace-nowrap ${
    isActive ? 'bg-accent text-on-accent' : 'text-ink-dim hover:bg-surface-2'
  }`;

// Part 2 Phase 3 nav/IA cleanup (2026-09-15) — see NavGroup.jsx's own
// header comment for why these 9 routes (everything but Board, which
// stays standalone as the app's front door) are grouped into 3 clusters
// instead of 10 flat top-level links: Research (browsing raw
// schedule/team/player data), Agents (the deterministic/LLM agent
// surfaces this app is actually built around), Record (accountability —
// what got picked and how it graded).
const RESEARCH_ITEMS = [
  { to: '/games', label: 'Games' },
  { to: '/teams', label: 'Teams' },
  { to: '/players', label: 'Players' },
];
const AGENTS_ITEMS = [
  { to: '/rankings', label: 'Rankings' },
  { to: '/edge', label: 'Edge' },
  { to: '/portfolio', label: 'Portfolio' },
  { to: '/chat', label: 'Chat' },
];
const RECORD_ITEMS = [
  { to: '/picks', label: 'Picks' },
  { to: '/leaderboard', label: 'Leaderboard' },
];

export default function Layout() {
  const { logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-line bg-surface">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <NavLink to="/board" className="font-display text-lg font-semibold uppercase tracking-wide text-ink">
            Chalk That <span className="text-ink-faint">NFL</span>
          </NavLink>
          <nav className="flex items-center gap-1 overflow-x-auto">
            <NavLink to="/board" className={navLinkClass}>
              Board
            </NavLink>
            <NavGroup label="Research" items={RESEARCH_ITEMS} />
            <NavGroup label="Agents" items={AGENTS_ITEMS} />
            <NavGroup label="Record" items={RECORD_ITEMS} />
            <button
              type="button"
              onClick={handleLogout}
              className="ml-2 px-3 py-1.5 rounded-md text-sm font-medium text-ink-dim hover:bg-surface-2 whitespace-nowrap"
            >
              Log out
            </button>
          </nav>
        </div>
      </header>

      <main className="flex-1 max-w-5xl w-full mx-auto px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
