// ── Spray Conditions Backend — Netlify Function ────────────────
// Source priority: METAR observed → Open-Meteo → NOAA observed fallback
// Each metric resolves independently from its best available source.

const path = require('path');
const fs = require('fs');

// ── Thresholds (easy to edit) ──────────────────────────────────
const THRESHOLDS = {
  wind_speed: {
    green: [3, 8],     // 3–8 mph
    yellow_low: [0, 3], // 0–2 mph (technically <3)
    yellow_high: [8, 10], // 8–10 mph
    red: 10             // above 10 mph
  },
  wind_gust: {
    green: 12,   // under 12 mph
    yellow: 15,  // 12–15 mph
    red: 15      // over 15 mph
  },
  temperature: {
    green: [50, 85],
    yellow_low: [32, 50],
    yellow_high: [85, 90],
    red_low: 32,
    red_high: 90
  },
  relative_humidity: {
    green: 50,   // 50% and above
    yellow: 40,  // 40–49%
    red: 40      // below 40%
  },
  delta_t: {
    red_low: 3.0,
    yellow_low: 3.6,
    green_low: 3.6,
    green_high: 14.4,
    yellow_high: 18.0,
    red_high: 18.0
  },
  precip_chance: {
    green: 20,   // under 20%
    yellow: 40,  // 20–40%
    red: 40      // over 40%
  }
};

// Key fields that affect confidence (gust is NOT a key field)
const KEY_FIELDS = ['wind_speed', 'temperature', 'relative_humidity', 'precip_chance'];

const METAR_MAX_DISTANCE_MILES = 25;
const METAR_HIGH_CONFIDENCE_MILES = 15;
const METAR_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours
const METAR_MAX_CANDIDATES = 3;

// ── Load METAR stations ────────────────────────────────────────
let metarStations = [];
try {
  const stationsPath = path.join(__dirname, 'data', 'metar-stations.json');
  metarStations = JSON.parse(fs.readFileSync(stationsPath, 'utf-8'));
} catch (e) {
  console.error('Failed to load METAR stations:', e.message);
}

// ── Handler ────────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  const { lat, lon } = event.queryStringParameters || {};
  if (!lat || !lon) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'lat and lon query parameters are required' })
    };
  }

  const latitude = parseFloat(lat);
  const longitude = parseFloat(lon);
  if (isNaN(latitude) || isNaN(longitude)) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'lat and lon must be valid numbers' })
    };
  }

  try {
    const result = await buildSprayData(latitude, longitude);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(result)
    };
  } catch (err) {
    console.error('Unexpected error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};

// ── Main data assembly ─────────────────────────────────────────
async function buildSprayData(lat, lon) {
  const sourcesUsed = [];
  let freshestTime = null;

  // Per-metric raw values + source tracking
  const raw = {
    wind_speed: { value: null, source: null },
    wind_direction: { value: null, source: null },
    wind_gust: { value: null, source: null },
    temperature: { value: null, source: null },
    dew_point: { value: null, source: null },
    relative_humidity: { value: null, source: null },
    precip_chance: { value: null, source: null }
  };

  let stationInfo = null;
  let metarDistance = null;
  let metarStale = false;

  // ── Step 1: Try METAR ────────────────────────────────────────
  const nearbyStations = findNearbyStations(lat, lon, METAR_MAX_DISTANCE_MILES);
  const metarResult = await tryMETARStations(nearbyStations.slice(0, METAR_MAX_CANDIDATES));

  if (metarResult) {
    sourcesUsed.push('METAR');
    const { data, station, distance, observationTime, isStale } = metarResult;
    metarDistance = distance;
    metarStale = isStale;

    stationInfo = {
      name: station.name,
      code: station.code,
      distance_miles: round(distance, 1),
      observation_time: observationTime
    };

    if (observationTime) {
      const t = new Date(observationTime);
      if (!isNaN(t.getTime()) && (!freshestTime || t > freshestTime)) {
        freshestTime = t;
      }
    }

    // Fill metrics from METAR
    if (data.windSpeedMph != null) {
      raw.wind_speed = { value: data.windSpeedMph, source: 'METAR' };
    }
    if (data.windDirectionDeg != null) {
      raw.wind_direction = { value: degreesToCardinal(data.windDirectionDeg), source: 'METAR' };
    }
    if (data.windGustMph != null) {
      raw.wind_gust = { value: data.windGustMph, source: 'METAR' };
    }
    if (data.tempF != null) {
      raw.temperature = { value: data.tempF, source: 'METAR' };
    }
    if (data.dewPointF != null) {
      raw.dew_point = { value: data.dewPointF, source: 'METAR' };
    }
    // Calculate RH from METAR temp + dew point
    if (data.tempC != null && data.dewPointC != null) {
      raw.relative_humidity = {
        value: calculateRH(data.tempC, data.dewPointC),
        source: 'calculated from METAR'
      };
    }
  }

  // ── Step 2: Open-Meteo (always, fills gaps) ──────────────────
  try {
    const openMeteo = await fetchOpenMeteo(lat, lon);
    if (openMeteo) {
      sourcesUsed.push('Open-Meteo');

      // Fill any gaps from Open-Meteo
      if (raw.wind_speed.value == null && openMeteo.wind_speed != null) {
        raw.wind_speed = { value: openMeteo.wind_speed, source: 'Open-Meteo' };
      }
      if (raw.wind_direction.value == null && openMeteo.wind_direction != null) {
        raw.wind_direction = { value: degreesToCardinal(openMeteo.wind_direction), source: 'Open-Meteo' };
      }
      if (raw.wind_gust.value == null && openMeteo.wind_gust != null) {
        raw.wind_gust = { value: openMeteo.wind_gust, source: 'Open-Meteo' };
      }
      if (raw.temperature.value == null && openMeteo.temperature != null) {
        raw.temperature = { value: openMeteo.temperature, source: 'Open-Meteo' };
      }
      if (raw.dew_point.value == null && openMeteo.dew_point != null) {
        raw.dew_point = { value: openMeteo.dew_point, source: 'Open-Meteo' };
      }
      if (raw.relative_humidity.value == null && openMeteo.relative_humidity != null) {
        raw.relative_humidity = { value: openMeteo.relative_humidity, source: 'Open-Meteo' };
      }
      // Precip chance always from Open-Meteo (primary source for this)
      if (openMeteo.precip_chance != null) {
        raw.precip_chance = { value: openMeteo.precip_chance, source: 'Open-Meteo' };
      }
    }
  } catch (e) {
    console.error('Open-Meteo failed:', e.message);
  }

  // ── Step 3: NOAA observed fallback (only if key fields still missing) ──
  const missingKeyFields = KEY_FIELDS.filter(f => raw[f].value == null);
  if (missingKeyFields.length > 0) {
    try {
      const noaa = await fetchNOAAObservation(lat, lon);
      if (noaa) {
        sourcesUsed.push('NOAA');

        if (raw.wind_speed.value == null && noaa.windSpeedMph != null) {
          raw.wind_speed = { value: noaa.windSpeedMph, source: 'NOAA' };
        }
        if (raw.wind_direction.value == null && noaa.windDirectionDeg != null) {
          raw.wind_direction = { value: degreesToCardinal(noaa.windDirectionDeg), source: 'NOAA' };
        }
        if (raw.wind_gust.value == null && noaa.windGustMph != null) {
          raw.wind_gust = { value: noaa.windGustMph, source: 'NOAA' };
        }
        if (raw.temperature.value == null && noaa.tempF != null) {
          raw.temperature = { value: noaa.tempF, source: 'NOAA' };
        }
        if (raw.dew_point.value == null && noaa.dewPointF != null) {
          raw.dew_point = { value: noaa.dewPointF, source: 'NOAA' };
        }
        if (raw.relative_humidity.value == null && noaa.relativeHumidity != null) {
          raw.relative_humidity = { value: noaa.relativeHumidity, source: 'NOAA' };
        }
      }
    } catch (e) {
      console.error('NOAA fallback failed:', e.message);
    }
  }

  // ── Calculate derived metrics ────────────────────────────────
  let deltaT = null;
  let deltaTSource = null;
  if (raw.temperature.value != null && raw.relative_humidity.value != null) {
    deltaT = calculateDeltaT(raw.temperature.value, raw.relative_humidity.value);
    deltaTSource = 'calculated';
  }

  // ── Build metrics with statuses ──────────────────────────────
  const metrics = {
    wind_speed: {
      value: raw.wind_speed.value != null ? round(raw.wind_speed.value, 1) : null,
      unit: 'mph',
      status: getWindSpeedStatus(raw.wind_speed.value),
      source: raw.wind_speed.source
    },
    wind_direction: {
      value: raw.wind_direction.value,
      unit: 'cardinal',
      status: null,
      source: raw.wind_direction.source
    },
    wind_gust: {
      value: raw.wind_gust.value != null ? round(raw.wind_gust.value, 1) : null,
      unit: 'mph',
      status: raw.wind_gust.value != null ? getGustStatus(raw.wind_gust.value) : null,
      source: raw.wind_gust.source
    },
    temperature: {
      value: raw.temperature.value != null ? round(raw.temperature.value, 1) : null,
      unit: '°F',
      status: getTempStatus(raw.temperature.value),
      source: raw.temperature.source
    },
    relative_humidity: {
      value: raw.relative_humidity.value != null ? round(raw.relative_humidity.value, 1) : null,
      unit: '%',
      status: getRHStatus(raw.relative_humidity.value),
      source: raw.relative_humidity.source
    },
    dew_point: {
      value: raw.dew_point.value != null ? round(raw.dew_point.value, 1) : null,
      unit: '°F',
      status: null,
      source: raw.dew_point.source
    },
    delta_t: {
      value: deltaT != null ? round(deltaT, 1) : null,
      unit: '°F',
      status: getDeltaTStatus(deltaT),
      source: deltaTSource
    },
    precip_chance: {
      value: raw.precip_chance.value != null ? round(raw.precip_chance.value, 1) : null,
      unit: '%',
      status: getPrecipStatus(raw.precip_chance.value),
      source: raw.precip_chance.source
    }
  };

  // ── Overall status ───────────────────────────────────────────
  const overall = determineOverall(metrics);

  // ── Confidence ───────────────────────────────────────────────
  const trust = determineConfidence({
    sourcesUsed,
    metarDistance,
    metarStale,
    metrics,
    hasNOAA: sourcesUsed.includes('NOAA')
  });

  // ── Reverse geocode for location name (best-effort) ──────────
  let locationName = `${round(lat, 4)}, ${round(lon, 4)}`;
  try {
    const geoResp = await fetchWithTimeout(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=10`,
      { headers: { 'User-Agent': 'GroDrones-SprayTool/1.0 (contact@grodrones.com)' } },
      3000
    );
    if (geoResp.ok) {
      const geoData = await geoResp.json();
      const addr = geoData.address;
      if (addr) {
        const city = addr.city || addr.town || addr.village || addr.hamlet || '';
        const state = addr.state || '';
        if (city && state) {
          locationName = `${city}, ${stateAbbrev(state)}`;
        } else if (city) {
          locationName = city;
        }
      }
    }
  } catch (e) {
    // Non-critical, keep coordinate string
  }

  // ── Freshest time ────────────────────────────────────────────
  const lastUpdated = freshestTime
    ? freshestTime.toISOString()
    : new Date().toISOString();

  return {
    location: {
      lat: round(lat, 4),
      lon: round(lon, 4),
      name: locationName
    },
    overall,
    trust,
    station: stationInfo,
    metrics,
    advisories: {
      inversion: 'Temperature inversion is difficult to confirm remotely. Always verify on site.'
    },
    meta: {
      last_updated: lastUpdated,
      sources_used: sourcesUsed
    }
  };
}

// ── METAR Functions ────────────────────────────────────────────

function findNearbyStations(lat, lon, maxMiles) {
  return metarStations
    .map(s => ({ ...s, distance: haversine(lat, lon, s.lat, s.lon) }))
    .filter(s => s.distance <= maxMiles)
    .sort((a, b) => a.distance - b.distance);
}

async function tryMETARStations(stations) {
  for (const station of stations) {
    try {
      const data = await fetchMETAR(station.code);
      if (!data) continue;

      const observationTime = data.reportTime || data.obsTime || null;
      let isStale = false;

      if (observationTime) {
        const age = Date.now() - new Date(observationTime).getTime();
        if (age > METAR_MAX_AGE_MS) {
          isStale = true;
          continue; // Skip stale, try next station
        }
      }

      // Check if it has at least some useful data
      const hasWind = data.wskts != null || data.wspd != null;
      const hasTemp = data.temp != null;
      if (!hasWind && !hasTemp) continue;

      return {
        data: parseMETARData(data),
        station,
        distance: station.distance,
        observationTime,
        isStale
      };
    } catch (e) {
      console.error(`METAR fetch failed for ${station.code}:`, e.message);
      continue;
    }
  }
  return null;
}

async function fetchMETAR(stationCode) {
  const url = `https://aviationweather.gov/api/data/metar?ids=${stationCode}&format=json`;
  const resp = await fetchWithTimeout(url, {}, 5000);
  if (!resp.ok) return null;

  const data = await resp.json();
  if (!Array.isArray(data) || data.length === 0) return null;
  return data[0];
}

function parseMETARData(metar) {
  // Wind speed: METAR reports in knots, convert to mph (1 knot = 1.15078 mph)
  const knotsToMph = 1.15078;
  const windSpeedKts = metar.wspd ?? metar.wskts ?? null;
  const windGustKts = metar.wgst ?? null;
  const windDir = metar.wdir ?? null;

  // Temperature: METAR reports in Celsius
  const tempC = metar.temp ?? null;
  const dewPointC = metar.dewp ?? null;

  return {
    windSpeedMph: windSpeedKts != null ? windSpeedKts * knotsToMph : null,
    windGustMph: windGustKts != null ? windGustKts * knotsToMph : null,
    windDirectionDeg: windDir,
    tempC,
    tempF: tempC != null ? cToF(tempC) : null,
    dewPointC,
    dewPointF: dewPointC != null ? cToF(dewPointC) : null
  };
}

// ── Open-Meteo ─────────────────────────────────────────────────

async function fetchOpenMeteo(lat, lon) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    hourly: 'temperature_2m,relative_humidity_2m,dew_point_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation_probability',
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    forecast_days: 1,
    timezone: 'auto'
  });

  const url = `https://api.open-meteo.com/v1/forecast?${params}`;
  const resp = await fetchWithTimeout(url, {}, 5000);
  if (!resp.ok) return null;

  const data = await resp.json();
  if (!data.hourly || !data.hourly.time) return null;

  // Find the hourly entry closest to now
  const now = new Date();
  const times = data.hourly.time;
  let bestIdx = 0;
  let bestDiff = Infinity;

  for (let i = 0; i < times.length; i++) {
    const diff = Math.abs(new Date(times[i]).getTime() - now.getTime());
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }

  return {
    wind_speed: data.hourly.wind_speed_10m?.[bestIdx] ?? null,
    wind_direction: data.hourly.wind_direction_10m?.[bestIdx] ?? null,
    wind_gust: data.hourly.wind_gusts_10m?.[bestIdx] ?? null,
    temperature: data.hourly.temperature_2m?.[bestIdx] ?? null,
    dew_point: data.hourly.dew_point_2m?.[bestIdx] ?? null,
    relative_humidity: data.hourly.relative_humidity_2m?.[bestIdx] ?? null,
    precip_chance: data.hourly.precipitation_probability?.[bestIdx] ?? null
  };
}

// ── NOAA Observed Fallback ─────────────────────────────────────

async function fetchNOAAObservation(lat, lon) {
  const noaaHeaders = {
    'User-Agent': 'GroDrones-SprayTool/1.0 (contact@grodrones.com)',
    'Accept': 'application/geo+json'
  };

  // Step 1: Get nearest stations from point
  const pointUrl = `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`;
  const pointResp = await fetchWithTimeout(pointUrl, { headers: noaaHeaders }, 5000);
  if (!pointResp.ok) return null;

  const pointData = await pointResp.json();
  const stationsUrl = pointData?.properties?.observationStations;
  if (!stationsUrl) return null;

  // Step 2: Get station list
  const stationsResp = await fetchWithTimeout(stationsUrl, { headers: noaaHeaders }, 5000);
  if (!stationsResp.ok) return null;

  const stationsData = await stationsResp.json();
  const stations = stationsData?.features;
  if (!stations || stations.length === 0) return null;

  // Step 3: Try nearest stations for fresh observation
  for (const station of stations.slice(0, 3)) {
    const stationId = station?.properties?.stationIdentifier;
    if (!stationId) continue;

    try {
      const obsUrl = `https://api.weather.gov/stations/${stationId}/observations/latest`;
      const obsResp = await fetchWithTimeout(obsUrl, { headers: noaaHeaders }, 4000);
      if (!obsResp.ok) continue;

      const obsData = await obsResp.json();
      const props = obsData?.properties;
      if (!props) continue;

      // Skip stale observations
      if (props.timestamp) {
        const age = Date.now() - new Date(props.timestamp).getTime();
        if (age > METAR_MAX_AGE_MS) continue;
      }

      const msToMph = 2.23694;
      return {
        windSpeedMph: props.windSpeed?.value != null ? props.windSpeed.value * msToMph : null,
        windGustMph: props.windGust?.value != null ? props.windGust.value * msToMph : null,
        windDirectionDeg: props.windDirection?.value ?? null,
        tempF: props.temperature?.value != null ? cToF(props.temperature.value) : null,
        dewPointF: props.dewpoint?.value != null ? cToF(props.dewpoint.value) : null,
        relativeHumidity: props.relativeHumidity?.value ?? null
      };
    } catch (e) {
      continue;
    }
  }
  return null;
}

// ── Metric Status Functions ────────────────────────────────────

function getWindSpeedStatus(mph) {
  if (mph == null) return null;
  if (mph > THRESHOLDS.wind_speed.red) return 'red';
  if (mph >= THRESHOLDS.wind_speed.green[0] && mph <= THRESHOLDS.wind_speed.green[1]) return 'green';
  return 'yellow'; // 0–3 or 8–10
}

function getGustStatus(mph) {
  if (mph == null) return null;
  if (mph > THRESHOLDS.wind_gust.red) return 'red';
  if (mph >= THRESHOLDS.wind_gust.yellow && mph <= THRESHOLDS.wind_gust.red) return 'yellow';
  return 'green';
}

function getTempStatus(f) {
  if (f == null) return null;
  if (f < THRESHOLDS.temperature.red_low || f > THRESHOLDS.temperature.red_high) return 'red';
  if (f >= THRESHOLDS.temperature.green[0] && f <= THRESHOLDS.temperature.green[1]) return 'green';
  return 'yellow';
}

function getRHStatus(rh) {
  if (rh == null) return null;
  if (rh < THRESHOLDS.relative_humidity.red) return 'red';
  if (rh >= THRESHOLDS.relative_humidity.green) return 'green';
  return 'yellow'; // 40–49
}

function getDeltaTStatus(dt) {
  if (dt == null) return null;
  if (dt < THRESHOLDS.delta_t.red_low || dt > THRESHOLDS.delta_t.red_high) return 'red';
  if (dt >= THRESHOLDS.delta_t.green_low && dt <= THRESHOLDS.delta_t.green_high) return 'green';
  return 'yellow';
}

function getPrecipStatus(pct) {
  if (pct == null) return null;
  if (pct > THRESHOLDS.precip_chance.red) return 'red';
  if (pct < THRESHOLDS.precip_chance.green) return 'green';
  return 'yellow'; // 20–40
}

// ── Overall Status ─────────────────────────────────────────────

function determineOverall(metrics) {
  // Hard metrics that affect overall status (not advisories)
  const hardMetrics = [
    { key: 'wind_speed', label: 'Wind speed' },
    { key: 'wind_gust', label: 'Wind gust' },
    { key: 'temperature', label: 'Temperature' },
    { key: 'relative_humidity', label: 'Relative humidity' },
    { key: 'delta_t', label: 'Delta-T' },
    { key: 'precip_chance', label: 'Precipitation chance' }
  ];

  let hasRed = false;
  let hasYellow = false;
  let criticalReason = '';
  let yellowReason = '';

  for (const { key, label } of hardMetrics) {
    const m = metrics[key];
    if (!m || m.status == null) continue;

    if (m.status === 'red') {
      hasRed = true;
      if (!criticalReason) {
        criticalReason = buildReason(key, label, m.value);
      }
    } else if (m.status === 'yellow') {
      hasYellow = true;
      if (!yellowReason) {
        yellowReason = buildReason(key, label, m.value);
      }
    }
  }

  if (hasRed) {
    return { status: 'red', reason: criticalReason };
  }
  if (hasYellow) {
    return { status: 'yellow', reason: yellowReason };
  }
  return { status: 'green', reason: 'All conditions favorable' };
}

function buildReason(key, label, value) {
  switch (key) {
    case 'wind_speed':
      if (value > THRESHOLDS.wind_speed.red) return `Wind speed above ${THRESHOLDS.wind_speed.red} mph`;
      if (value < THRESHOLDS.wind_speed.green[0]) return 'Wind speed too low — possible inversion risk';
      return `Wind speed ${round(value, 1)} mph — marginal`;
    case 'wind_gust':
      if (value > THRESHOLDS.wind_gust.red) return `Wind gusts above ${THRESHOLDS.wind_gust.red} mph`;
      return `Wind gusts ${round(value, 1)} mph — elevated`;
    case 'temperature':
      if (value < THRESHOLDS.temperature.red_low) return 'Temperature below freezing';
      if (value > THRESHOLDS.temperature.red_high) return `Temperature above ${THRESHOLDS.temperature.red_high}°F`;
      return `Temperature ${round(value, 1)}°F — marginal`;
    case 'relative_humidity':
      if (value < THRESHOLDS.relative_humidity.red) return 'Relative humidity too low — drift risk';
      return `Relative humidity ${round(value, 0)}% — marginal`;
    case 'delta_t':
      if (value < THRESHOLDS.delta_t.red_low) return 'Delta-T too low — inversion risk';
      if (value > THRESHOLDS.delta_t.red_high) return 'Delta-T too high — evaporation risk';
      return `Delta-T ${round(value, 1)}°F — marginal`;
    case 'precip_chance':
      if (value > THRESHOLDS.precip_chance.red) return `Precipitation chance ${round(value, 0)}%`;
      return `Precipitation chance ${round(value, 0)}% — elevated`;
    default:
      return `${label} outside ideal range`;
  }
}

// ── Confidence ─────────────────────────────────────────────────

function determineConfidence({ sourcesUsed, metarDistance, metarStale, metrics, hasNOAA }) {
  const missingKeyFields = KEY_FIELDS.filter(f => metrics[f]?.value == null);
  const hasMETAR = sourcesUsed.includes('METAR');

  // High: METAR within 15 miles, key fields present, data fresh
  if (hasMETAR && metarDistance != null && metarDistance <= METAR_HIGH_CONFIDENCE_MILES
      && !metarStale && missingKeyFields.length === 0) {
    return {
      confidence: 'high',
      summary: `METAR observed data from nearby station (${round(metarDistance, 1)} mi)`
    };
  }

  // Low: NOAA fallback in use, OR multiple key fields missing, OR data stale
  if (hasNOAA || missingKeyFields.length >= 2 || metarStale) {
    let summary = 'Limited data availability';
    if (hasNOAA) summary = 'Using NOAA observation fallback';
    else if (missingKeyFields.length >= 2) summary = `Missing ${missingKeyFields.length} key metrics`;
    else if (metarStale) summary = 'METAR observation data is stale';
    return { confidence: 'low', summary };
  }

  // Medium: everything else (METAR 15-25mi, Open-Meteo primary, one field missing)
  let summary = 'Forecast model data';
  if (hasMETAR && metarDistance != null) {
    summary = `METAR data from ${round(metarDistance, 1)} mi away`;
  } else if (sourcesUsed.includes('Open-Meteo')) {
    summary = 'Open-Meteo forecast model data';
  }
  if (missingKeyFields.length === 1) {
    summary += ` (${missingKeyFields[0]} unavailable)`;
  }
  return { confidence: 'medium', summary };
}

// ── Calculation Utilities ──────────────────────────────────────

function calculateRH(tempC, dewPointC) {
  // Magnus formula
  const rh = 100 * Math.exp((17.625 * dewPointC) / (243.04 + dewPointC))
                  / Math.exp((17.625 * tempC) / (243.04 + tempC));
  return Math.max(0, Math.min(100, rh));
}

function calculateDeltaT(tempF, rh) {
  // Convert to Celsius for Stull approximation
  const tempC = (tempF - 32) * 5 / 9;
  const rhClamped = Math.max(1, Math.min(100, rh));

  // Stull approximation for wet-bulb temperature (°C)
  const wetBulbC =
    tempC * Math.atan(0.151977 * Math.sqrt(rhClamped + 8.313659)) +
    Math.atan(tempC + rhClamped) -
    Math.atan(rhClamped - 1.676331) +
    0.00391838 * Math.pow(rhClamped, 1.5) * Math.atan(0.023101 * rhClamped) -
    4.686035;

  // Delta-T in °F
  return (tempC - wetBulbC) * 9 / 5;
}

function cToF(c) {
  return c * 9 / 5 + 32;
}

function degreesToCardinal(deg) {
  if (deg == null) return null;
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return dirs[Math.round(deg / 22.5) % 16];
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 3958.8; // Earth radius in miles
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(deg) {
  return deg * Math.PI / 180;
}

function round(num, decimals) {
  if (num == null) return null;
  const factor = 10 ** decimals;
  return Math.round(num * factor) / factor;
}

function stateAbbrev(state) {
  const abbrevs = {
    'Alabama': 'AL', 'Alaska': 'AK', 'Arizona': 'AZ', 'Arkansas': 'AR',
    'California': 'CA', 'Colorado': 'CO', 'Connecticut': 'CT', 'Delaware': 'DE',
    'Florida': 'FL', 'Georgia': 'GA', 'Hawaii': 'HI', 'Idaho': 'ID',
    'Illinois': 'IL', 'Indiana': 'IN', 'Iowa': 'IA', 'Kansas': 'KS',
    'Kentucky': 'KY', 'Louisiana': 'LA', 'Maine': 'ME', 'Maryland': 'MD',
    'Massachusetts': 'MA', 'Michigan': 'MI', 'Minnesota': 'MN', 'Mississippi': 'MS',
    'Missouri': 'MO', 'Montana': 'MT', 'Nebraska': 'NE', 'Nevada': 'NV',
    'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY',
    'North Carolina': 'NC', 'North Dakota': 'ND', 'Ohio': 'OH', 'Oklahoma': 'OK',
    'Oregon': 'OR', 'Pennsylvania': 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC',
    'South Dakota': 'SD', 'Tennessee': 'TN', 'Texas': 'TX', 'Utah': 'UT',
    'Vermont': 'VT', 'Virginia': 'VA', 'Washington': 'WA', 'West Virginia': 'WV',
    'Wisconsin': 'WI', 'Wyoming': 'WY'
  };
  return abbrevs[state] || state;
}

// ── Fetch with timeout ─────────────────────────────────────────

async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return resp;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}
