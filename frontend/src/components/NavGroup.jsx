import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
//
// Panel positioning fix (2026-09-15, second pass): the panel below was
// originally `position: absolute` inside this component's own `relative`
// wrapper, which itself lives inside Layout.jsx's <nav className="...
// overflow-x-auto">. Per the CSS overflow spec, setting `overflow-x` to
// anything but `visible` forces `overflow-y` to *compute* to `auto` too
// (never mind that only x was declared) — so that <nav> silently became
// a clip/scroll container on BOTH axes. The dropdown panel always
// extends below the nav's own box (which is only as tall as its
// buttons), so it was being clipped to invisible the instant it opened —
// confirmed via a live DOM check: the panel's `hidden` state toggled
// correctly, but its rendered rect fell entirely outside the nav's own
// clipped bounds. `position: fixed` (computed from the trigger button's
// own getBoundingClientRect(), which already accounts for the nav's
// current horizontal scroll offset) escapes that clipping altogether —
// its containing block is the viewport, since nothing here sets a
// transform/filter. Recomputes on open; closes on resize/scroll rather
// than re-tracking position through those, same "just close it" spirit
// as the existing outside-click/Escape handling below.
export default function NavGroup({ label, items }) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState(null);
  const wrapRef = useRef(null);
  const triggerRef = useRef(null);
  const location = useLocation();
  const isActive = items.some((item) => location.pathname.startsWith(item.to));

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setCoords({ top: rect.bottom + 4, left: rect.left });
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const handleReflow = () => setOpen(false);
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleReflow);
    window.addEventListener('scroll', handleReflow, true);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleReflow);
      window.removeEventListener('scroll', handleReflow, true);
    };
  }, [open]);

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        ref={triggerRef}
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

      {open && coords && (
        <div
          className="fixed w-40 rounded-md border border-line bg-surface shadow-lg py-1 z-20"
          style={{ top: coords.top, left: coords.left }}
        >
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
