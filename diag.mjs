// Diagnose: ruft WL + Open-Meteo auf verschiedene Arten ab und zeigt err.cause.
// Aufruf:  node diag.mjs
import dns from "node:dns";
import net from "node:net";
import https from "node:https";

const URLS = {
  WL: "https://www.wienerlinien.at/ogd_realtime/monitor?rbl=3890&rbl=3889&activateTrafficInfo=stoerungkurz",
  Wetter:
    "https://api.open-meteo.com/v1/forecast?latitude=48.1595&longitude=16.2957&current=temperature_2m&timezone=Europe%2FVienna&forecast_days=1",
};

function describe(err) {
  const c = err && err.cause;
  const parts = [err && err.name, err && err.message];
  if (c) {
    parts.push("| cause:", c.code || "", c.errno || "", c.syscall || "", c.hostname || "", c.address || "", c.port || "", c.message || "");
    if (c.errors) parts.push("| sub:", c.errors.map((e) => (e.code || "") + " " + (e.address || "") + ":" + (e.port || "")).join(", "));
  } else if (err && err.code) {
    parts.push("| code:", err.code);
  }
  return parts.filter(Boolean).join(" ");
}

async function viaFetch(url, ms) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    const txt = await r.text();
    return "OK  HTTP " + r.status + " " + txt.length + " B, " + (Date.now() - t0) + " ms, CORS=" + (r.headers.get("access-control-allow-origin") || "-");
  } catch (e) {
    return "ERR " + (Date.now() - t0) + " ms " + describe(e);
  }
}

function viaHttps(url, ms, family) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const req = https.get(url, { family, timeout: ms }, (res) => {
      const ip = res.socket && res.socket.remoteAddress;
      let n = 0;
      res.on("data", (d) => (n += d.length));
      res.on("end", () => resolve("OK  HTTP " + res.statusCode + " " + n + " B, " + (Date.now() - t0) + " ms, IP=" + ip));
    });
    req.on("timeout", () => req.destroy(new Error("timeout " + ms + " ms")));
    req.on("error", (e) => resolve("ERR " + (Date.now() - t0) + " ms " + describe(e)));
  });
}

async function lookups() {
  for (const host of ["www.wienerlinien.at", "api.open-meteo.com"]) {
    try {
      const all = await dns.promises.lookup(host, { all: true });
      console.log("  DNS", host, "->", all.map((a) => a.address + " (v" + a.family + ")").join(", "));
    } catch (e) {
      console.log("  DNS", host, "-> ERR", e.code);
    }
  }
}

console.log("Node", process.version, process.platform, "| Proxy-Env:", process.env.HTTPS_PROXY || process.env.https_proxy || "-");
await lookups();

for (const [name, url] of Object.entries(URLS)) {
  console.log("\n== " + name);
  console.log("  fetch default      ", await viaFetch(url, 15000));
  console.log("  https.get family=4 ", await viaHttps(url, 15000, 4));
  console.log("  https.get family=6 ", await viaHttps(url, 15000, 6));
}

dns.setDefaultResultOrder("ipv4first");
if (net.setDefaultAutoSelectFamily) net.setDefaultAutoSelectFamily(false);
console.log("\n-- nach ipv4first + autoSelectFamily=false --");
for (const [name, url] of Object.entries(URLS)) {
  console.log("  " + name.padEnd(7) + "fetch", await viaFetch(url, 15000));
}
