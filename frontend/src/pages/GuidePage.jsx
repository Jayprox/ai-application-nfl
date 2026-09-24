import { NavLink } from 'react-router-dom';

/**
 * Guide page — a permanent, always-accessible reference explaining what
 * every part of the app does and how the pieces fit together. Added
 * 2026-09-24 on request ("a guide for the app so users have a better
 * understanding"), as a real nav item (see Layout.jsx), not a modal or
 * a one-time onboarding tour — the same page a returning user can pull
 * back up any time they forget what "Edge" means or why Props has no
 * confidence score.
 *
 * Static content only, no API calls — this describes the app's
 * structure and reasoning, which doesn't change page to page. Content
 * is written from what each route/component actually does today (see
 * this file's own section comments for the source), not aspirational —
 * keep it in sync with real behavior as pages change, same "corrected
 * record, not silently stale" convention docs/part2-roadmap.md follows.
 *
 * Section IDs double as in-page anchors for the jump-nav at the top —
 * add a new <GuideSection id="..."> and a matching jump-nav entry
 * together if a new page/feature is added later.
 */

const SECTIONS = [
  { id: 'philosophy', label: 'How this app thinks' },
  { id: 'board', label: 'Board' },
  { id: 'research', label: 'Games, Teams, Players' },
  { id: 'game-detail', label: 'Inside a game' },
  { id: 'rankings', label: 'Rankings' },
  { id: 'props', label: 'Props' },
  { id: 'edge', label: 'Edge' },
  { id: 'portfolio', label: 'Portfolio' },
  { id: 'record', label: 'Picks & Leaderboard' },
  { id: 'chat', label: 'Chat' },
];

function GuideSection({ id, title, children }) {
  return (
    <section id={id} className="scroll-mt-20 py-6 border-b border-line last:border-0">
      <h2 className="font-display text-lg font-semibold uppercase tracking-wide text-ink mb-2">{title}</h2>
      <div className="space-y-3 text-sm text-ink-dim leading-relaxed max-w-2xl">{children}</div>
    </section>
  );
}

export default function GuidePage() {
  return (
    <div>
      <h1 className="font-display text-2xl font-semibold uppercase tracking-wide text-ink mb-1">Guide</h1>
      <p className="text-sm text-ink-dim mb-4 max-w-2xl">
        What every part of Chalk That NFL does, and how the pieces connect. Come back here any time —
        this page doesn't move.
      </p>

      {/* Jump nav — plain anchor links to each section below, styled as
          small chips so it reads as a table of contents rather than a
          second row of the site's own nav. */}
      <nav aria-label="Guide sections" className="flex flex-wrap gap-2 mb-2 pb-4 border-b border-line">
        {SECTIONS.map((s) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            className="rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink-dim hover:bg-surface-2 hover:text-ink transition-colors"
          >
            {s.label}
          </a>
        ))}
      </nav>

      <GuideSection id="philosophy" title="How this app thinks">
        <p>
          Everything you see here is a real, recorded number — a stat line from a game that already
          happened, a line an actual sportsbook is offering right now, a rate computed from real recent
          games. Nothing in this app is a made-up prediction, a win probability, or a confidence score.
        </p>
        <p>
          Where you'll see a "lean" (Over/Under/Toss-up on <NavLink to="/props" className="text-link hover:underline">Props</NavLink>,
          a Signal on <NavLink to="/rankings" className="text-link hover:underline">Rankings</NavLink>, a disagreement
          on <NavLink to="/edge" className="text-link hover:underline">Edge</NavLink>), it's always a plain
          rule applied to real data — "the recent average sits this far from the market's line," "the model's
          own read disagrees with who the market favors" — never a simulation or an invented probability.
          If you're ever unsure whether a number is real or estimated, it's real; this app doesn't estimate.
        </p>
      </GuideSection>

      <GuideSection id="board" title="Board">
        <p>
          The home screen — a curated snapshot of the current week rather than a full page of any one
          thing. It pulls together this week's games, the strongest disagreements from Edge, a preview of
          the Rankings leaders, and the Portfolio agent's live track record, so you can see the state of
          things without visiting four separate pages.
        </p>
      </GuideSection>

      <GuideSection id="research" title="Games, Teams, Players">
        <p>
          <strong className="text-ink">Games</strong> lists the schedule for any season and week — pick a
          game to see its own page (below). <strong className="text-ink">Teams</strong> browses every team
          by division; open one to see its full roster grouped by position group.{' '}
          <strong className="text-ink">Players</strong> is search-and-filter across every player — open one
          to see their bio, current injury status (if any), and season stats across four views: Season Avg
          (per-game average), Season Total, Last 5 games, Career, and a full Game Log.
        </p>
      </GuideSection>

      <GuideSection id="game-detail" title="Inside a game">
        <p>
          Opening any game gets you the fullest view in the app: kickoff time and weather, both teams'
          injury reports, the "Model vs. Market" read from Edge for this specific matchup, the full odds
          board (every tracked bookmaker, every market), both rosters' season stats, and — once the game
          has kicked off — a live box score with top performers and a drive-by-drive Drive Feed. Not every
          section has data for every game: the box score and drive feed only populate once a game is
          actually underway or finished.
        </p>
      </GuideSection>

      <GuideSection id="rankings" title="Rankings">
        <p>
          Players ranked within a stat category (e.g. passing yards, receptions) by a deterministic score
          built from real season data — recent form, matchup context, and a few other real signals blended
          together. It's a ranking, not a prediction: the score reflects how a player has actually been
          performing and who they're facing, not a projection of what they'll do next.
        </p>
      </GuideSection>

      <GuideSection id="props" title="Props">
        <p>
          This week's player prop lines from DraftKings — passing/rushing/receiving yards, receptions, and
          anytime touchdown — each shown next to that player's real recent-form average (or, for
          touchdowns, how often they've scored in their last 5 games). The Over/Under/Toss-up lean just
          says how far that real average sits from the market's own line; it's a descriptive comparison, not
          odds of winning. Once a game finishes, the card also shows what the player actually did that game,
          graded against the locked-in line.
        </p>
      </GuideSection>

      <GuideSection id="edge" title="Edge">
        <p>
          Compares this app's own model read (from Rankings' scoring) against what the betting market
          itself is favoring — the actual spread and moneyline. When the two disagree, that's flagged as an
          edge. When there isn't enough real signal on one or both sides to make a call, that's shown
          plainly rather than forced into a guess.
        </p>
      </GuideSection>

      <GuideSection id="portfolio" title="Portfolio">
        <p>
          The one page in the app that writes something, rather than just showing you data. It builds a
          slate of picks from this week's strongest edges. <strong className="text-ink">Preview slate</strong> shows
          you what it would pick without saving anything; <strong className="text-ink">Build &amp; log slate</strong> commits
          those picks to a real, permanent record — which is exactly what shows up next
          on <NavLink to="/picks" className="text-link hover:underline">Picks</NavLink> and gets graded
          once those games finish.
        </p>
      </GuideSection>

      <GuideSection id="record" title="Picks & Leaderboard">
        <p>
          <strong className="text-ink">Picks</strong> is the Portfolio agent's full history — every pick it's
          ever logged, and how each one graded once its game finished.{' '}
          <strong className="text-ink">Leaderboard</strong> ranks every agent that logs picks by real hit
          rate. Right now that's a leaderboard of one, honestly — more rows show up as more agents start
          picking, rather than being padded out artificially.
        </p>
      </GuideSection>

      <GuideSection id="chat" title="Chat">
        <p>
          Ask a real question in plain English — a player's stat line, a team's recent form — and get an
          answer pulled from the same real data every other page uses. It's a lookup tool with a
          conversational front end, not a source of predictions or advice; if a question needs a projection
          rather than a real number, it isn't something this app is built to answer.
        </p>
      </GuideSection>
    </div>
  );
}
