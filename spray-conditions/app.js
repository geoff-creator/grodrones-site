// ── Configuration ──────────────────────────────────────────────
const SPRAY_RULES = {
  wind: { green: [3, 10], yellow: [0, 15], red: 15 },
  gust: { green: 15, yellow: 20, red: 20 },
  rain: { green: 30, red: 30 },
  deltaT: {
    red_low: 3.6,       // < 3.6 F → Red (inversion / humidity)
    yellow_low: 5.4,    // 3.6–5.4 F → Yellow
    green_low: 5.4,     // 5.4–14.4 F → Green
    green_high: 14.4,
    yellow_high: 18,    // 14.4–18 F → Yellow
    red_high: 18,       // > 18 F → Red (evaporation)
  },
};

const NOAA_HEADERS = {
  Accept: "application/geo+json",
  "User-Agent": "(GroDrones Spray Conditions, geoff@grodrones.com)",
};

// ── Map setup ──────────────────────────────────────────────────
const map = L.map("map").setView([44.95, -123.0], 8);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

const banner = document.getElementById("statusBanner");
const details = document.getElementById("weatherDetails");

let marker;
let activeController = null;

// ── Map click handler ──────────────────────────────────────────
map.on("click", async (event) => {
  const { lat, lng } = event.latlng;

  // Cancel any in-flight requests
  if (activeController) activeController.abort();
  activeController = new AbortController();
  const signal = activeController.signal;

  if (marker) map.removeLayer(marker);
  marker = L.marker([lat, lng]).addTo(map);

  setBanner("pending", "Loading weather data\u2026");
  updateDetail("Location", `${lat.toFixed(4)}, ${lng.toFixed(4)}`);
  clearDetails();

  try {
    // 1. Resolve NOAA grid point
    const pointData = await noaaFetch(
      `https://api.weather.gov/points/${lat.toFixed(4)},${lng.toFixed(4)}`,
      signal
    );

    const hourlyUrl = pointData?.properties?.forecastHourly;
    const stationsUrl = pointData?.properties?.observationStations;

    if (!hourlyUrl) throw new Error("NOAA point missing forecast URL.");

    // 2. Fetch hourly forecast + observation stations in parallel
    const fetches = [noaaFetch(hourlyUrl, signal)];
    if (stationsUrl) fetches.push(noaaFetch(stationsUrl, signal));

    const [hourlyData, stationsData] = await Promise.all(fetches);

    // 3. Pick hourly period matching current time
    const period = findCurrentPeriod(hourlyData?.properties?.periods);
    if (!period) throw new Error("No hourly forecast period available.");

    // 4. Try to get latest observation from nearest station
    let observation = null;
    if (stationsData?.features?.length) {
      observation = await fetchLatestObservation(stationsData.features, signal);
    }

    // 5. Extract values — prefer observation for "right now", forecast for planning
    const windSpeedMph = extractWindSpeed(observation, period);
    const windGustMph = extractWindGust(observation, period);
    const windDirection = extractWindDirection(observation, period);
    const tempF = extractTemperature(observation, period);
    const humidity = extractHumidity(observation, period);
    const rainProb =
      numberOrNull(period?.probabilityOfPrecipitation?.value) ?? null;

    if (windSpeedMph == null || tempF == null) {
      throw new Error("Missing critical weather fields for this location.");
    }

    // 6. Calculate Delta-T (needs temp + humidity)
    const deltaTF = humidity != null ? computeDeltaTF(tempF, humidity) : null;

    // 7. Determine spray status
    const sprayStatus = determineSprayStatus({
      windSpeedMph,
      windGustMph,
      deltaTF,
      rainProb,
    });

    // 8. Populate UI
    updateDetail("Temperature", `${tempF.toFixed(1)} \u00b0F`);
    updateDetail("Humidity", humidity != null ? `${humidity.toFixed(0)}%` : "unavailable");
    updateDetail("Delta-T", deltaTF != null ? `${deltaTF.toFixed(1)} \u00b0F` : "unavailable");
    updateDetail("Wind Speed", `${windSpeedMph.toFixed(1)} mph`);
    updateDetail(
      "Wind Gust",
      windGustMph != null ? `${windGustMph.toFixed(1)} mph` : "unavailable"
    );
    updateDetail("Wind Direction", windDirection);
    updateDetail(
      "Rain Probability",
      rainProb != null ? `${rainProb.toFixed(0)}%` : "unavailable"
    );

    // Confidence
    const missing = [
      windGustMph == null,
      humidity == null,
      rainProb == null,
    ].filter(Boolean).length;
    const confidence = missing === 0 ? "High" : missing === 1 ? "Medium" : "Low";
    updateDetail("Confidence", confidence);

    // Data source
    updateDetail(
      "Source",
      observation
        ? `Observed (${observation._stationId}) + Forecast`
        : "Forecast only"
    );

    setBanner(sprayStatus.level, sprayStatus.message);
  } catch (error) {
    if (error.name === "AbortError") return; // superseded click
    console.error(error);
    setBanner("red", "Unable to load conditions for this location.");
  }
});

// ── NOAA fetch helper ──────────────────────────────────────────
async function noaaFetch(url, signal) {
  const response = await fetch(url, { headers: NOAA_HEADERS, signal });
  if (!response.ok) throw new Error(`NOAA request failed: ${response.status}`);
  return response.json();
}

// ── Time-matching for hourly periods ───────────────────────────
function findCurrentPeriod(periods) {
  if (!periods || periods.length === 0) return null;
  const now = new Date();
  for (const p of periods) {
    const start = new Date(p.startTime);
    const end = new Date(p.endTime);
    if (now >= start && now < end) return p;
  }
  // If no exact match, use the earliest future period, then fall back to first
  const future = periods.find((p) => new Date(p.startTime) > now);
  return future || periods[0];
}

// ── Observation station fetch ──────────────────────────────────
async function fetchLatestObservation(stations, signal) {
  // Try the nearest 3 stations (they're ordered by distance from NOAA)
  const candidates = stations.slice(0, 3);
  for (const station of candidates) {
    const stationId = station.properties?.stationIdentifier;
    if (!stationId) continue;
    try {
      const url = `https://api.weather.gov/stations/${stationId}/observations/latest`;
      const data = await noaaFetch(url, signal);
      const props = data?.properties;
      if (!props) continue;
      // Check the observation isn't too stale (> 2 hours)
      if (props.timestamp) {
        const age = Date.now() - new Date(props.timestamp).getTime();
        if (age > 2 * 60 * 60 * 1000) continue;
      }
      props._stationId = stationId;
      return props;
    } catch {
      continue; // station failed, try next
    }
  }
  return null;
}

// ── Value extraction (observation preferred, forecast fallback) ─
function extractWindSpeed(obs, period) {
  // Observation windSpeed is in m/s (SI)
  if (obs?.windSpeed?.value != null) {
    return obs.windSpeed.value * 2.23694;
  }
  return parseWindSpeedString(period?.windSpeed);
}

function extractWindGust(obs, period) {
  // Observation windGust is in m/s (SI)
  if (obs?.windGust?.value != null) {
    return obs.windGust.value * 2.23694;
  }
  // Hourly forecast period.windGust — can be a string like "20 mph" or null
  if (period?.windGust) {
    return parseWindSpeedString(period.windGust);
  }
  return null;
}

function extractWindDirection(obs, period) {
  if (obs?.windDirection?.value != null) {
    return degreesToCardinal(obs.windDirection.value);
  }
  return period?.windDirection || "Unknown";
}

function extractTemperature(obs, period) {
  // Observation temperature is in Celsius (SI)
  if (obs?.temperature?.value != null) {
    return obs.temperature.value * 9 / 5 + 32;
  }
  if (period?.temperature != null) {
    if (period.temperatureUnit === "C") {
      return period.temperature * 9 / 5 + 32;
    }
    return period.temperature;
  }
  return null;
}

function extractHumidity(obs, period) {
  if (obs?.relativeHumidity?.value != null) {
    return obs.relativeHumidity.value;
  }
  if (period?.relativeHumidity?.value != null) {
    return period.relativeHumidity.value;
  }
  return null;
}

// ── Spray status logic ─────────────────────────────────────────
function determineSprayStatus({ windSpeedMph, windGustMph, deltaTF, rainProb }) {
  const reasons = [];
  let dominated = "green"; // start optimistic

  function escalate(level, reason) {
    reasons.push(reason);
    if (level === "red") dominated = "red";
    else if (level === "yellow" && dominated !== "red") dominated = "yellow";
  }

  // ── Wind speed ──
  if (windSpeedMph > SPRAY_RULES.wind.red) {
    escalate("red", "High wind");
  } else if (windSpeedMph > SPRAY_RULES.wind.yellow[1]) {
    escalate("red", "High wind");
  } else if (windSpeedMph > SPRAY_RULES.wind.green[1]) {
    escalate("yellow", "Elevated wind");
  } else if (windSpeedMph < SPRAY_RULES.wind.green[0]) {
    escalate("yellow", "Low wind \u2014 possible inversion risk");
  }

  // ── Gusts ──
  if (windGustMph != null) {
    if (windGustMph > SPRAY_RULES.gust.red) {
      escalate("red", "Dangerous gusts");
    } else if (windGustMph >= SPRAY_RULES.gust.green) {
      escalate("yellow", "Gusty conditions");
    }
  }

  // ── Rain ──
  if (rainProb != null && rainProb >= SPRAY_RULES.rain.red) {
    escalate("red", "Rain likely");
  }

  // ── Delta-T ──
  if (deltaTF != null) {
    const dt = SPRAY_RULES.deltaT;
    if (deltaTF < dt.red_low) {
      escalate("red", "Delta-T too low \u2014 inversion risk");
    } else if (deltaTF < dt.yellow_low) {
      escalate("yellow", "Delta-T low");
    } else if (deltaTF > dt.red_high) {
      escalate("red", "Delta-T too high \u2014 evaporation risk");
    } else if (deltaTF > dt.green_high) {
      escalate("yellow", "Delta-T high");
    }
  }

  // ── Build message ──
  const labels = {
    green: "Good spray conditions",
    yellow: "Marginal",
    red: "Do not spray",
  };

  let message = labels[dominated];
  if (reasons.length > 0) {
    message += " \u2014 " + reasons.join(", ");
  }

  const prefix = { green: "Green", yellow: "Yellow", red: "Red" };
  return {
    level: dominated,
    message: `${prefix[dominated]}: ${message}`,
  };
}

// ── Utility functions ──────────────────────────────────────────
function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseWindSpeedString(text) {
  if (!text || typeof text !== "string") return null;
  const nums = text.match(/\d+/g)?.map(Number);
  if (!nums || nums.length === 0) return null;
  return nums.length === 1 ? nums[0] : (nums[0] + nums[1]) / 2;
}

function computeDeltaTF(tempF, humidityPercent) {
  const tempC = (tempF - 32) * (5 / 9);
  const rh = Math.max(1, Math.min(100, humidityPercent));

  // Stull approximation for wet-bulb temperature in C
  const wetBulbC =
    tempC * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) +
    Math.atan(tempC + rh) -
    Math.atan(rh - 1.676331) +
    0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh) -
    4.686035;

  const deltaTC = tempC - wetBulbC;
  return deltaTC * (9 / 5);
}

function degreesToCardinal(deg) {
  if (deg == null) return "Unknown";
  const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return dirs[Math.round(deg / 22.5) % 16];
}

// ── DOM helpers ────────────────────────────────────────────────
function setBanner(level, text) {
  banner.className = `status ${level}`;
  banner.textContent = text;
}

function updateDetail(label, value) {
  const item = [...details.querySelectorAll("div")].find(
    (node) => node.querySelector("dt")?.textContent === label
  );
  if (!item) return;
  item.querySelector("dd").textContent = value;
}

function clearDetails() {
  details.querySelectorAll("dd").forEach((dd) => (dd.textContent = "\u2014"));
}
