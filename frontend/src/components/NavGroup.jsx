import { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

// Part 2 Phase 3 nav/IA cleanup (2026-09-15, docs/part2-roadmap.md): the
// header used to be 10 flat top-level NavLinks in one row with no
// wrap/overflow handling — crowded even at desktop widths, and would
// clip or overflow at anything narrower. Grouped the 9 non-Board routes
// into 3 clusters (Research / Agents / Record) behind this dropdown,
// leaving Board standalone since it's the app's own front door
// (BoardPage.jsx's header comment). A group's trigger gets the same
// active-pill styling as a plain NavLink whenever the current route
// matches one of its own items, so it stays visually "lit up" even
// while its dropdown is closed — the user shouldn't lose their place in
// the nav just because a route got nested one level deeper.
export default function NavGroup({ label, items }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const location = useLocation();
  const isActive = items.some((item) => location.pathname.startsWith(item.to));

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="true"
        className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-1 ${
          isActive ? 'bg-accent text-on-accent' : 'text-ink-dim hover:bg-surface-2'
        }`}
      >
        {label}
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          className={`transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        >
          <path
            d="M2 3.5L5 6.5L8 3.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 mt-1 w-40 rounded-md border border-line bg-surface shadow-lg py-1 z-20">
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={() => setOpen(false)}
              className={({ isActive: itemActive }) =>
                `block px-3 py-1.5 text-sm whitespace-nowrap ${
                  itemActive ? 'text-accent font-medium' : 'text-ink-dim hover:bg-surface-2 hover:text-ink'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}
