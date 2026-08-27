// Mirrors backend/routes/query.js's VALID_GAME_SLOTS/VALID_WEATHER
// exactly, so a value the UI can select is always one the query engine
// accepts.
//
// Note: weather_condition is currently only ever populated as 'dome' or
// left null by the historical backfill — games.csv doesn't carry a real
// precipitation field, only roof + numeric temp/wind (see
// scripts/backfill-historical.js's file header). Selecting sunny/
// overcast/rain/snow will correctly return a graceful zero-sample-size
// result until a future ingestion pass adds a real weather source
// (Open-Meteo, per docs/architecture.md §3) — not a bug, just backlogged.

export const GAME_SLOT_OPTIONS = [
  { value: 'sunday_early', label: 'Sunday Early' },
  { value: 'sunday_late', label: 'Sunday Late' },
  { value: 'sunday_night', label: 'Sunday Night' },
  { value: 'monday_night', label: 'Monday Night' },
  { value: 'thursday_night', label: 'Thursday Night' },
  { value: 'thanksgiving', label: 'Thanksgiving' },
  { value: 'saturday', label: 'Saturday' },
  { value: 'other', label: 'Other' },
];

export const WEATHER_OPTIONS = [
  { value: 'sunny', label: 'Sunny' },
  { value: 'overcast', label: 'Overcast' },
  { value: 'rain', label: 'Rain' },
  { value: 'snow', label: 'Snow' },
  { value: 'dome', label: 'Dome' },
];
