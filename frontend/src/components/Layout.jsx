import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import NavGroup from './NavGroup';

const navLinkClass = ({ isActive }) =>
  `px-3 py-1.5 rounded-md text-sm font-medium transition-colors whitespace-nowrap ${
    isActive ? 'bg-accent text-on-accent' : 'text-ink-dim hover:bg-surface-2'
  }`;

// Same active-pill treatment as navLinkClass/NavGroup's own trigger, but
// full-width and stacked for the mobile drawer below rather than an
// inline pill — the drawer is a vertical list, not a horizontal row, so
// there's no reason to keep the pill's tight inline padding.
const mobileNavLinkClass = ({ isActive }) =>
  `block px-3 py-2 rounded-md text-sm font-medium transition-colors ${
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
  { to: '/props', label: 'Props' },
  { to: '/edge', label: 'Edge' },
  { to: '/portfolio', label: 'Portfolio' },
  { to: '/chat', label: 'Chat' },
];
const RECORD_ITEMS = [
  { to: '/picks', label: 'Picks' },
  { to: '/leaderboard', label: 'Leaderboard' },
];

// One flat section of the mobile drawer: an optional uppercase group
// label (Research/Agents/Record — Board has none, it's not a group) over
// its stacked links. Kept flat rather than reusing NavGroup's own
// click-to-expand accordion behavior — NavGroup exists to solve a
// horizontal-space problem (Layout.jsx's own doc comment above), and the
// drawer doesn't have one: vertical space is cheap on a phone, so every
// link can just be visible at once instead of nested another level deep
// behind a second tap.
function MobileNavSection({ title, items, onNavigate }) {
  return (
    <div className="py-2">
      {title && (
        <div className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">{title}</div>
      )}
      {items.map((item) => (
        <NavLink key={item.to} to={item.to} className={mobileNavLinkClass} onClick={onNavigate}>
          {item.label}
        </NavLink>
      ))}
    </div>
  );
}

export default function Layout() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Same "just close it" convention NavGroup.jsx's own dropdown already
  // uses for outside-click/Escape/resize — a route change is one more
  // event that should collapse the drawer rather than leave it open over
  // the page the person just navigated to.
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!mobileOpen) return undefined;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') setMobileOpen(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [mobileOpen]);

  const handleLogout = async () => {
    setMobileOpen(false);
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

          {/* Desktop/tablet nav, unchanged from before this change — just
              now hidden below md (768px) in favor of the drawer below.
              overflow-x-auto stays as a safety net for anything between
              md and a genuinely cramped width, same as it always was. */}
          <nav className="hidden md:flex items-center gap-1 overflow-x-auto">
            <NavLink to="/board" className={navLinkClass}>
              Board
            </NavLink>
            <NavGroup label="Research" items={RESEARCH_ITEMS} />
            <NavGroup label="Agents" items={AGENTS_ITEMS} />
            <NavGroup label="Record" items={RECORD_ITEMS} />
            <NavLink to="/guide" className={navLinkClass}>
              Guide
            </NavLink>
            <button
              type="button"
              onClick={handleLogout}
              className="ml-2 px-3 py-1.5 rounded-md text-sm font-medium text-ink-dim hover:bg-surface-2 whitespace-nowrap"
            >
              Log out
            </button>
          </nav>

          {/* Mobile menu trigger (2026-09-15, "is the app mobile
              friendly" follow-up) — below md the horizontal nav above is
              hidden entirely rather than left as an overflow-x-auto
              scroll strip; a phone user shouldn't have to swipe sideways
              to find "Log out". */}
          <button
            type="button"
            className="md:hidden -mr-2 p-2 rounded-md text-ink-dim hover:bg-surface-2"
            onClick={() => setMobileOpen((v) => !v)}
            aria-expanded={mobileOpen}
            aria-controls="mobile-nav-panel"
            aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
          >
            {mobileOpen ? (
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M4 4L16 16M16 4L4 16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M3 5.5H17M3 10H17M3 14.5H17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            )}
          </button>
        </div>

        {mobileOpen && (
          <nav id="mobile-nav-panel" className="md:hidden border-t border-line bg-surface px-2 py-2">
            <MobileNavSection title={null} items={[{ to: '/board', label: 'Board' }]} onNavigate={() => setMobileOpen(false)} />
            <MobileNavSection title="Research" items={RESEARCH_ITEMS} onNavigate={() => setMobileOpen(false)} />
            <MobileNavSection title="Agents" items={AGENTS_ITEMS} onNavigate={() => setMobileOpen(false)} />
            <MobileNavSection title="Record" items={RECORD_ITEMS} onNavigate={() => setMobileOpen(false)} />
            <MobileNavSection title={null} items={[{ to: '/guide', label: 'Guide' }]} onNavigate={() => setMobileOpen(false)} />
            <div className="pt-2 mt-2 border-t border-line">
              <button
                type="button"
                onClick={handleLogout}
                className="w-full text-left px-3 py-2 rounded-md text-sm font-medium text-ink-dim hover:bg-surface-2"
              >
                Log out
              </button>
            </div>
          </nav>
        )}
      </header>

      <main className="flex-1 max-w-5xl w-full mx-auto px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
