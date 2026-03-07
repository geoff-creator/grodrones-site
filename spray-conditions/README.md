# Spray Conditions Tool

A real-time spray conditions checker for agricultural operators. Answers: **"Is it safe to spray right now?"**

## How It Works

1. **User selects a location** — click the map, use GPS, or search an address
2. **Frontend calls the backend** — `/.netlify/functions/spray-data?lat=XX&lon=YY`
3. **Backend fetches weather data** from multiple sources (in priority order):
   - **METAR** (aviation weather observations) — primary for wind, temp, dew point. Finds nearest station within 25 miles. Tries up to 3 stations sequentially.
   - **Open-Meteo** (forecast model) — always fetched. Primary for precip chance. Fills gaps for any metric METAR doesn't cover.
   - **NOAA observations** — last resort fallback. Station observation data only (not forecast grids). Used only if key fields are still missing.
4. **Each metric resolves independently** — if METAR provides wind but not temp, wind comes from METAR and temp comes from Open-Meteo. One API failure doesn't break other metrics.
5. **Frontend displays** a green/yellow/red status with detailed conditions.

## Metric Thresholds

| Metric | Green | Yellow | Red |
|--------|-------|--------|-----|
| Wind Speed | 3–8 mph | 0–3 or 8–10 mph | >10 mph |
| Wind Gust | <12 mph | 12–15 mph | >15 mph |
| Temperature | 50–85°F | 32–50 or 85–90°F | <32 or >90°F |
| Relative Humidity | ≥50% | 40–49% | <40% |
| Delta-T | 3.6–14.4°F | 3.0–3.6 or 14.4–18°F | <3.0 or >18°F |
| Precip Chance | <20% | 20–40% | >40% |

Wind direction and dew point are advisory only (no status color).

## Confidence Levels

- **High**: METAR within 15 miles, all key fields present, data fresh
- **Medium**: METAR 15–25 miles, or Open-Meteo primary, or one key field missing
- **Low**: NOAA fallback, multiple key fields missing, or stale data

Key fields: wind speed, temperature, relative humidity, precip chance. Wind gust can be null without lowering confidence.

## File Structure

```
spray-conditions/
  index.html    — Frontend page
  style.css     — Styles
  app.js        — Frontend logic (map, search, rendering)

netlify/functions/
  spray-data.js          — Backend Netlify Function
  data/metar-stations.json — Curated METAR station list
```

## Data Sources

- [METAR via Aviation Weather Center](https://aviationweather.gov/api/data/metar)
- [Open-Meteo API](https://api.open-meteo.com/v1/forecast)
- [NOAA Weather API](https://api.weather.gov) (observation fallback only)
- [Nominatim](https://nominatim.openstreetmap.org) (address search, frontend)
