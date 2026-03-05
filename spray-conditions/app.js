const map = L.map("map").setView([44.95, -123.0], 8);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

const banner = document.getElementById("statusBanner");
const details = document.getElementById("weatherDetails");

const WILLAMETTE_REGION = {
  minLat: 43.4,
  maxLat: 45.8,
  minLng: -123.9,
  maxLng: -121.9,
};

let marker;
let activeController;

map.on("click", async (event) => {
  const { lat, lng } = event.latlng;

  if (marker) map.removeLayer(marker);
  marker = L.marker([lat, lng]).addTo(map);

  if (activeController) activeController.abort();
  activeController = new AbortController();

  updateDetail("Location", `${lat.toFixed(4)}, ${lng.toFixed(4)}`);

  if (!isWithinSprayRegion(lat, lng)) {
    setBanner("yellow", "Outside intended spray region");
    resetWeatherDetails();
    return;
  }

  setBanner("pending", "Loading NOAA weather data...");

  try {
    const pointData = await fetchNoaaJson(
      `https://api.weather.gov/points/${lat.toFixed(4)},${lng.toFixed(4)}`,
      activeController.signal,
    );

    const hourlyUrl = pointData?.properties?.forecastHourly;
    const gridUrl = pointData?.properties?.forecastGridData;
    if (!hourlyUrl || !gridUrl) throw new Error("NOAA point response missing forecast URLs.");

    const [hourlyData, gridData] = await Promise.all([
      fetchNoaaJson(hourlyUrl, activeController.signal),
      fetchNoaaJson(gridUrl, activeController.signal),
    ]);

    const period = hourlyData?.properties?.periods?.[0];
    if (!period) throw new Error("No hourly forecast period available.");

    const periodStart = new Date(period.startTime || Date.now());
    const windSpeedMph = parseWindSpeed(period.windSpeed);
    const windDirection = period.windDirection || "Unknown";
    const rainProb = numberOrNull(period?.probabilityOfPrecipitation?.value) ?? 0;
    const humidity =
      numberOrNull(period?.relativeHumidity?.value) ??
      getGridValueAtTime(gridData?.properties?.relativeHumidity?.values, periodStart);

    const windGustMs = getGridValueAtTime(gridData?.properties?.windGust?.values, periodStart);
    const windGustMph = windGustMs == null ? null : windGustMs * 2.23694;

    const tempValue = numberOrNull(period.temperature);
    const tempF = normalizeTempF(tempValue, period.temperatureUnit);

    if (tempF == null || humidity == null || windSpeedMph == null) {
      throw new Error("Missing required weather fields.");
    }

    const deltaTF = computeDeltaTF(tempF, humidity);
    const sprayStatus = determineSprayStatus({
      windSpeedMph,
      windGustMph,
      rainProb,
      deltaTF,
    });

    updateDetail("Temperature", `${tempF.toFixed(1)} °F`);
    updateDetail("Humidity", `${humidity.toFixed(0)} %`);
    updateDetail("Delta-T", `${deltaTF.toFixed(1)} °F`);
    updateDetail("Wind Speed", `${windSpeedMph.toFixed(1)} mph`);
    updateDetail("Wind Gust", windGustMph == null ? "Unavailable" : `${windGustMph.toFixed(1)} mph`);
    updateDetail("Wind Direction", windDirection);
    updateDetail("Precipitation Probability", `${rainProb.toFixed(0)} %`);

    setBanner(sprayStatus.level, sprayStatus.message);
  } catch (error) {
    if (error.name === "AbortError") {
      return;
    }
    console.error(error);
    setBanner("red", "Unable to load conditions for this location.");
  }
});

async function fetchNoaaJson(url, signal) {
  const response = await fetch(url, {
    signal,
    headers: {
      Accept: "application/geo+json, application/json",
      "User-Agent": "GroDronesSprayConditions/1.0 (support@grodrones.com)",
    },
  });

  if (!response.ok) {
    throw new Error(`NOAA request failed (${response.status}) for ${url}`);
  }

  return response.json();
}

function isWithinSprayRegion(lat, lng) {
  return (
    lat >= WILLAMETTE_REGION.minLat &&
    lat <= WILLAMETTE_REGION.maxLat &&
    lng >= WILLAMETTE_REGION.minLng &&
    lng <= WILLAMETTE_REGION.maxLng
  );
}

function setBanner(level, text) {
  banner.className = `status ${level}`;
  banner.textContent = text;
}

function updateDetail(label, value) {
  const item = [...details.querySelectorAll("div")].find(
    (node) => node.querySelector("dt")?.textContent === label,
  );
  if (!item) return;
  item.querySelector("dd").textContent = value;
}

function resetWeatherDetails() {
  updateDetail("Temperature", "—");
  updateDetail("Humidity", "—");
  updateDetail("Delta-T", "—");
  updateDetail("Wind Speed", "—");
  updateDetail("Wind Gust", "—");
  updateDetail("Wind Direction", "—");
  updateDetail("Precipitation Probability", "—");
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseWindSpeed(windSpeedText) {
  if (!windSpeedText || typeof windSpeedText !== "string") return null;
  const nums = windSpeedText.match(/\d+/g)?.map(Number);
  if (!nums || nums.length === 0) return null;
  if (nums.length === 1) return nums[0];
  return (nums[0] + nums[1]) / 2;
}

function getGridValueAtTime(values, targetDate) {
  if (!Array.isArray(values) || values.length === 0) return null;

  const target = targetDate instanceof Date ? targetDate : new Date(targetDate);
  const targetMs = target.getTime();

  for (const item of values) {
    const range = parseValidTimeRange(item.validTime);
    if (!range) continue;
    if (targetMs >= range.startMs && targetMs < range.endMs) {
      const val = numberOrNull(item.value);
      if (val != null) return val;
    }
  }

  const future = values
    .map((item) => ({ ...item, range: parseValidTimeRange(item.validTime) }))
    .filter((item) => item.range && item.range.endMs > targetMs)
    .sort((a, b) => a.range.startMs - b.range.startMs)[0];

  const past = values
    .map((item) => ({ ...item, range: parseValidTimeRange(item.validTime) }))
    .filter((item) => item.range && item.range.endMs <= targetMs)
    .sort((a, b) => b.range.endMs - a.range.endMs)[0];

  return numberOrNull(future?.value) ?? numberOrNull(past?.value);
}

function parseValidTimeRange(validTime) {
  if (!validTime || typeof validTime !== "string") return null;
  const [startIso, durationIso] = validTime.split("/");
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) return null;

  const durationMs = parseIsoDurationToMs(durationIso || "PT0H");
  return {
    startMs: start.getTime(),
    endMs: start.getTime() + durationMs,
  };
}

function parseIsoDurationToMs(durationIso) {
  const match = durationIso.match(/P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/);
  if (!match) return 0;
  const days = Number(match[1] || 0);
  const hours = Number(match[2] || 0);
  const minutes = Number(match[3] || 0);
  const seconds = Number(match[4] || 0);
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

function normalizeTempF(tempValue, unit) {
  if (tempValue == null) return null;
  if (unit === "F") return tempValue;
  if (unit === "C") return tempValue * (9 / 5) + 32;
  return tempValue;
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

  const deltaTC = tempC - wetBulbC;
  return deltaTC * (9 / 5);
}

function determineSprayStatus({ windSpeedMph, windGustMph, rainProb, deltaTF }) {
  if (deltaTF < 3.6) return { level: "red", message: "Do not spray — Delta-T too low" };
  if (deltaTF > 18) return { level: "red", message: "Do not spray — Delta-T too high" };

  if (windSpeedMph > 15) return { level: "red", message: "Do not spray — Dangerous wind speed" };
  if (windGustMph != null && windGustMph > 20) return { level: "red", message: "Do not spray — Gusty conditions" };
  if (rainProb >= 30) return { level: "red", message: "Do not spray — Rain risk" };

  if (windGustMph == null) {
    return { level: "yellow", message: "Proceed with caution — gust data unavailable." };
  }

  if (windSpeedMph < 3) {
    return { level: "yellow", message: "Low wind — possible inversion risk" };
  }

  if (windSpeedMph >= 10 && windSpeedMph <= 15) {
    return { level: "yellow", message: "Marginal — elevated wind speed" };
  }

  if (windGustMph >= 15 && windGustMph <= 20) {
    return { level: "yellow", message: "Marginal — gusty conditions" };
  }

  if ((deltaTF >= 3.6 && deltaTF <= 5.4) || (deltaTF >= 14.4 && deltaTF <= 18)) {
    return { level: "yellow", message: "Marginal — Delta-T near limit" };
  }

  if (deltaTF > 5.4 && deltaTF < 14.4 && windSpeedMph >= 3 && windSpeedMph < 10 && windGustMph < 15) {
    return { level: "green", message: "Good spray conditions" };
  }

  return { level: "yellow", message: "Marginal — conditions require caution" };
}
