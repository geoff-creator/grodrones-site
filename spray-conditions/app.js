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

// ── Map setup ──────────────────────────────────────────────────
const map = L.map("map").setView([44.95, -123.0], 8);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

const banner = document.getElementById("statusBanner");
const confidenceLine = document.getElementById("confidence");
const debugLine = document.getElementById("debug");
const details = document.getElementById("weatherDetails");

let marker;
let activeController = null;

// ── Map click handler ──────────────────────────────────────────
map.on("click", async (event) => {
  const { lat, lng } = event.latlng;

  // Cancel any in-flight requests from a previous click
  if (activeController) activeController.abort();
  activeController = new AbortController();
  const signal = activeController.signal;

  if (marker) map.removeLayer(marker);
  marker = L.marker([lat, lng]).addTo(map);

  setBanner("pending", "Loading weather data\u2026");
  confidenceLine.textContent = "Confidence: \u2014";
  debugLine.textContent = "";
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

    // 2. Fetch hourly forecast (required) + station list (best-effort)
    const hourlyPromise = noaaFetch(hourlyUrl, signal);
    const stationsPromise = stationsUrl
      ? noaaFetch(stationsUrl, signal, 5000).catch(() => null)
      : Promise.resolve(null);

    const [hourlyData, stationsData] = await Promise.all([hourlyPromise, stationsPromise]);

    // 3. Pick hourly period matching current time
    const period = findCurrentPeriod(hourlyData?.properties?.periods);
    if (!period) throw new Error("No hourly forecast period for current time.");

    // 4. Try to get latest observation from nearest station (best-effort)
    let observation = null;
    if (stationsData?.features?.length) {
      observation = await fetchLatestObservation(stationsData.features, signal).catch(() => null);
    }

    // 5. Extract values — prefer observation, fall back to forecast
    const windSpeed = extractWindSpeed(observation, period);
    const windGust = extractWindGust(observation, period);
    const windDirection = extractWindDirection(observation, period);
    const tempF = extractTemperature(observation, period);
    const humidity = extractHumidity(observation, period);
    const rainProb = numberOrNull(period?.probabilityOfPrecipitation?.value);
    const deltaT = tempF != null && humidity != null ? computeDeltaTF(tempF, humidity) : null;

    // Debug line (temporary)
    const src = observation ? `Station: ${observation._stationId}` : "Forecast only";
    debugLine.textContent = `Source: ${src} | Period: ${period.startTime || "n/a"} \u2013 ${period.endTime || "n/a"}`;

    // 6. Update UI
    updateDetail("Wind Speed", windSpeed == null ? "unavailable" : `${windSpeed.toFixed(1)} mph`);
    updateDetail("Wind Gust", windGust == null ? "unavailable" : `${windGust.toFixed(1)} mph`);
    updateDetail("Wind Direction", windDirection);
    updateDetail("Temperature", tempF == null ? "unavailable" : `${tempF.toFixed(1)} \u00b0F`);
    updateDetail("Humidity", humidity == null ? "unavailable" : `${humidity.toFixed(0)}%`);
    updateDetail("Delta-T", deltaT == null ? "unavailable" : `${deltaT.toFixed(1)} \u00b0F`);
    updateDetail("Rain Probability", rainProb == null ? "unavailable" : `${rainProb.toFixed(0)}%`);

    if (windSpeed == null || tempF == null) {
      throw new Error("Missing critical weather fields.");
    }

    // 7. Determine spray status
    const result = determineRecommendation({ windSpeed, windGust, rainProb: rainProb ?? 0, deltaT });
    setBanner(result.level, `${capitalize(result.level)}: ${result.reason}`);

    // 8. Confidence
    const missingCount = [windGust, humidity, rainProb].filter((v) => v == null).length;
    const confidence = missingCount === 0 ? "High" : missingCount === 1 ? "Medium" : "Low";
    confidenceLine.textContent = `Confidence: ${confidence}`;
  } catch (error) {
    if (error.name === "AbortError") return; // superseded by newer click
    console.error(error);
    setBanner("red", "Unable to load conditions for this location.");
    confidenceLine.textContent = "Confidence: Low";
  }
});

// ── NOAA fetch with timeout ────────────────────────────────────
async function noaaFetch(url, signal, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });

  try {
    const response = await fetch(url, {
      headers: { Accept: "application/geo+json" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) throw new Error(`NOAA ${response.status}`);
    return response.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ── Time-matching for hourly periods ───────────────────────────
function findCurrentPeriod(periods) {
  if (!periods || periods.length === 0) return null;
  const now = Date.now();
  const match = periods.find((p) => {
    const start = Date.parse(p.startTime);
    const end = Date.parse(p.endTime);
    return Number.isFinite(start) && Number.isFinite(end) && start <= now && now < end;
  });
  if (match) return match;
  // Fall back to earliest future period, then first
  return periods.find((p) => Date.parse(p.startTime) > now) || periods[0];
}

// ── Observation station fetch (best-effort) ────────────────────
async function fetchLatestObservation(stations, signal) {
  // NOAA returns stations ordered by distance — try nearest 3
  for (const station of stations.slice(0, 3)) {
    const id = station.properties?.stationIdentifier;
    if (!id) continue;
    try {
      const data = await noaaFetch(
        `https://api.weather.gov/stations/${id}/observations/latest`,
        signal,
        4000
      );
      const props = data?.properties;
      if (!props) continue;
      // Skip stale observations (> 2 hours old)
      if (props.timestamp) {
        const age = Date.now() - new Date(props.timestamp).getTime();
        if (age > 2 * 60 * 60 * 1000) continue;
      }
      props._stationId = id;
      return props;
    } catch {
      continue;
    }
  }
  return null;
}

// ── Value extraction (observation preferred, forecast fallback) ─
function extractWindSpeed(obs, period) {
  if (obs?.windSpeed?.value != null) return obs.windSpeed.value * 2.23694; // m/s → mph
  return parseWindSpeed(period?.windSpeed);
}

function extractWindGust(obs, period) {
  if (obs?.windGust?.value != null) return obs.windGust.value * 2.23694;
  if (period?.windGust) return parseWindSpeed(period.windGust);
  return null;
}

function extractWindDirection(obs, period) {
  if (obs?.windDirection?.value != null) return degreesToCardinal(obs.windDirection.value);
  return period?.windDirection || "Unknown";
}

function extractTemperature(obs, period) {
  if (obs?.temperature?.value != null) return obs.temperature.value * 9 / 5 + 32; // C → F
  if (period?.temperature != null) {
    return period.temperatureUnit === "C"
      ? period.temperature * 9 / 5 + 32
      : period.temperature;
  }
  return null;
}

function extractHumidity(obs, period) {
  if (obs?.relativeHumidity?.value != null) return obs.relativeHumidity.value;
  if (period?.relativeHumidity?.value != null) return period.relativeHumidity.value;
  return null;
}

// ── Spray recommendation ───────────────────────────────────────
function determineRecommendation({ windSpeed, windGust, rainProb, deltaT }) {
  if (windSpeed == null) {
    return { level: "yellow", reason: "Wind speed unavailable \u2014 use caution" };
  }

  const reasons = [];
  let worst = "green";

  function escalate(level, reason) {
    reasons.push(reason);
    if (level === "red") worst = "red";
    else if (level === "yellow" && worst !== "red") worst = "yellow";
  }

  // Wind speed
  if (windSpeed > SPRAY_RULES.wind.red) {
    escalate("red", "High wind");
  } else if (windSpeed > SPRAY_RULES.wind.green[1]) {
    escalate("yellow", "Elevated wind");
  } else if (windSpeed < SPRAY_RULES.wind.green[0]) {
    escalate("yellow", "Low wind \u2014 possible inversion risk");
  }

  // Gusts
  if (windGust != null) {
    if (windGust > SPRAY_RULES.gust.red) escalate("red", "Dangerous gusts");
    else if (windGust >= SPRAY_RULES.gust.green) escalate("yellow", "Gusty conditions");
  }

  // Rain
  if (rainProb >= SPRAY_RULES.rain.red) escalate("red", "Rain likely");

  // Delta-T
  if (deltaT != null) {
    const dt = SPRAY_RULES.deltaT;
    if (deltaT < dt.red_low) escalate("red", "Delta-T too low \u2014 inversion risk");
    else if (deltaT < dt.yellow_low) escalate("yellow", "Delta-T low");
    else if (deltaT > dt.red_high) escalate("red", "Delta-T too high \u2014 evaporation risk");
    else if (deltaT > dt.green_high) escalate("yellow", "Delta-T high");
  }

  const labels = { green: "Good spray conditions", yellow: "Marginal", red: "Do not spray" };
  let message = labels[worst];
  if (reasons.length > 0) message += " \u2014 " + reasons.join(", ");
  return { level: worst, reason: message };
}

// ── Utility functions ──────────────────────────────────────────
function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseWindSpeed(raw) {
  if (typeof raw !== "string") return null;
  const nums = raw.match(/\d+(?:\.\d+)?/g)?.map(Number);
  if (!nums || nums.length === 0) return null;
  return nums.length === 1 ? nums[0] : (nums[0] + nums[1]) / 2;
}

function computeDeltaTF(tempF, humidityPercent) {
  const tempC = (tempF - 32) * (5 / 9);
  const rh = Math.max(1, Math.min(100, humidityPercent));
  const wetBulbC =
    tempC * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) +
    Math.atan(tempC + rh) -
    Math.atan(rh - 1.676331) +
    0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh) -
    4.686035;
  return (tempC - wetBulbC) * (9 / 5);
}

function degreesToCardinal(deg) {
  if (deg == null) return "Unknown";
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return dirs[Math.round(deg / 22.5) % 16];
}

// ── DOM helpers ────────────────────────────────────────────────
function setBanner(level, text) {
  banner.className = `status ${level}`;
  banner.textContent = text;
}

function updateDetail(label, value) {
  const row = [...details.querySelectorAll("div")].find(
    (node) => node.querySelector("dt")?.textContent === label
  );
  if (row) row.querySelector("dd").textContent = value;
}

function clearDetails() {
  details.querySelectorAll("dd").forEach((dd) => (dd.textContent = "\u2014"));
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
