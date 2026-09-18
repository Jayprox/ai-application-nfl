import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApiFetch } from '../hooks/useApiFetch';
import { useCurrentWeek } from '../hooks/useCurrentWeek';
import AsyncState from '../components/AsyncState';

/**
 * Props — player prop board (2026-09-17, "let's explore adding Game and
 * Player props" request, inspired by a Chalk That MLB screenshot of its
 * own props Board). Player props only for this first version (game
 * props — team totals, alt lines — are a planned follow-up using the
 * existing game_odds pattern directly, once this is live); see
 * docs/part2-roadmap.md.
 *
 * Composes three reads, same "one fetch gates the page, the rest render
 * their own state" split GamesPage.jsx/BoardPage.jsx already use:
 *   - GET /games/current-week    — resolves season/week (useCurrentWeek)
 *   - GET /games?season=&week=   — this week's schedule, purely for the
 *     away/home matchup header each game's props group under (the props
 *     response itself only carries game_id)
 *   - GET /props/players?season=&week=  — the actual prop lines +
 *     deterministic lean (backend/routes/props.js)
 *
 * Deliberately NOT the SIM %/confidence-score treatment Chalk That
 * MLB's Board shows — that's a genuine predictive model, backlogged for
 * later (see /props/players's own header comment). What this page shows
 * instead: the real market line, the player's actual last-5-game
 * average against it, and a plain rule-based lean (over/under/toss-up),
 * same spirit as this app's existing Edge/Insights features.
 *
 * Market tabs mirror the MLB screenshot's HR/Hits/K/Outs/Games row, just
 * over this app's own 5 launch markets (backend/routes/props.js's
 * MARKET_STAT_COLUMN + player_anytime_td) rather than baseball's.
 *
 * Final-game grading (2026-09-18, "show if the props hit" request) —
 * same pattern components/OddsBadge.jsx already established for
 * game-level odds: once a card's game is final, its corner badge swaps
 * from the pregame LeanBadge to a FinalResultBadge describing what
 * actually happened against the locked line (backend/routes/props.js's
 * new final_value), styled with the same text-positive/bg-positive
 * "hit" token OddsBadge/EdgeBadge already use elsewhere in this app —
 * not a grade of whether our own pregame lean called it right, just
 * "what hit," same framing OddsBadge uses for spread/total/moneyline.
 */

const CURRENT_SEASON = 2026;

const MARKET_TABS = [
  { key: 'player_pass_yds', label: 'Pass Yds' },
  { key: 'player_rush_yds', label: 'Rush Yds' },
  { key: 'player_reception_yds', label: 'Rec Yds' },
  { key: 'player_receptions', label: 'Receptions' },
  { key: 'player_anytime_td', label: 'Anytime TD' },
];

const LEAN_BADGE = {
  over: { label: 'OVER', className: 'text-positive bg-positive/12' },
  under: { label: 'UNDER', className: 'text-negative bg-negative/12' },
  toss_up: { label: 'TOSS-UP', className: 'text-caution bg-caution/12' },
  null: { label: 'NO READ', className: 'text-ink-dim bg-surface-2' },
};

function LeanBadge({ lean }) {
  const badge = LEAN_BADGE[lean ?? 'null'];
  return (
    <span className={`whitespace-nowrap rounded px-2 py-1 text-xs font-semibold ${badge.className}`}>
      {badge.label}
    </span>
  );
}

// Grades a final game's prop the same way OddsBadge.jsx's gradeSpread/
// gradeTotal/gradeMoneyline grade game odds: describe the outcome that
// actually happened against the locked line, not whether a prediction
// was right. hit: true is the normal "this is what happened" case
// (rendered in the positive token below); hit: null is only for an
// exact push, same neutral treatment OddsBadge gives a push/tie. Returns
// null when the game isn't final yet, or final_value came back null
// (DNP/no data — see backend/routes/props.js's own comment on that).
function gradeProp(prop) {
  if (prop.game_status !== 'final' || prop.final_value == null) return null;

  if (prop.market === 'player_anytime_td') {
    const scored = prop.final_value > 0;
    return { label: scored ? 'Scored a TD' : 'No TD', hit: true };
  }

  if (prop.line == null) return null;
  const line = Number(prop.line);
  const actual = prop.final_value;
  if (actual === line) return { label: `${prop.line} (Push)`, hit: null };
  return {
    label: actual > line ? `O ${prop.line} (${actual})` : `U ${prop.line} (${actual})`,
    hit: true,
  };
}

function FinalResultBadge({ grade }) {
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded px-2 py-1 text-xs font-semibold tabular-nums ${
        grade.hit ? 'text-positive bg-positive/12' : 'text-ink-dim bg-surface-2'
      }`}
    >
      {grade.hit ? '✓ ' : ''}
      {grade.label}
    </span>
  );
}

// backend/routes/props.js now filters to DraftKings only (2026-09-18,
// "switch it to the default, DraftKings" request) -- every card's
// bookmaker is the same book, so this just displays the vendor's raw
// 'draftkings' key in title case rather than adding a whole label map
// for one entry.
function formatBookmaker(bookmaker) {
  if (bookmaker === 'draftkings') return 'DraftKings';
  return bookmaker;
}

function formatPrice(price) {
  if (price === null || price === undefined) return '—';
  const num = Number(price);
  return num > 0 ? `+${num}` : `${num}`;
}

function formatSyncedAt(iso) {
  if (!iso) return 'not yet synced';
  const diffMinutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (diffMinutes < 1) return 'synced just now';
  if (diffMinutes < 60) return `synced ${diffMinutes}m ago`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `synced ${diffHours}h ago`;
  return `synced ${Math.round(diffHours / 24)}d ago`;
}

function formatKickoff(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

// Ranks a market's cards within one game: a real over/under lean before
// a toss-up before a no-read (missing recent-form sample), and within
// the real leans, the strongest edge_pct first — same "most convicted
// pick first" spirit as Chalk That MLB's own board, built from a plain
// descriptive ratio rather than a confidence score (see props.js's own
// header comment on edge_pct).
function leanSortKey(prop) {
  const tier = prop.lean === 'over' || prop.lean === 'under' ? 0 : prop.lean === 'toss_up' ? 1 : 2;
  return [tier, -(prop.edge_pct ?? 0)];
}

function PropCard({ prop }) {
  const isAnytimeTd = prop.market === 'player_anytime_td';
  const grade = gradeProp(prop);
  return (
    <div className="rounded-md border border-line bg-surface px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to={`/players/${prop.player.player_id}?scope=last5`}
              className="font-medium text-ink hover:underline"
            >
              {prop.player.full_name}
            </Link>
            <span className="text-xs text-ink-faint">{prop.player.position}</span>
          </div>

          <p className="mt-1 text-sm text-ink-dim tabular-nums">
            {isAnytimeTd ? (
              <>Yes {formatPrice(prop.over_price)} &middot; No {formatPrice(prop.under_price)}</>
            ) : (
              <>
                {prop.line} {prop.market_label} &middot; O {formatPrice(prop.over_price)} / U{' '}
                {formatPrice(prop.under_price)}
              </>
            )}
          </p>

          {!isAnytimeTd && prop.context.recent_avg != null && (
            <p className="mt-0.5 text-xs text-ink-faint tabular-nums">
              L5 avg {prop.context.recent_avg.toFixed(1)} ({prop.context.games_played} gm)
            </p>
          )}
          {isAnytimeTd && prop.context.td_rate != null && (
            <p className="mt-0.5 text-xs text-ink-faint tabular-nums">
              TD in {Math.round(prop.context.td_rate * 100)}% of last {prop.context.games_played} games
            </p>
          )}

          {prop.reasoning && <p className="mt-1 text-xs italic text-ink-faint">{prop.reasoning}</p>}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1">
          {grade ? <FinalResultBadge grade={grade} /> : <LeanBadge lean={prop.lean} />}
          <span className="text-xs text-ink-faint">{formatBookmaker(prop.bookmaker)}</span>
        </div>
      </div>
    </div>
  );
}

export default function PropsPage() {
  const [season, setSeason] = useState(CURRENT_SEASON);
  const [week, setWeek] = useState(null);
  const [activeMarket, setActiveMarket] = useState('player_pass_yds');

  useCurrentWeek((current) => {
    setSeason(current.season);
    setWeek(current.week);
  });

  const propsPath = useMemo(() => {
    if (!week) return null;
    return `/props/players?${new URLSearchParams({ season: String(season), week: String(week) }).toString()}`;
  }, [season, week]);

  const gamesPath = useMemo(() => {
    if (!week) return null;
    return `/games?${new URLSearchParams({ season: String(season), week: String(week) }).toString()}`;
  }, [season, week]);

  const { data, error, loading, refetch } = useApiFetch(propsPath);
  const { data: gamesData } = useApiFetch(gamesPath);

  const gameById = useMemo(() => {
    const map = new Map();
    for (const g of gamesData?.data ?? []) map.set(g.game_id, g);
    return map;
  }, [gamesData]);

  const allProps = data?.data ?? [];
  const marketProps = useMemo(
    () => allProps.filter((p) => p.market === activeMarket),
    [allProps, activeMarket]
  );

  const gamesWithProps = useMemo(() => {
    const byGame = new Map();
    for (const p of marketProps) {
      if (!byGame.has(p.game_id)) byGame.set(p.game_id, []);
      byGame.get(p.game_id).push(p);
    }
    for (const rows of byGame.values()) {
      rows.sort((a, b) => {
        const [tierA, edgeA] = leanSortKey(a);
        const [tierB, edgeB] = leanSortKey(b);
        return tierA !== tierB ? tierA - tierB : edgeA - edgeB;
      });
    }
    return [...byGame.entries()]
      .map(([gameId, rows]) => ({ game: gameById.get(gameId), gameId, rows }))
      .sort((a, b) => new Date(a.game?.game_datetime ?? 0) - new Date(b.game?.game_datetime ?? 0));
  }, [marketProps, gameById]);

  return (
    <div>
      <h1 className="font-display text-2xl font-semibold uppercase tracking-wide text-ink mb-1">Props</h1>
      <p className="text-sm text-ink-dim mb-4">
        This week's player prop lines with a real recent-form read — the player's actual last 5 games against the
        market's own line, not a simulation or a confidence score. Pick a market below; each card is ranked by how
        far recent form clears the line, strongest reads first.
      </p>

      <div className="mb-4 flex flex-wrap gap-2">
        {MARKET_TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveMarket(tab.key)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              activeMarket === tab.key ? 'bg-accent text-on-accent' : 'bg-surface text-ink-dim hover:bg-surface-2'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {loading || error ? (
        <AsyncState loading={loading} error={error} loadingLabel="Loading props…" onRetry={refetch} />
      ) : gamesWithProps.length === 0 ? (
        <p className="text-sm text-ink-dim">
          No {MARKET_TABS.find((t) => t.key === activeMarket)?.label.toLowerCase()} props synced yet this week.
        </p>
      ) : (
        <div className="space-y-6">
          {gamesWithProps.map(({ game, gameId, rows }) => (
            <div key={gameId}>
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-ink">
                  {game ? (
                    <Link to={`/games/${gameId}`} className="hover:underline">
                      {game.away_team_abbr} @ {game.home_team_abbr}
                    </Link>
                  ) : (
                    gameId
                  )}
                </h2>
                {game?.game_datetime && (
                  <span className="text-xs text-ink-faint">{formatKickoff(game.game_datetime)}</span>
                )}
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {rows.map((prop) => (
                  <PropCard key={`${prop.player.player_id}-${prop.bookmaker}`} prop={prop} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {data?.meta && (
        <p className="mt-4 text-xs text-ink-faint">
          {data.meta.sample_size} prop{data.meta.sample_size === 1 ? '' : 's'} across all markets &middot;{' '}
          {formatSyncedAt(data.meta.freshness?.synced_at)}
        </p>
      )}
    </div>
  );
}
