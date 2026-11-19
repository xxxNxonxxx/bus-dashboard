/**
 * Kindle E-Ink Dashboard – Wiener Linien 63A + Open-Meteo + Uhrzeit
 * Node 18+ (native fetch), Express 4
 */

import express from "express";

const app = express();
const PORT = 3000;
const HOST = "0.0.0.0";

// ─── Wiener Linien config ────────────────────────────────────────────────────
// RBL-Nummern für "Mona-Lisa-Steiner-Weg" – Haltestelle der Linie 63A
// Beide Richtungen (Meidling Hauptstraße + Gesundheitszentrum Süd)
// Werte können ggf. angepasst werden, wenn sich die Wiener Linien API ändert.
const WL_RBL_IDS = [
  3889, // Mona-Lisa-Steiner-Weg Ri. Am Rosenhügel / Meidling Hauptstraße
  3890, // Mona-Lisa-Steiner-Weg Ri. Gesundheitszentrum Süd
];
const WL_API_BASE = "https://www.wienerlinien.at/ogd_realtime/monitor";
const WL_CACHE_TTL_MS = 20_000; // 20 s

// ─── Open-Meteo config ───────────────────────────────────────────────────────
const WEATHER_LAT = 48.1595;
const WEATHER_LON = 16.2957;
const WEATHER_API =
  `https://api.open-meteo.com/v1/forecast` +
  `?latitude=${WEATHER_LAT}&longitude=${WEATHER_LON}` +
  `&current=temperature_2m,apparent_temperature,weathercode,windspeed_10m,winddirection_10m` +
  `&daily=temperature_2m_max,temperature_2m_min` +
  `&timezone=Europe%2FVienna` +
  `&forecast_days=1`;
const WEATHER_CACHE_TTL_MS = 10 * 60_000; // 10 min

// ─── Simple in-memory cache ──────────────────────────────────────────────────
let wlCache   = { data: null, ts: 0 };
let metCache  = { data: null, ts: 0 };

// ─── Helper: fetch with timeout ──────────────────────────────────────────────
async function fetchWithTimeout(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(id);
  }
}

// ─── Wiener Linien data fetch ────────────────────────────────────────────────
async function fetchWienerLinien() {
  const now = Date.now();
  if (wlCache.data && now - wlCache.ts < WL_CACHE_TTL_MS) return wlCache.data;

  const rblParam = WL_RBL_IDS.map((r) => `rbl=${r}`).join("&");
  const url = `${WL_API_BASE}?${rblParam}&activateTrafficInfo=stoerungkurz`;

  try {
    const json = await fetchWithTimeout(url);
    const result = parseWienerLinien(json);
    wlCache = { data: result, ts: now };
    return result;
  } catch (err) {
    console.error("[WL] fetch error:", err.message);
    // return stale cache on error, or error object
    if (wlCache.data) {
      return { ...wlCache.data, stale: true };
    }
    return { error: err.message, departures: [], trafficInfos: [] };
  }
}

// ─── Parse Wiener Linien JSON response ───────────────────────────────────────
function parseWienerLinien(json) {
  const monitors = json?.data?.monitors ?? [];
  const trafficInfos = [];
  const departures = [];

  // Collect traffic infos (Störungskurz)
  // Note: trafficjam can be false (boolean) or an array depending on the API response
  const infoSet = new Set();
  for (const mon of monitors) {
    const tj = mon.lines?.[0]?.trafficjam;
    const tjArr = Array.isArray(tj) ? tj : [];
    for (const ti of tjArr) {
      if (!infoSet.has(ti.refTrafficInfoId)) {
        infoSet.add(ti.refTrafficInfoId);
        trafficInfos.push(ti.title ?? "Störung");
      }
    }
  }

  // Also from top-level trafficInfos
  const topInfos = json?.data?.trafficInfos ?? [];
  for (const ti of topInfos) {
    const title = ti.attributes?.title ?? "";
    if (title && !infoSet.has(title)) {
      infoSet.add(title);
      trafficInfos.push(title);
    }
  }

  // Collect departures from all monitors / lines
  for (const mon of monitors) {
    for (const line of mon.lines ?? []) {
      // Filter: only 63A
      if (line.name !== "63A") continue;
      const towards = line.towards ?? "";
      const platform = mon.locationStop?.properties?.title ?? "";

      for (const dep of line.departures?.departure ?? []) {
        const dt = dep.departureTime;
        if (!dt) continue;

        const timePlanned  = dt.timePlanned;    // ISO string or null
        const timeReal     = dt.timeReal;        // ISO string or null (realtime)
        const countdown    = dt.countdown ?? 0;  // minutes until departure

        // Skip departures in the distant past (countdown < -1)
        if (countdown < -1) continue;

        const isLive = !!timeReal;
        const displayTime = timeReal ?? timePlanned;

        departures.push({
          towards,
          platform,
          countdown,          // int minutes
          timePlanned,
          timeReal,
          displayTime,
          isLive,
        });
      }
    }
  }

  // Sort ascending by countdown
  departures.sort((a, b) => a.countdown - b.countdown);

  return { departures, trafficInfos, error: null, stale: false };
}

// ─── Weather data fetch ───────────────────────────────────────────────────────
async function fetchWeather() {
  const now = Date.now();
  if (metCache.data && now - metCache.ts < WEATHER_CACHE_TTL_MS) return metCache.data;

  try {
    const json = await fetchWithTimeout(WEATHER_API);
    const result = parseWeather(json);
    metCache = { data: result, ts: now };
    return result;
  } catch (err) {
    console.error("[Weather] fetch error:", err.message);
    if (metCache.data) return { ...metCache.data, stale: true };
    return { error: err.message };
  }
}

// WMO weather interpretation codes → German label + ASCII icon
const WMO_CODES = {
  0:  ["Klarer Himmel",        "☀"],
  1:  ["Überwiegend klar",     "🌤"],
  2:  ["Teilweise bewölkt",    "⛅"],
  3:  ["Bedeckt",              "☁"],
  45: ["Neblig",               "🌫"],
  48: ["Reif-Nebel",           "🌫"],
  51: ["Leichter Nieselregen", "🌦"],
  53: ["Mäßiger Nieselregen",  "🌦"],
  55: ["Starker Nieselregen",  "🌧"],
  61: ["Leichter Regen",       "🌧"],
  63: ["Mäßiger Regen",        "🌧"],
  65: ["Starker Regen",        "🌧"],
  71: ["Leichter Schnee",      "❄"],
  73: ["Mäßiger Schnee",       "❄"],
  75: ["Starker Schnee",       "❄"],
  80: ["Regenschauer",         "🌦"],
  81: ["Mäßige Schauer",       "🌧"],
  82: ["Starke Schauer",       "⛈"],
  95: ["Gewitter",             "⛈"],
  96: ["Gewitter+Hagel",       "⛈"],
  99: ["Schwerer Hagel",       "⛈"],
};

function parseWeather(json) {
  const c = json?.current ?? {};
  const d = json?.daily ?? {};
  const code = c.weathercode ?? 0;
  const [condition, icon] = WMO_CODES[code] ?? ["Unbekannt", "?"];
  const windDir = c.winddirection_10m ?? 0;

  return {
    temp:        Math.round(c.temperature_2m ?? 0),
    feelsLike:   Math.round(c.apparent_temperature ?? 0),
    condition,
    icon,
    windSpeed:   Math.round(c.windspeed_10m ?? 0),
    windDir:     windDir,
    windArrow:   degToArrow(windDir),
    tempMax:     Math.round((d.temperature_2m_max ?? [0])[0] ?? 0),
    tempMin:     Math.round((d.temperature_2m_min ?? [0])[0] ?? 0),
    error:       null,
    stale:       false,
  };
}

function degToArrow(deg) {
  const dirs = ["N","NO","O","SO","S","SW","W","NW"];
  return dirs[Math.round(deg / 45) % 8];
}

// ─── Vienna time helpers ──────────────────────────────────────────────────────
function viennaTime() {
  return new Date().toLocaleString("de-AT", { timeZone: "Europe/Vienna" });
}

function viennaClock() {
  return new Date().toLocaleTimeString("de-AT", {
    timeZone: "Europe/Vienna",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function viennaDate() {
  return new Date().toLocaleDateString("de-AT", {
    timeZone: "Europe/Vienna",
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

function formatTime(isoStr) {
  if (!isoStr) return "–";
  const d = new Date(isoStr);
  return d.toLocaleTimeString("de-AT", {
    timeZone: "Europe/Vienna",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Keyword used to identify the primary direction
const PRIMARY_TOWARDS_KEYWORD = "Gesundheitszentrum";

// ─── HTML renderer ────────────────────────────────────────────────────────────
function renderHTML(wl, weather) {
  const clock = viennaClock();
  const dateStr = viennaDate();

  const { departures, trafficInfos, error: wlErr, stale: wlStale } = wl;

  // ── Split by direction ──
  const primary   = departures.filter((d) => d.towards.includes(PRIMARY_TOWARDS_KEYWORD) && d.countdown <= 90);
  const secondary = departures.filter((d) => !d.towards.includes(PRIMARY_TOWARDS_KEYWORD) && d.countdown <= 70);

  // ── Traffic infos ──
  let trafficHtml = "";
  if (trafficInfos.length > 0) {
    const items = trafficInfos.map((t) => `<li>${escHtml(t)}</li>`).join("");
    trafficHtml = `<div class="traffic-box"><strong>⚠ Störungen:</strong><ul>${items}</ul></div>`;
  }

  // ── Stale warnings ──
  const wlStaleWarn  = wlStale  ? ` <span class="stale-inline">(Cache)</span>` : "";
  const metStaleWarn = weather.stale ? `<span class="stale">(Wetter: Zwischengespeichert)</span>` : "";

  // ── Hero block: next departure towards Gesundheitszentrum ──
  let heroHtml = "";
  if (wlErr && !wlStale) {
    heroHtml = `<p class="status-err">⚠ Echtzeitdaten nicht verfügbar: ${escHtml(wlErr)}</p>`;
  } else if (primary.length === 0) {
    heroHtml = `<p class="status-ok">🌙 Derzeit keine Abfahrten Ri. <strong>Gesundheitszentrum Süd</strong> in den nächsten 90 Min.</p>`;
  } else {
    const next = primary[0];
    const heroCountdown = next.countdown <= 0
      ? `<span class="hero-jetzt">JETZT</span>`
      : `<span class="hero-min">${next.countdown}</span><span class="hero-unit">min</span>`;
    const heroBadge = next.isLive
      ? `<span class="live">LIVE</span>`
      : `<span class="plan">PLAN</span>`;
    const heroTime = formatTime(next.displayTime);

    // upcoming after the first (next 3)
    let nextRows = "";
    for (const dep of primary.slice(1, 4)) {
      const cd = dep.countdown <= 0 ? `<span class="jetzt">JETZT</span>` : `${dep.countdown}&prime;`;
      const badge = dep.isLive ? `<span class="live">LIVE</span>` : `<span class="plan">PLAN</span>`;
      nextRows += `<tr><td class="td-cd2">${cd}</td><td class="td-time2">${formatTime(dep.displayTime)}</td><td class="td-badge2">${badge}</td></tr>`;
    }

    heroHtml = `
      <div class="hero-box">
        <div class="hero-label">Ri. Gesundheitszentrum Süd</div>
        <div class="hero-countdown">${heroCountdown}</div>
        <div class="hero-sub">${heroBadge} &nbsp; ${heroTime} Uhr</div>
      </div>
      ${nextRows ? `<table class="next-table"><tbody>${nextRows}</tbody></table>` : ""}`;
  }

  // ── Secondary: other direction (small) ──
  let secondaryHtml = "";
  if (secondary.length > 0) {
    let rows = "";
    for (const dep of secondary.slice(0, 4)) {
      const cd = dep.countdown <= 0 ? `<span class="jetzt">JETZT</span>` : `${dep.countdown}&prime;`;
      const badge = dep.isLive ? `<span class="live">LIVE</span>` : `<span class="plan">PLAN</span>`;
      rows += `<tr><td class="td-cd2">${cd}</td><td class="td-time2">${formatTime(dep.displayTime)}</td><td class="td-badge2">${badge}</td><td class="td-dir2">${escHtml(dep.towards)}</td></tr>`;
    }
    secondaryHtml = `
      <div class="sec-title">↩ Am Rosenhügel / Meidling</div>
      <table class="next-table"><tbody>${rows}</tbody></table>`;
  }

  // ── Weather block ──
  let weatherHtml = "";
  if (weather.error && !weather.stale) {
    weatherHtml = `<p class="status-err">⚠ Wetterdaten nicht verfügbar.</p>`;
  } else {
    weatherHtml = `
      <div class="weather-row">
        <span class="w-icon">${weather.icon ?? ""}</span>
        <span class="w-temp">${weather.temp ?? "–"}°C</span>
        <span class="w-cond">${escHtml(weather.condition ?? "")}</span>
        <span class="w-feels">Gefühlt ${weather.feelsLike ?? "–"}°C</span>
        <span class="w-range">↓${weather.tempMin ?? "–"}° ↑${weather.tempMax ?? "–"}°</span>
        <span class="w-wind">Wind ${weather.windSpeed ?? "–"} km/h ${weather.windArrow ?? ""}</span>
      </div>
      ${metStaleWarn}`;
  }

  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="30">
  <title>63A – Mona-Lisa-Steiner-Weg</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: #ffffff;
      color: #000000;
      font-family: Georgia, "Times New Roman", serif;
      font-size: 16px;
      line-height: 1.4;
      padding: 10px;
      max-width: 720px;
      margin: 0 auto;
    }

    /* ── Clock header ── */
    .header {
      border: 3px solid #000;
      padding: 8px 14px;
      margin-bottom: 10px;
      display: flex;
      align-items: baseline;
      gap: 16px;
    }
    .clock {
      font-size: 3.2em;
      font-weight: bold;
      letter-spacing: 2px;
      font-family: "Courier New", Courier, monospace;
    }
    .date { font-size: 1em; font-weight: bold; }

    /* ── Section bar ── */
    .section-title {
      background: #000;
      color: #fff;
      padding: 4px 8px;
      font-size: 1em;
      font-weight: bold;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 6px;
    }
    .stale-inline { font-size: 0.7em; font-weight: normal; font-style: italic; }

    /* ── HERO box ── */
    .hero-box {
      border: 4px solid #000;
      padding: 12px 16px 10px;
      margin-bottom: 8px;
      text-align: center;
    }
    .hero-label {
      font-size: 1em;
      font-weight: bold;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 4px;
    }
    .hero-countdown {
      line-height: 1;
      margin: 6px 0;
    }
    .hero-min {
      font-size: 5.5em;
      font-weight: bold;
      font-family: "Courier New", Courier, monospace;
    }
    .hero-unit {
      font-size: 2em;
      font-weight: bold;
      font-family: "Courier New", Courier, monospace;
      margin-left: 6px;
    }
    .hero-jetzt {
      display: inline-block;
      font-size: 4em;
      font-weight: bold;
      font-family: "Courier New", Courier, monospace;
      background: #000;
      color: #fff;
      padding: 4px 16px;
    }
    .hero-sub {
      font-size: 1.2em;
      font-family: "Courier New", Courier, monospace;
      margin-top: 4px;
    }

    /* ── Next departures (small table) ── */
    .next-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 8px;
    }
    .next-table td { border: 1px solid #000; padding: 4px 8px; }
    .td-cd2   { text-align: center; width: 50px; font-family: "Courier New", Courier, monospace; font-weight: bold; }
    .td-time2 { text-align: center; width: 60px; font-family: "Courier New", Courier, monospace; }
    .td-badge2{ text-align: center; width: 50px; }
    .td-dir2  { font-size: 0.85em; }

    /* ── Secondary direction ── */
    .sec-title {
      border-top: 2px solid #000;
      border-bottom: 1px solid #000;
      padding: 3px 8px;
      font-size: 0.85em;
      font-weight: bold;
      margin-bottom: 4px;
      margin-top: 6px;
    }

    /* ── Badges ── */
    .jetzt {
      display: inline-block;
      background: #000;
      color: #fff;
      font-weight: bold;
      font-size: 0.8em;
      padding: 1px 4px;
    }
    .live {
      display: inline-block;
      background: #000;
      color: #fff;
      border: 2px solid #000;
      padding: 1px 4px;
      font-size: 0.72em;
      font-weight: bold;
      letter-spacing: 1px;
    }
    .plan {
      display: inline-block;
      border: 2px solid #000;
      padding: 1px 4px;
      font-size: 0.72em;
      font-weight: bold;
      letter-spacing: 1px;
    }

    /* ── Status messages ── */
    .status-err {
      border: 3px solid #000;
      padding: 10px 14px;
      font-weight: bold;
      margin: 8px 0;
    }
    .status-ok {
      border: 2px solid #000;
      padding: 10px 14px;
      margin: 8px 0;
    }

    /* ── Traffic info ── */
    .traffic-box {
      border: 3px solid #000;
      padding: 6px 10px;
      margin-bottom: 8px;
      font-size: 0.88em;
    }
    .traffic-box ul { margin-left: 18px; }

    /* ── Weather ── */
    .weather-section { margin-top: 8px; }
    .weather-row {
      border: 2px solid #000;
      padding: 7px 12px;
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      font-size: 0.92em;
    }
    .w-icon  { font-size: 1.8em; }
    .w-temp  { font-size: 1.8em; font-weight: bold; font-family: "Courier New", Courier, monospace; }
    .w-cond  { font-weight: bold; font-size: 1em; }
    .w-feels, .w-range, .w-wind {
      border-left: 2px solid #000;
      padding-left: 8px;
      font-size: 0.9em;
    }

    /* ── Stale ── */
    .stale { display: block; font-size: 0.72em; font-style: italic; margin-top: 3px; }

    /* ── Footer ── */
    .footer {
      border-top: 2px solid #000;
      margin-top: 8px;
      padding-top: 5px;
      font-size: 0.72em;
      display: flex;
      justify-content: space-between;
    }

    .hero-min, .hero-jetzt, .clock { -webkit-user-select: none; user-select: none; }
  </style>
</head>
<body>

  <!-- Clock -->
  <div class="header">
    <span class="clock">${clock}</span>
    <span class="date">${escHtml(dateStr)}</span>
  </div>

  <!-- Primary departure hero -->
  <div class="dep-section">
    <div class="section-title">🚌 63A – Nächste Abfahrt${wlStaleWarn}</div>
    ${trafficHtml}
    ${heroHtml}
    ${secondaryHtml}
  </div>

  <!-- Weather -->
  <div class="weather-section">
    <div class="section-title">🌡 Wetter – 1120 Wien</div>
    ${weatherHtml}
  </div>

  <!-- Footer -->
  <div class="footer">
    <span>Aktualisiert: ${escHtml(viennaTime())}</span>
    <span>Auto-Refresh: 30s</span>
  </div>

  <script>
    (function() {
      try { setTimeout(function() { location.reload(); }, 32000); } catch(e) {}
    })();
  </script>

</body>
</html>`;
}

// ─── HTML escape ─────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─── Routes ──────────────────────────────────────────────────────────────────
app.get("/", async (_req, res) => {
  try {
    const [wl, weather] = await Promise.all([fetchWienerLinien(), fetchWeather()]);
    const html = renderHTML(wl, weather);
    res
      .set("Content-Type", "text/html; charset=utf-8")
      .set("Cache-Control", "no-store")
      .send(html);
  } catch (err) {
    console.error("[Route /] unexpected error:", err);
    res.status(500).send(`<html><body><h1>Interner Fehler</h1><pre>${escHtml(err.message)}</pre></body></html>`);
  }
});

// Health-check endpoint
app.get("/health", (_req, res) => {
  res.json({ ok: true, time: viennaTime() });
});

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  console.log(`✅  Dashboard läuft auf http://${HOST}:${PORT}`);
  console.log(`    Kindle URL: http://<deine-IP>:${PORT}`);
});
