/**
 * Kindle E-Ink Dashboard – lokaler Server (Node >= 18, keine Dependencies)
 *
 *   GET /          reines SSR-HTML für den Kindle (funktioniert ohne JavaScript)
 *   GET /api/raw   Rohdaten {wl, wlAt, weather, weatherAt, ...} mit CORS (gleiches Format wie das Relay)
 *   GET /pages/    die GitHub-Pages-Variante (docs/) zum lokalen Testen
 *   GET /healthz   Cache-Alter und letzte Fehler
 */
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Dash = require("./docs/core.js");
const DIR = path.dirname(fileURLToPath(import.meta.url));

// ─── Konfiguration ──────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const REFRESH_SEC = 30;

// Env-Override nur für Tests (z. B. Mock-Server)
const WL_URL =
  process.env.WL_URL ||
  "https://www.wienerlinien.at/ogd_realtime/monitor?rbl=3890&rbl=3889&activateTrafficInfo=stoerungkurz";
const WEATHER_URL =
  process.env.WEATHER_URL ||
  "https://api.open-meteo.com/v1/forecast?latitude=48.1595&longitude=16.2957" +
  "&current=temperature_2m,apparent_temperature,weathercode,windspeed_10m,winddirection_10m" +
  "&daily=temperature_2m_max,temperature_2m_min&timezone=Europe%2FVienna&forecast_days=1";

const TIMEOUT_MS = Number(process.env.TIMEOUT_MS) || 15_000;          // pro Versuch
const RETRY_DELAYS_MS = [1_000, 3_000]; // = 2 Retries
const MAX_WAIT_MS = 4_000;          // so lange wartet eine Seitenanfrage max. auf frische Daten, wenn Cache existiert

// ─── IPv4 erzwingen (beide APIs haben ohnehin keinen AAAA-Record) ───────────
dns.setDefaultResultOrder("ipv4first");
if (typeof net.setDefaultAutoSelectFamily === "function") net.setDefaultAutoSelectFamily(false);
const agent = new https.Agent({ keepAlive: true, family: 4, maxSockets: 4 });

// ─── Logging ────────────────────────────────────────────────────────────────
function ts() {
  return new Date().toLocaleString("sv-SE", { timeZone: "Europe/Vienna" }); // "2026-11-19 18:04:58"
}
function log(...a) {
  console.log(ts(), ...a);
}
/** Fehler inkl. err.cause in eine Zeile bringen (code, errno, syscall, hostname, address). */
function describeError(err) {
  if (!err) return "unbekannter Fehler";
  const parts = [err.code || err.name || "Error", err.message];
  let c = err.cause;
  let depth = 0;
  while (c && depth++ < 3) {
    const bits = [c.code, c.errno, c.syscall, c.hostname, c.address && `${c.address}:${c.port || ""}`, c.message]
      .filter((x) => x !== undefined && x !== null && x !== "");
    parts.push("cause=[" + bits.join(" ") + "]");
    c = c.cause;
  }
  if (Array.isArray(err.errors)) {
    parts.push("errors=[" + err.errors.map((e) => `${e.code} ${e.address || ""}:${e.port || ""}`).join(", ") + "]");
  }
  return parts.join(" ");
}
/** Kurzform für die Anzeige auf dem Kindle. */
function shortError(err) {
  return (err && (err.code || (err.cause && err.cause.code) || err.message)) || "Fehler";
}

// ─── HTTP-GET JSON mit Timeout ──────────────────────────────────────────────
function getJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("http:") ? http : https;
    const req = lib.get(
      url,
      { agent: lib === https ? agent : undefined, headers: { "User-Agent": "kindle-dashboard/2.0", Accept: "application/json" } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("error", reject);
        res.on("end", () => {
          clearTimeout(timer);
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const e = new Error(`HTTP ${res.statusCode}`);
            e.code = `HTTP_${res.statusCode}`;
            return reject(e);
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (e) {
            e.code = "BAD_JSON";
            reject(e);
          }
        });
      }
    );
    const timer = setTimeout(() => {
      const e = new Error(`Timeout nach ${TIMEOUT_MS} ms`);
      e.code = "ETIMEDOUT";
      req.destroy(e);
    }, TIMEOUT_MS);
    req.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJsonRetry(name, url, validate) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    const t0 = Date.now();
    try {
      const json = await getJson(url);
      const bad = validate(json);
      if (bad) {
        const e = new Error(bad);
        e.code = "BAD_DATA";
        throw e;
      }
      if (attempt > 0) log(`[${name}] ok nach Versuch ${attempt + 1}`);
      return json;
    } catch (err) {
      lastErr = err;
      log(`[${name}] Versuch ${attempt + 1}/${RETRY_DELAYS_MS.length + 1} fehlgeschlagen (${Date.now() - t0} ms): ${describeError(err)}`);
    }
  }
  throw lastErr;
}

// ─── Cache mit stale-while-revalidate ───────────────────────────────────────
function makeSource(name, url, ttlMs, validate) {
  const s = { name, data: null, at: 0, error: "", errorAt: 0, inflight: null };
  s.refresh = function () {
    if (!s.inflight) {
      s.inflight = getJsonRetry(name, url, validate)
        .then((json) => {
          s.data = json;
          s.at = Date.now();
          s.error = "";
        })
        .catch((err) => {
          s.error = shortError(err);
          s.errorAt = Date.now();
          log(`[${name}] alle Versuche fehlgeschlagen – ${s.data ? "liefere Cache von " + new Date(s.at).toLocaleTimeString("de-AT") : "kein Cache vorhanden"}`);
        })
        .finally(() => {
          s.inflight = null;
        });
    }
    return s.inflight;
  };
  /** Frische Daten holen, wenn nötig; mit Cache höchstens maxWait ms warten. */
  s.ensure = async function (maxWait) {
    if (s.data && Date.now() - s.at < ttlMs) return;
    // nach einem Fehler nicht bei jeder Anfrage sofort wieder 3 Versuche starten
    if (s.errorAt && Date.now() - s.errorAt < 10_000 && !s.inflight) return;
    const p = s.refresh();
    if (!s.data) return p; // ohne Cache voll warten
    await Promise.race([p, sleep(maxWait)]);
  };
  return s;
}

const wl = makeSource("WL", WL_URL, 20_000, (j) =>
  j && j.data && Array.isArray(j.data.monitors) ? null : "WL-Antwort ohne data.monitors"
);
const weather = makeSource("Wetter", WEATHER_URL, 10 * 60_000, (j) =>
  j && j.current ? null : "Wetter-Antwort ohne current"
);

async function getRaw() {
  await Promise.all([wl.ensure(MAX_WAIT_MS), weather.ensure(MAX_WAIT_MS)]);
  return {
    wl: wl.data,
    wlAt: wl.at || null,
    wlError: wl.error,
    weather: weather.data,
    weatherAt: weather.at || null,
    weatherError: weather.error,
  };
}

// ─── HTML ───────────────────────────────────────────────────────────────────
function page(body) {
  return (
    "<!DOCTYPE html>\n<html lang=\"de\"><head><meta charset=\"utf-8\">" +
    `<meta http-equiv="refresh" content="${REFRESH_SEC}">` +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<title>63A Mona-Lisa-Steiner-Weg</title><style>" + Dash.CSS + "</style></head><body>" +
    body +
    // JS-Fallback, falls meta refresh ausfällt (Seite funktioniert auch ganz ohne JS)
    `<script>setTimeout(function(){location.reload();},${(REFRESH_SEC + 15) * 1000});</script>` +
    "</body></html>"
  );
}

function send(res, status, type, body, extra) {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    ...extra,
  });
  res.end(body);
}

const STATIC = {
  "/pages/": ["index.html", "text/html; charset=utf-8"],
  "/pages/index.html": ["index.html", "text/html; charset=utf-8"],
  "/pages/core.js": ["core.js", "application/javascript; charset=utf-8"],
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const raw = await getRaw();
      return send(res, 200, "text/html; charset=utf-8", page(Dash.renderBody(Dash.buildModel(raw, Date.now()))));
    }
    if (url.pathname === "/api/raw") {
      return send(res, 200, "application/json; charset=utf-8", JSON.stringify(await getRaw()), {
        "Access-Control-Allow-Origin": "*",
      });
    }
    if (url.pathname === "/healthz") {
      const info = (s) => ({
        ageSec: s.at ? Math.round((Date.now() - s.at) / 1000) : null,
        lastError: s.error || null,
        lastErrorAt: s.errorAt ? new Date(s.errorAt).toISOString() : null,
      });
      return send(res, 200, "application/json", JSON.stringify({ wl: info(wl), weather: info(weather) }, null, 2));
    }
    if (url.pathname === "/favicon.ico") {
      res.writeHead(204);
      return res.end();
    }
    if (url.pathname === "/pages") {
      res.writeHead(301, { Location: "/pages/" });
      return res.end();
    }
    if (STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      return send(res, 200, type, fs.readFileSync(path.join(DIR, "docs", file)));
    }
    send(res, 404, "text/plain; charset=utf-8", "Nicht gefunden");
  } catch (err) {
    log("[HTTP] Fehler bei", url.pathname, describeError(err));
    send(res, 500, "text/plain; charset=utf-8", "Interner Fehler: " + shortError(err));
  }
});

server.listen(PORT, HOST, () => {
  log(`Dashboard läuft auf http://${HOST}:${PORT}/`);
  for (const [ifname, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal) log(`  Kindle-URL (${ifname}): http://${a.address}:${PORT}/`);
    }
  }
  // Cache vorwärmen
  wl.refresh();
  weather.refresh();
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log(`${sig} – beende`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
