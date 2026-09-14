import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const navLinkClass = ({ isActive }) =>
  `px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
    isActive ? 'bg-accent text-on-accent' : 'text-ink-dim hover:bg-surface-2'
  }`;

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
          <NavLink to="/teams" className="font-semibold tracking-tight text-ink">
            Chalk That <span className="text-ink-faint">NFL</span>
          </NavLink>
          <nav className="flex items-center gap-1">
            <NavLink to="/games" className={navLinkClass}>
              Games
            </NavLink>
            <NavLink to="/teams" className={navLinkClass}>
              Teams
            </NavLink>
            <NavLink to="/players" className={navLinkClass}>
              Players
            </NavLink>
            <NavLink to="/picks" className={navLinkClass}>
              Picks
            </NavLink>
            <NavLink to="/leaderboard" className={navLinkClass}>
              Leaderboard
            </NavLink>
            <NavLink to="/rankings" className={navLinkClass}>
              Rankings
            </NavLink>
            <NavLink to="/edge" className={navLinkClass}>
              Edge
            </NavLink>
            <NavLink to="/portfolio" className={navLinkClass}>
              Portfolio
            </NavLink>
            <NavLink to="/chat" className={navLinkClass}>
              Chat
            </NavLink>
            <button
              type="button"
              onClick={handleLogout}
              className="ml-2 px-3 py-1.5 rounded-md text-sm font-medium text-ink-dim hover:bg-surface-2"
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
