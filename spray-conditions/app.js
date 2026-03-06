const map = L.map("map").setView([44.95, -123.0], 8);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

const banner = document.getElementById("statusBanner");
const details = document.getElementById("weatherDetails");

let marker;

map.on("click", async (event) => {
  const { lat, lng } = event.latlng;

  if (marker) map.removeLayer(marker);
  marker = L.marker([lat, lng]).addTo(map);

  setBanner("pending", "Loading NOAA weather data...");
  updateDetail("Location", `${lat.toFixed(4)}, ${lng.toFixed(4)}`);

  try {
    const pointResponse = await fetch(`https://api.weather.gov/points/${lat.toFixed(4)},${lng.toFixed(4)}`);
    if (!pointResponse.ok) throw new Error("Failed to resolve NOAA point.");

    const pointData = await pointResponse.json();
    const hourlyUrl = pointData?.properties?.forecastHourly;
    const gridUrl = pointData?.properties?.forecastGridData;

    if (!hourlyUrl || !gridUrl) throw new Error("NOAA point response missing forecast URLs.");

    const [hourlyResponse, gridResponse] = await Promise.all([fetch(hourlyUrl), fetch(gridUrl)]);
    if (!hourlyResponse.ok || !gridResponse.ok) throw new Error("Failed to retrieve NOAA forecast data.");

    const hourlyData = await hourlyResponse.json();
    const gridData = await gridResponse.json();

    const period = hourlyData?.properties?.periods?.[0];
    if (!period) throw new Error("No hourly forecast period available.");

    const windSpeedMph = parseWindSpeed(period.windSpeed);
    const windDirection = period.windDirection || "Unknown";
    const rainProb = numberOrNull(period?.probabilityOfPrecipitation?.value) ?? 0;

    const tempF = numberOrNull(period.temperature);

    const humidity =
      numberOrNull(period?.relativeHumidity?.value) ??
      numberOrNull(gridData?.properties?.relativeHumidity?.values?.[0]?.value);

    const windGustMs = numberOrNull(gridData?.properties?.windGust?.values?.[0]?.value);
    const windGustMph = windGustMs != null ? windGustMs * 2.23694 : null;

    if (tempF == null || humidity == null || windSpeedMph == null) {
      throw new Error("Missing required weather fields.");
    }

    const deltaTF = computeDeltaTF(tempF, humidity);
    const sprayStatus = determineSprayStatus({
      windSpeedMph,
      windGustMph,
      rainProb,
    });

    updateDetail("Temperature", `${tempF.toFixed(1)} °F`);
    updateDetail("Humidity", `${humidity.toFixed(0)} %`);
    updateDetail("Delta-T", `${deltaTF.toFixed(1)} °F`);
    updateDetail("Wind Speed", `${windSpeedMph.toFixed(1)} mph`);
    updateDetail("Wind Gust", windGustMph == null ? "N/A" : `${windGustMph.toFixed(1)} mph`);
    updateDetail("Wind Direction", windDirection);
    updateDetail("Precipitation Probability", `${rainProb.toFixed(0)} %`);

    setBanner(sprayStatus.level, sprayStatus.message);
  } catch (error) {
    console.error(error);
    setBanner("red", "Unable to load conditions for this location.");
  }
});

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

function computeDeltaTF(tempF, humidityPercent) {
  const tempC = (tempF - 32) * (5 / 9);
  const rh = Math.max(1, Math.min(100, humidityPercent));

  // Stull approximation for wet-bulb temperature in °C
  const wetBulbC =
    tempC * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) +
    Math.atan(tempC + rh) -
    Math.atan(rh - 1.676331) +
    0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh) -
    4.686035;

  const deltaTC = tempC - wetBulbC;
  return deltaTC * (9 / 5);
}

function determineSprayStatus({ windSpeedMph, windGustMph, rainProb }) {
  const gust = windGustMph ?? 0;

  const isRed = windSpeedMph > 15 || gust > 20 || rainProb >= 30;
  if (isRed) {
    return { level: "red", message: "Red: Do not spray" };
  }

  const isGreen = windSpeedMph >= 3 && windSpeedMph <= 10 && gust < 15 && rainProb < 30;
  if (isGreen) {
    return { level: "green", message: "Green: Good spray conditions" };
  }

  const isYellow =
    (windSpeedMph >= 0 && windSpeedMph < 3) ||
    (windSpeedMph > 10 && windSpeedMph <= 15) ||
    (gust >= 15 && gust <= 20);

  if (isYellow) {
    return { level: "yellow", message: "Yellow: Marginal" };
  }

  return { level: "yellow", message: "Yellow: Marginal" };
}
