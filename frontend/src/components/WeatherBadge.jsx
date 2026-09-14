/**
 * Compact weather badge for a game card — temperature, or "Dome" for a
 * game played under a closed/indoor roof, where weather_temp_f is
 * legitimately null rather than missing data (db/schema.sql's
 * weather_condition_enum). Renders nothing until forecast data has
 * actually synced (weather_condition still null this far out — see
 * worker/ingestion-worker.js's sync_forecast_weather proximity schedule)
 * — same graceful-empty convention as InjuryBadge.jsx.
 */

export default function WeatherBadge({ condition, tempF }) {
  if (!condition) return null;
  const label = condition === 'dome' ? 'Dome' : tempF != null ? `${Math.round(Number(tempF))}°F` : null;
  if (!label) return null;
  return (
    <span className="whitespace-nowrap rounded px-2 py-1 text-xs font-medium text-ink-dim bg-surface-2">
      {label}
    </span>
  );
}
