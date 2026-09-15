-- =========================================================================
-- Migration: weather wind direction
-- =========================================================================
-- Run this once against the live Railway Postgres (same Data/Query tool
-- used for schema.sql and 002-010).
--
-- Board page weather request (2026-09-15): games.weather_wind_mph already
-- stored speed, but never direction, so a game card could show "6 mph"
-- but never "Winds SW 5mph" as the user asked for. Stored as the raw
-- compass bearing in degrees (0-360, meteorological convention -- the
-- direction the wind is blowing FROM, matching Open-Meteo's own
-- wind_direction_10m/winddirection_10m fields in both its forecast and
-- historical-archive APIs) rather than pre-formatted text like 'SW', so
-- the frontend can round/format it however it likes and a future unit
-- change doesn't require a backfill. Nullable for the same reason
-- weather_condition/weather_temp_f/weather_wind_mph already are: unknown
-- until worker/ingestion-worker.js's sync_forecast_weather (upcoming
-- games) or sync_historical_weather (already-final games, new in this
-- same change) actually populates it.
-- =========================================================================

ALTER TABLE games
    ADD COLUMN weather_wind_direction_deg SMALLINT;
