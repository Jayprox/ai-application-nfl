/**
 * Weather badge for a game card. 'Dome' for a game played under a
 * closed/indoor roof, where wind/temp are legitimately null rather than
 * missing data (db/schema.sql's weather_condition_enum) -- otherwise a
 * condition + wind (speed and compass direction) + temperature line,
 * e.g. "Overcast · Winds SW 5 mph · 85°F". Renders nothing until real
 * weather has actually synced for this game: worker/ingestion-worker.js's
 * sync_forecast_weather handles upcoming games (within its 10-day
 * lookahead) and sync_historical_weather (added 2026-09-15, same change
 * as this badge) backfills already-final ones from Open-Meteo's
 * historical archive -- see that job's own header comment for why a
 * very recently finished game can still show nothing for a few days.
 * Same graceful-empty convention as InjuryBadge.jsx.
 */

const CONDITION_LABEL = {
  sunny: 'Sunny',
  overcast: 'Overcast',
  rain: 'Rain',
  snow: 'Snow',
};

// 8-point compass, meteorological convention (degrees = direction the
// wind is blowing FROM) -- matches Open-Meteo's wind_direction_10m /
// winddirection_10m fields directly, no conversion needed beyond this
// bucketing.
const COMPASS_POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

function compassFor(deg) {
  if (deg == null || Number.isNaN(Number(deg))) return null;
  const normalized = ((Number(deg) % 360) + 360) % 360;
  return COMPASS_POINTS[Math.round(normalized / 45) % 8];
}

export default function WeatherBadge({ condition, tempF, windMph, windDirectionDeg }) {
  if (!condition) return null;

  if (condition === 'dome') {
    return (
      <span className="whitespace-nowrap rounded px-2 py-1 text-xs font-medium text-ink-dim bg-surface-2">
        Dome
      </span>
    );
  }

  const parts = [];
  const conditionLabel = CONDITION_LABEL[condition];
  if (conditionLabel) parts.push(conditionLabel);

  if (windMph != null) {
    const compass = compassFor(windDirectionDeg);
    const speed = `${Math.round(Number(windMph))} mph`;
    parts.push(`Winds ${compass ? `${compass} ` : ''}${speed}`);
  }

  if (tempF != null) parts.push(`${Math.round(Number(tempF))}°F`);

  if (parts.length === 0) return null;

  return (
    <span className="whitespace-nowrap rounded px-2 py-1 text-xs font-medium text-ink-dim bg-surface-2">
      {parts.join(' · ')}
    </span>
  );
}
