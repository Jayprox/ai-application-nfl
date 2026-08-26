import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const navLinkClass = ({ isActive }) =>
  `px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
    isActive ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-200'
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
      <header className="border-b border-slate-200 bg-white">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <NavLink to="/teams" className="font-semibold tracking-tight text-slate-900">
            Chalk That <span className="text-slate-400">NFL</span>
          </NavLink>
          <nav className="flex items-center gap-1">
            <NavLink to="/teams" className={navLinkClass}>
              Teams
            </NavLink>
            <NavLink to="/players" className={navLinkClass}>
              Players
            </NavLink>
            <button
              type="button"
              onClick={handleLogout}
              className="ml-2 px-3 py-1.5 rounded-md text-sm font-medium text-slate-500 hover:bg-slate-200"
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
