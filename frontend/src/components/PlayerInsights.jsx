import { useApiFetch } from '../hooks/useApiFetch';

/**
 * Player insights — surfaces backend/lib/insights.js's four deterministic
 * labels (matchup, recent_form, situational, role_trend) on the player
 * detail screen. The route (GET /insights/players/:id) has existed since
 * Part 2 Phase 1; this is the first frontend surface for it — previously
 * only reachable via a raw API call.
 *
 * Deliberately decoupled from PlayerDetailPage's own season/scope
 * selectors: insights.js computes everything relative to this player's
 * *next scheduled game*, not an arbitrary historical season someone's
 * browsing stats for, so wiring it to the stats-browsing `season` state
 * would make it look like insights change when someone's just checking a
 * player's 2022 numbers. CURRENT_SEASON should track whichever season is
 * the live one (matches AVAILABLE_SEASONS[0] in PlayerDetailPage.jsx /
 * worker/ingestion-worker.js's currentNflSeason()) — update both places
 * together when a new season starts.
 *
 * Self-contained: does its own fetch, renders nothing while loading and
 * nothing on error (same "don't disrupt the primary page for a
 * supplementary section" reasoning as InjuryBadge — a stats page is still
 * useful with no insights shown, so a failure here shouldn't block it).
 * Also renders nothing when every category comes back label: null (no
 * scheduled next game, insufficient sample, special-teams position) —
 * same "don't fake a reading" convention insights.js itself follows.
 */

const CURRENT_SEASON = 2026;

const CATEGORY_LABEL = {
  matchup: 'Matchup',
  recent_form: 'Recent Form',
  situational: 'Situational',
  role_trend: 'Role Trend',
};

// Only the known positive/negative labels need calling out in color —
// everything else (a neutral bucket like NEUTRAL_MATCHUP/STEADY, or any
// label not in this list) falls through to the neutral style below. This
// avoids hardcoding every neutral enum value insights.js might use.
const POSITIVE_LABELS = new Set(['FAVORABLE_MATCHUP', 'HOT', 'STRONG', 'INCREASING']);
const NEGATIVE_LABELS = new Set(['TOUGH_MATCHUP', 'COLD', 'WEAK', 'DECREASING']);

function badgeStyle(label) {
  if (POSITIVE_LABELS.has(label)) return 'text-emerald-700 bg-emerald-50';
  if (NEGATIVE_LABELS.has(label)) return 'text-red-700 bg-red-50';
  return 'text-slate-600 bg-slate-100';
}

function formatLabel(label) {
  return label.replaceAll('_', ' ');
}

export default function PlayerInsights({ playerId }) {
  const { data, loading, error } = useApiFetch(`/insights/players/${playerId}?season=${CURRENT_SEASON}`);

  if (loading || error) return null;

  const insights = data?.data?.insights ?? [];
  const withSignal = insights.filter((entry) => entry.label !== null && entry.label !== undefined);
  if (withSignal.length === 0) return null;

  return (
    <div className="mb-6 grid gap-2 sm:grid-cols-2">
      {withSignal.map((entry) => (
        <div key={entry.category} className="rounded-md border border-slate-200 bg-white px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              {CATEGORY_LABEL[entry.category] ?? entry.category}
            </span>
            <span className={`whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium ${badgeStyle(entry.label)}`}>
              {formatLabel(entry.label)}
            </span>
          </div>
          {entry.note && <p className="mt-1 text-xs text-slate-500">{entry.note}</p>}
        </div>
      ))}
    </div>
  );
}
