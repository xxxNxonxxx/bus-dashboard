/**
 * Cloudflare Worker: holt Wiener Linien + Open-Meteo und liefert beides mit CORS-Header.
 * Antwortformat = /api/raw des lokalen Servers: {wl, wlAt, wlError, weather, weatherAt, weatherError}
 *
 * Deploy: dash.cloudflare.com -> Workers & Pages -> Create -> "Hello World" Worker,
 * diesen Code einfügen, Deploy. URL dann in docs/index.html bei RELAY_URL eintragen.
 */
const WL_URL =
  "https://www.wienerlinien.at/ogd_realtime/monitor?rbl=3890&rbl=3889&activateTrafficInfo=stoerungkurz";
const WEATHER_URL =
  "https://api.open-meteo.com/v1/forecast?latitude=48.1595&longitude=16.2957" +
  "&current=temperature_2m,apparent_temperature,weathercode,windspeed_10m,winddirection_10m" +
  "&daily=temperature_2m_max,temperature_2m_min&timezone=Europe%2FVienna&forecast_days=1";

async function getJson(url, cacheTtl) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(10000),
        cf: { cacheTtl, cacheEverything: true },
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

export default {
  async fetch(request) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const [wl, weather] = await Promise.allSettled([getJson(WL_URL, 15), getJson(WEATHER_URL, 600)]);
    const now = Date.now();
    const body = {
      wl: wl.status === "fulfilled" ? wl.value : null,
      wlAt: wl.status === "fulfilled" ? now : null,
      wlError: wl.status === "rejected" ? String(wl.reason && wl.reason.message) : "",
      weather: weather.status === "fulfilled" ? weather.value : null,
      weatherAt: weather.status === "fulfilled" ? now : null,
      weatherError: weather.status === "rejected" ? String(weather.reason && weather.reason.message) : "",
    };
    return new Response(JSON.stringify(body), {
      headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  },
};
