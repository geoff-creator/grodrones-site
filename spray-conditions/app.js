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
const confidenceLine = document.getElementById("confidence");
const debugLine = document.getElementById("debug");
const details = document.getElementById("weatherDetails");

let marker;
let activeController = null;

// ── Map click handler ──────────────────────────────────────────
map.on("click", async (event) => {
  const { lat, lng } = event.latlng;
  if (marker) {
    map.removeLayer(marker);
  }
  marker = L.marker([lat, lng]).addTo(map);

  setBanner("pending", "Loading NOAA hourly conditions...");
  confidenceLine.textContent = "Confidence: —";
  debugLine.textContent = "Debug: —";
  updateDetail("Location", `${lat.toFixed(4)}, ${lng.toFixed(4)}`);
  clearDetails();

  try {
    const pointRes = await fetch(`https://api.weather.gov/points/${lat.toFixed(4)},${lng.toFixed(4)}`);
    if (!pointRes.ok) {
      throw new Error("Could not resolve NOAA point data.");
    }

    const pointData = await pointRes.json();
    const hourlyUrl = pointData?.properties?.forecastHourly;
    if (!hourlyUrl) {
      throw new Error("NOAA point response missing forecastHourly.");
    }

    const hourlyRes = await fetch(hourlyUrl);
    if (!hourlyRes.ok) {
      throw new Error("Could not load NOAA hourly forecast.");
    }

    const hourlyData = await hourlyRes.json();
    const periods = hourlyData?.properties?.periods;
    if (!Array.isArray(periods) || periods.length === 0) {
      throw new Error("No hourly forecast periods available.");
    }

    const period = findCurrentPeriod(periods);
    if (!period) {
      throw new Error("Could not find an hourly period matching current time.");
    }

    const windSpeed = parseWindSpeed(period.windSpeed);
    const windGust = parseWindSpeed(period.windGust);
    const rainProb = numberOrNull(period?.probabilityOfPrecipitation?.value);
    const tempF = numberOrNull(period.temperature);
    const humidity = numberOrNull(period?.relativeHumidity?.value);
    const deltaT = tempF != null && humidity != null ? computeDeltaTF(tempF, humidity) : null;

    debugLine.textContent = `Debug: startTime=${period.startTime || "n/a"}, endTime=${period.endTime || "n/a"}, raw windSpeed=${period.windSpeed || "n/a"}, raw windGust=${period.windGust || "n/a"}`;

    updateDetail("Wind Speed", windSpeed == null ? "unavailable" : `${windSpeed.toFixed(1)} mph`);
    updateDetail("Wind Gust", windGust == null ? "unavailable" : `${windGust.toFixed(1)} mph`);
    updateDetail("Wind Direction", period.windDirection || "unavailable");
    updateDetail("Temperature", tempF == null ? "unavailable" : `${tempF.toFixed(1)} °F`);
    updateDetail("Humidity", humidity == null ? "unavailable" : `${humidity.toFixed(0)} %`);
    updateDetail("Delta-T", deltaT == null ? "unavailable" : `${deltaT.toFixed(1)} °F`);
    updateDetail("Rain Probability", rainProb == null ? "unavailable" : `${rainProb.toFixed(0)} %`);

    const result = determineRecommendation({
      windSpeed,
      windGust,
      rainProb: rainProb ?? 0,
      deltaT,
    });

    setBanner(result.level, `${capitalize(result.level)}: ${result.reason}`);
    confidenceLine.textContent = `Confidence: ${assessConfidence({ windSpeed, windGust, tempF, humidity })}`;
  } catch (error) {
    if (error.name === "AbortError") return; // superseded click
    console.error(error);
    setBanner("red", "Unable to load conditions for this location.");
    confidenceLine.textContent = "Confidence: Low";
  }
});

function findCurrentPeriod(periods) {
  const now = Date.now();
  return periods.find((period) => {
    const start = Date.parse(period.startTime);
    const end = Date.parse(period.endTime);
    return Number.isFinite(start) && Number.isFinite(end) && start <= now && now < end;
  });
}

function setBanner(level, text) {
  banner.className = `status ${level}`;
  banner.textContent = text;
}

function updateDetail(label, value) {
  const row = [...details.querySelectorAll("div")].find(
    (node) => node.querySelector("dt")?.textContent === label,
  );
  if (row) {
    row.querySelector("dd").textContent = value;
  }
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

function determineRecommendation({ windSpeed, windGust, rainProb, deltaT }) {
  if (windSpeed == null) {
    return { level: "yellow", reason: "Wind speed unavailable; use caution" };
  }

  const red =
    windSpeed > 15 ||
    (windGust != null && windGust > 20) ||
    rainProb >= 30 ||
    (deltaT != null && (deltaT < 3.6 || deltaT > 18));

  if (red) {
    return { level: "red", reason: "Do not spray" };
  }

  const green =
    windSpeed >= 3 &&
    windSpeed <= 10 &&
    (windGust == null || windGust < 15) &&
    rainProb < 30 &&
    deltaT != null &&
    deltaT >= 5.4 &&
    deltaT <= 14.4;

  if (green) {
    return { level: "green", reason: "Good spray window" };
  }

  return { level: "yellow", reason: "Marginal conditions" };
}

function assessConfidence({ windSpeed, windGust, tempF, humidity }) {
  const missingCount = [windSpeed, windGust, tempF, humidity].filter((v) => v == null).length;
  if (missingCount === 0) return "High";
  if (missingCount === 1) return "Medium";
  return "Low";
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
