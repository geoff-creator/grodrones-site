// ── Spray Conditions — Frontend Logic ──────────────────────────

(function () {
  'use strict';

  // ── State ────────────────────────────────────────────────────
  let map;
  let marker;
  let activeController = null;
  let searchTimeout = null;
  let isSatellite = false;
  let osmLayer, satLayer;

  // ── DOM Elements ─────────────────────────────────────────────
  const searchInput = document.getElementById('searchInput');
  const searchResults = document.getElementById('searchResults');
  const gpsBtn = document.getElementById('gpsBtn');
  const layerToggle = document.getElementById('layerToggle');
  const placeholder = document.getElementById('placeholder');
  const loadingOverlay = document.getElementById('loadingOverlay');
  const errorBanner = document.getElementById('errorBanner');
  const resultsContent = document.getElementById('resultsContent');
  const statusBanner = document.getElementById('statusBanner');
  const statusLabel = document.getElementById('statusLabel');
  const statusReason = document.getElementById('statusReason');
  const locationInfo = document.getElementById('locationInfo');
  const sourceSection = document.getElementById('sourceSection');
  const sourceSectionLabel = document.getElementById('sourceSectionLabel');
  const sourceLabelInfo = document.getElementById('sourceLabelInfo');
  const confidenceDisplay = document.getElementById('confidenceDisplay');
  const primaryMetrics = document.getElementById('primaryMetrics');
  const supportingMetrics = document.getElementById('supportingMetrics');
  const advisories = document.getElementById('advisories');
  const sourceInfo = document.getElementById('sourceInfo');

  // ── Map Initialization ───────────────────────────────────────
  function initMap() {
    map = L.map('map', {
      center: [44.9, -123.0],
      zoom: 8,
      zoomControl: true
    });

    osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    });

    satLayer = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      {
        maxZoom: 19,
        attribution: '&copy; Esri, Maxar, Earthstar Geographics'
      }
    );

    osmLayer.addTo(map);

    // Map click handler
    map.on('click', function (e) {
      setLocation(e.latlng.lat, e.latlng.lng);
    });
  }

  // ── Layer Toggle ─────────────────────────────────────────────
  layerToggle.addEventListener('click', function () {
    if (isSatellite) {
      map.removeLayer(satLayer);
      map.addLayer(osmLayer);
      layerToggle.textContent = 'Satellite';
    } else {
      map.removeLayer(osmLayer);
      map.addLayer(satLayer);
      layerToggle.textContent = 'Map';
    }
    isSatellite = !isSatellite;
  });

  // ── GPS Button ───────────────────────────────────────────────
  gpsBtn.addEventListener('click', function () {
    if (!navigator.geolocation) {
      showError('Geolocation is not supported by your browser.');
      return;
    }

    gpsBtn.disabled = true;
    gpsBtn.textContent = 'Locating…';

    navigator.geolocation.getCurrentPosition(
      function (pos) {
        gpsBtn.disabled = false;
        gpsBtn.innerHTML =
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg> Use My Location';
        setLocation(pos.coords.latitude, pos.coords.longitude);
        map.setView([pos.coords.latitude, pos.coords.longitude], 12);
      },
      function (err) {
        gpsBtn.disabled = false;
        gpsBtn.innerHTML =
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg> Use My Location';
        showError('Unable to get your location. Please allow location access or click the map.');
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  // ── Address Search (Nominatim, debounced) ────────────────────
  searchInput.addEventListener('input', function () {
    var query = searchInput.value.trim();

    if (searchTimeout) clearTimeout(searchTimeout);

    if (query.length < 3) {
      hideSearchResults();
      return;
    }

    searchTimeout = setTimeout(function () {
      searchAddress(query);
    }, 500);
  });

  searchInput.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      hideSearchResults();
    }
  });

  // Close search results when clicking outside
  document.addEventListener('click', function (e) {
    if (!e.target.closest('.search-wrapper')) {
      hideSearchResults();
    }
  });

  async function searchAddress(query) {
    try {
      var resp = await fetch(
        'https://nominatim.openstreetmap.org/search?' +
          new URLSearchParams({
            q: query,
            format: 'json',
            limit: 5,
            countrycodes: 'us',
            addressdetails: 1
          }),
        {
          headers: {
            'User-Agent': 'GroDrones-SprayTool/1.0'
          }
        }
      );

      if (!resp.ok) return;
      var data = await resp.json();

      if (data.length === 0) {
        searchResults.innerHTML =
          '<div class="search-result-item" style="color: var(--gray-400); cursor: default;">No results found</div>';
        searchResults.classList.add('visible');
        return;
      }

      searchResults.innerHTML = data
        .map(function (item) {
          return (
            '<div class="search-result-item" data-lat="' +
            item.lat +
            '" data-lon="' +
            item.lon +
            '">' +
            escapeHtml(item.display_name) +
            '</div>'
          );
        })
        .join('');

      // Add click handlers
      searchResults.querySelectorAll('.search-result-item[data-lat]').forEach(function (el) {
        el.addEventListener('click', function () {
          var lat = parseFloat(el.dataset.lat);
          var lon = parseFloat(el.dataset.lon);
          searchInput.value = el.textContent;
          hideSearchResults();
          map.setView([lat, lon], 12);
          setLocation(lat, lon);
        });
      });

      searchResults.classList.add('visible');
    } catch (e) {
      console.error('Search failed:', e);
    }
  }

  function hideSearchResults() {
    searchResults.classList.remove('visible');
  }

  // ── Set Location & Fetch Data ────────────────────────────────
  function setLocation(lat, lon) {
    // Cancel any in-flight request
    if (activeController) activeController.abort();
    activeController = new AbortController();

    // Update marker
    if (marker) map.removeLayer(marker);
    marker = L.marker([lat, lon]).addTo(map);

    // Show loading
    showLoading();

    // Fetch spray data
    fetchSprayData(lat, lon, activeController.signal);
  }

  async function fetchSprayData(lat, lon, signal) {
    try {
      var url =
        '/.netlify/functions/spray-data?lat=' +
        lat.toFixed(6) +
        '&lon=' +
        lon.toFixed(6);

      var resp = await fetch(url, { signal: signal });
      if (!resp.ok) {
        throw new Error('Server returned ' + resp.status);
      }

      var data = await resp.json();
      if (data.error) {
        throw new Error(data.error);
      }

      renderResults(data);
    } catch (e) {
      if (e.name === 'AbortError') return; // superseded by new click
      console.error('Fetch failed:', e);
      showError('Unable to load conditions. Please try again.');
    }
  }

  // ── Render Results ───────────────────────────────────────────
  function renderResults(data) {
    hideLoading();

    // Overall status banner
    var status = data.overall?.status || 'yellow';
    statusBanner.className = 'status-banner ' + status;

    var statusLabels = {
      green: 'Good to Spray',
      yellow: 'Use Caution',
      red: 'Do Not Spray'
    };
    statusLabel.textContent = statusLabels[status] || status;
    statusReason.textContent = data.overall?.reason || '';

    // Location
    locationInfo.textContent = data.location?.name || data.location?.lat + ', ' + data.location?.lon;

    // Data Source / Observation Station label
    var hasMETAR = data.station && data.primary_source === 'METAR';
    if (hasMETAR) {
      sourceSectionLabel.textContent = 'Observation Station';
      sourceLabelInfo.innerHTML =
        '<span class="station-code">' +
        escapeHtml(data.station.code) +
        '</span> ' +
        escapeHtml(data.station.name) +
        ' &middot; ' +
        data.station.distance_miles +
        ' mi';
    } else {
      sourceSectionLabel.textContent = 'Data Source';
      var srcName = data.primary_source || 'Open-Meteo';
      sourceLabelInfo.innerHTML =
        '<span class="source-name">' + escapeHtml(srcName) + '</span>';
    }

    // Confidence (prominent display)
    var conf = data.trust?.confidence || 'medium';
    var confSummary = data.trust?.summary || '';
    confidenceDisplay.innerHTML =
      '<span class="confidence-badge ' + conf + '">' + conf + ' confidence</span>' +
      (confSummary ? ' <span class="confidence-summary">' + escapeHtml(confSummary) + '</span>' : '');

    // Primary conditions: wind speed + direction, gust
    var m = data.metrics || {};
    primaryMetrics.innerHTML = '';

    // Wind speed + direction (combined row)
    var windValue = formatMetric(m.wind_speed);
    if (m.wind_direction?.value) {
      windValue += ' ' + m.wind_direction.value;
    }
    primaryMetrics.appendChild(
      createMetricRow('Wind', windValue, m.wind_speed?.status)
    );

    primaryMetrics.appendChild(
      createMetricRow('Wind Gust', formatMetric(m.wind_gust), m.wind_gust?.status)
    );

    // Supporting conditions: temperature, RH, precip
    supportingMetrics.innerHTML = '';
    supportingMetrics.appendChild(
      createMetricRow('Temperature', formatMetric(m.temperature), m.temperature?.status)
    );
    supportingMetrics.appendChild(
      createMetricRow('Relative Humidity', formatMetric(m.relative_humidity), m.relative_humidity?.status)
    );
    supportingMetrics.appendChild(
      createMetricRow('Precip Chance', formatMetric(m.precip_chance), m.precip_chance?.status)
    );

    // Delta-T (shown after supporting, lower visual emphasis)
    var deltaTValue = formatMetric(m.delta_t);
    var deltaTReason = data.delta_t_reason || '';
    supportingMetrics.appendChild(
      createMetricRowWithReason('Delta-T (evaporation risk)', deltaTValue, m.delta_t?.status, deltaTReason)
    );

    // Advisories
    advisories.innerHTML = '';

    // Dew point
    var dpValue = m.dew_point?.value != null ? m.dew_point.value + ' ' + m.dew_point.unit : null;
    advisories.appendChild(createAdvisoryRow('Dew Point', dpValue || 'Unavailable'));

    // Inversion note
    if (data.advisories?.inversion) {
      advisories.appendChild(createAdvisoryRow('Inversion Risk', data.advisories.inversion));
    }

    // Source info
    var sources = data.meta?.sources_used || [];
    var updated = data.meta?.last_updated
      ? formatTime(data.meta.last_updated)
      : 'Unknown';
    sourceInfo.innerHTML =
      '<span>Sources: ' + escapeHtml(sources.join(', ') || 'None') + '</span>' +
      '<span>Last updated: ' + escapeHtml(updated) + '</span>';

    // Show results
    resultsContent.classList.add('visible');

    // Smooth scroll to results
    setTimeout(function () {
      var target = statusBanner;
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }, 100);
  }

  // ── Metric Row Builder ───────────────────────────────────────
  function createMetricRow(label, valueStr, status) {
    var row = document.createElement('div');
    row.className = 'metric-row';

    var dot = document.createElement('div');
    dot.className = 'metric-dot ' + (status || 'none');

    var lbl = document.createElement('div');
    lbl.className = 'metric-label';
    lbl.textContent = label;

    var val = document.createElement('div');
    val.className = 'metric-value';
    if (!valueStr || valueStr === '—') {
      val.className += ' unavailable';
      val.textContent = '—';
    } else {
      val.textContent = valueStr;
    }

    row.appendChild(dot);
    row.appendChild(lbl);
    row.appendChild(val);
    return row;
  }

  function createMetricRowWithReason(label, valueStr, status, reason) {
    var row = document.createElement('div');
    row.className = 'metric-row metric-row-with-reason';

    var dot = document.createElement('div');
    dot.className = 'metric-dot ' + (status || 'none');

    var lbl = document.createElement('div');
    lbl.className = 'metric-label';
    lbl.textContent = label;

    var val = document.createElement('div');
    val.className = 'metric-value';
    if (!valueStr || valueStr === '—') {
      val.className += ' unavailable';
      val.textContent = '—';
    } else {
      val.textContent = valueStr;
    }

    row.appendChild(dot);
    row.appendChild(lbl);
    row.appendChild(val);

    if (reason) {
      var reasonEl = document.createElement('div');
      reasonEl.className = 'metric-reason';
      reasonEl.textContent = reason;
      row.appendChild(reasonEl);
    }

    return row;
  }

  function createAdvisoryRow(label, text) {
    var row = document.createElement('div');
    row.className = 'advisory-row';

    var icon = document.createElement('div');
    icon.className = 'advisory-icon';
    icon.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';

    var content = document.createElement('div');
    content.innerHTML =
      '<span class="advisory-label">' + escapeHtml(label) + ':</span> ' + escapeHtml(text);

    row.appendChild(icon);
    row.appendChild(content);
    return row;
  }

  // ── Format Helpers ───────────────────────────────────────────
  function formatMetric(metric) {
    if (!metric || metric.value == null) return '—';
    return metric.value + ' ' + (metric.unit || '');
  }

  function formatTime(isoStr) {
    try {
      var d = new Date(isoStr);
      return d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short'
      });
    } catch (e) {
      return isoStr;
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── UI State Helpers ─────────────────────────────────────────
  function showLoading() {
    placeholder.style.display = 'none';
    errorBanner.style.display = 'none';
    resultsContent.classList.remove('visible');
    loadingOverlay.classList.add('visible');
  }

  function hideLoading() {
    loadingOverlay.classList.remove('visible');
  }

  function showError(msg) {
    hideLoading();
    placeholder.style.display = 'none';
    resultsContent.classList.remove('visible');
    errorBanner.style.display = '';
    errorBanner.textContent = msg;
  }

  // ── Initialize ───────────────────────────────────────────────
  initMap();
})();
