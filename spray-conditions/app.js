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

    // ── DEBUG panel (temporary) ──
    renderDebugPanel(data._debug);

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

  // ── Temporary Debug Panel ──────────────────────────────────────
  function renderDebugPanel(debug) {
    // Remove any existing debug panel
    var existing = document.getElementById('debugPanel');
    if (existing) existing.remove();

    if (!debug) return;

    var panel = document.createElement('details');
    panel.id = 'debugPanel';
    panel.style.cssText = 'margin-top:16px;padding:12px;background:#1a1a2e;border:1px solid #444;border-radius:8px;font-family:monospace;font-size:12px;color:#e0e0e0;';

    var summary = document.createElement('summary');
    summary.textContent = 'Debug Info';
    summary.style.cssText = 'cursor:pointer;font-weight:bold;font-size:14px;color:#ff6b6b;padding:4px 0;';
    panel.appendChild(summary);

    var content = document.createElement('div');
    content.style.cssText = 'margin-top:8px;';

    // 1. Winning sources
    content.appendChild(debugSection('Winning Source Per Metric', function (container) {
      var ws = debug.winning_sources || {};
      var keys = ['wind_speed', 'wind_direction', 'wind_gust', 'temperature', 'relative_humidity', 'dew_point', 'precip_chance'];
      keys.forEach(function (k) {
        var entry = ws[k] || {};
        var src = entry.source || 'NONE';
        var val = entry.value != null ? entry.value : 'null';
        var color = src === 'METAR' ? '#4ade80' : src === 'Open-Meteo' ? '#facc15' : src === 'NOAA' ? '#fb923c' : '#888';
        var line = document.createElement('div');
        line.style.cssText = 'padding:2px 0;';
        line.innerHTML = '<span style="color:#aaa;display:inline-block;width:160px;">' + k + '</span>' +
          '<span style="color:' + color + ';font-weight:bold;">' + escapeHtml(src) + '</span>' +
          ' <span style="color:#ccc;">= ' + val + '</span>';
        container.appendChild(line);
      });
    }));

    // 2. METAR candidates & attempts
    content.appendChild(debugSection('METAR Station Search', function (container) {
      var candidates = debug.metar_candidates || [];
      var heading = document.createElement('div');
      heading.style.cssText = 'color:#88c0d0;margin-bottom:4px;';
      heading.textContent = 'Candidates within range: ' + candidates.length;
      container.appendChild(heading);

      candidates.forEach(function (c) {
        var line = document.createElement('div');
        line.style.cssText = 'padding:1px 0;padding-left:8px;';
        line.textContent = c.code + ' (' + c.name + ') — ' + c.distance_miles + ' mi';
        container.appendChild(line);
      });

      var outcome = document.createElement('div');
      outcome.style.cssText = 'margin-top:8px;color:#88c0d0;';
      outcome.textContent = 'Outcome: ' + (debug.metar_outcome || 'N/A');
      container.appendChild(outcome);

      var attempts = debug.metar_attempts || [];
      if (attempts.length > 0) {
        var ah = document.createElement('div');
        ah.style.cssText = 'margin-top:6px;color:#88c0d0;';
        ah.textContent = 'Attempts (' + attempts.length + '):';
        container.appendChild(ah);

        attempts.forEach(function (a) {
          var block = document.createElement('div');
          block.style.cssText = 'margin:4px 0;padding:6px 8px;background:#0d1117;border-radius:4px;border-left:3px solid ' + (a.accepted ? '#4ade80' : '#f87171') + ';';
          var lines = [
            a.station_code + ' — ' + a.distance_miles + ' mi',
            'API returned data: ' + a.api_returned_data,
            'Observation time: ' + (a.observation_time || 'N/A'),
            'Age: ' + (a.age_minutes != null ? a.age_minutes + ' min' : 'N/A'),
          ];
          if (a.has_wind != null) lines.push('Has wind: ' + a.has_wind + ', Has temp: ' + a.has_temp);
          if (a.raw_wind_fields) lines.push('Wind fields: ' + JSON.stringify(a.raw_wind_fields));
          if (a.raw_temp_fields) lines.push('Temp fields: ' + JSON.stringify(a.raw_temp_fields));
          if (a.accepted) {
            lines.push('ACCEPTED');
          } else {
            lines.push('REJECTED: ' + (a.rejection_reason || 'unknown'));
          }
          block.innerHTML = lines.map(function (l) { return '<div>' + escapeHtml(l) + '</div>'; }).join('');
          container.appendChild(block);
        });
      }
    }));

    // 3. Open-Meteo hour selection
    content.appendChild(debugSection('Open-Meteo Hour Selection', function (container) {
      var om = debug.open_meteo;
      if (!om) {
        container.textContent = 'No Open-Meteo debug data returned.';
        return;
      }
      var items = [
        ['Server UTC now', om.server_utc_now],
        ['Open-Meteo timezone', om.open_meteo_timezone],
        ['UTC offset (seconds)', om.open_meteo_utc_offset],
        ['Total hourly entries', om.total_hourly_entries],
        ['', ''],
        ['First 5 hourly times', (om.first_5_hourly_times || []).join(', ')],
        ['Last 3 hourly times', (om.last_3_hourly_times || []).join(', ')],
        ['', ''],
        ['First time raw string', om.first_time_raw_string],
        ['First time parsed as UTC', om.first_time_parsed_as_utc],
        ['PARSING NOTE', om.parsing_note],
        ['', ''],
        ['Selected index', om.selected_index],
        ['Selected time string', om.selected_time_string],
        ['Selected parsed as UTC', om.selected_time_parsed_utc],
        ['Diff from now', om.best_diff_hours + ' hours'],
      ];
      items.forEach(function (pair) {
        if (!pair[0] && !pair[1]) {
          container.appendChild(document.createElement('br'));
          return;
        }
        var line = document.createElement('div');
        line.style.cssText = 'padding:1px 0;';
        var isWarning = pair[0] === 'PARSING NOTE' && pair[1] && pair[1].indexOf('NO timezone') >= 0;
        line.innerHTML = '<span style="color:#aaa;display:inline-block;width:200px;">' + escapeHtml(pair[0]) + '</span>' +
          '<span style="color:' + (isWarning ? '#ff6b6b;font-weight:bold' : '#e0e0e0') + ';">' + escapeHtml(String(pair[1])) + '</span>';
        container.appendChild(line);
      });

      // Selected raw values
      var rv = om.selected_raw_values;
      if (rv) {
        var rvh = document.createElement('div');
        rvh.style.cssText = 'margin-top:8px;color:#88c0d0;';
        rvh.textContent = 'Selected hour raw values:';
        container.appendChild(rvh);
        Object.keys(rv).forEach(function (k) {
          var line = document.createElement('div');
          line.style.cssText = 'padding:1px 0;padding-left:8px;';
          line.innerHTML = '<span style="color:#aaa;display:inline-block;width:160px;">' + k + '</span>' +
            '<span style="color:#e0e0e0;">' + rv[k] + '</span>';
          container.appendChild(line);
        });
      }
    }));

    // 4. Confidence inputs
    content.appendChild(debugSection('Confidence Decision', function (container) {
      var ci = debug.confidence_inputs || {};
      var items = [
        ['Sources used', (ci.sources_used || []).join(', ')],
        ['METAR distance', ci.metar_distance != null ? ci.metar_distance + ' mi' : 'N/A (no METAR)'],
        ['METAR stale', String(ci.metar_stale)],
        ['Has NOAA', String(ci.has_noaa)],
        ['Missing key fields', (ci.missing_key_fields || []).join(', ') || 'none'],
        ['Primary source', ci.primary_source || 'none'],
      ];
      items.forEach(function (pair) {
        var line = document.createElement('div');
        line.style.cssText = 'padding:1px 0;';
        line.innerHTML = '<span style="color:#aaa;display:inline-block;width:180px;">' + escapeHtml(pair[0]) + '</span>' +
          '<span style="color:#e0e0e0;">' + escapeHtml(pair[1]) + '</span>';
        container.appendChild(line);
      });
    }));

    panel.appendChild(content);
    resultsContent.appendChild(panel);
  }

  function debugSection(title, buildFn) {
    var section = document.createElement('div');
    section.style.cssText = 'margin-bottom:12px;';
    var h = document.createElement('div');
    h.style.cssText = 'font-weight:bold;color:#88c0d0;margin-bottom:4px;font-size:13px;border-bottom:1px solid #333;padding-bottom:2px;';
    h.textContent = title;
    section.appendChild(h);
    var body = document.createElement('div');
    body.style.cssText = 'padding-left:4px;';
    buildFn(body);
    section.appendChild(body);
    return section;
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
