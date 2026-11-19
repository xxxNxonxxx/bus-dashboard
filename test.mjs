// node test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const Dash = createRequire(import.meta.url)("./docs/core.js");

test("Wien-Zeit inkl. Sommerzeit-Umstellung", () => {
  // Vergleich mit Intl (nur im Test – im Kindle gibt es das nicht)
  const fmt = new Intl.DateTimeFormat("de-AT", { timeZone: "Europe/Vienna", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const start = Date.UTC(2024, 0, 1);
  for (let ms = start; ms < Date.UTC(2031, 0, 1); ms += 37 * 60_000 * 7) {
    const p = Dash.viennaParts(ms);
    const want = fmt.format(new Date(ms));
    const got = String(p.h).padStart(2, "0") + ":" + String(p.mi).padStart(2, "0");
    assert.equal(got, want, new Date(ms).toISOString());
  }
  // Grenzen exakt
  assert.equal(Dash.viennaOffsetMin(Date.UTC(2026, 2, 29, 0, 59)), 60);
  assert.equal(Dash.viennaOffsetMin(Date.UTC(2026, 2, 29, 1, 0)), 120);
  assert.equal(Dash.viennaOffsetMin(Date.UTC(2026, 9, 25, 0, 59)), 120);
  assert.equal(Dash.viennaOffsetMin(Date.UTC(2026, 9, 25, 1, 0)), 60);
});

test("parseTs mit +0100, +01:00, Z", () => {
  const want = Date.UTC(2026, 10, 19, 17, 2);
  assert.equal(Dash.parseTs("2026-11-19T18:02:00.000+0100"), want);
  assert.equal(Dash.parseTs("2026-11-19T18:02:00+01:00"), want);
  assert.equal(Dash.parseTs("2026-11-19T17:02:00Z"), want);
  assert.equal(Dash.parseTs("quatsch"), null);
});

test("Windrichtung", () => {
  assert.deepEqual([0, 22, 23, 46, 90, 135, 180, 225, 270, 315, 359, -10].map(Dash.windDir),
    ["N", "N", "NO", "NO", "O", "SO", "S", "SW", "W", "NW", "N", "N"]);
});

function dep(cd, real = true) {
  return { departureTime: { timePlanned: "2026-11-19T18:02:00.000+0100", timeReal: real ? "2026-11-19T18:03:00.000+0100" : undefined, countdown: cd } };
}
function mon(rbl, lines) {
  return { locationStop: { properties: { attributes: { rbl } } }, lines };
}
const NOW = Date.UTC(2026, 10, 19, 17, 0);

test("Filter, Sortierung, Hero/JETZT, LIVE/PLAN, Störungen", () => {
  const wl = {
    data: {
      monitors: [
        mon(3890, [
          { name: "63A", towards: " Gesundheitszentrum Süd ", trafficjam: ["Stau Altmannsdorfer Str."],
            departures: { departure: [dep(5), dep(0, false), dep(-2), dep(91), dep(90), dep(12)] } },
          { name: "N62", towards: "x", departures: { departure: [dep(1)] } },
        ]),
        mon(3889, [
          { name: "63A", towards: "Am Rosenhügel  ", trafficjam: false,
            departures: { departure: [dep(71), dep(70), dep(-1), dep(3)] } },
        ]),
        mon(9999, [{ name: "63A", departures: { departure: [dep(2)] } }]),
      ],
      trafficInfos: [{ attributes: { title: "Umleitung 63A" } }, { title: "Umleitung 63A" }],
    },
  };
  const m = Dash.buildModel({ wl, wlAt: NOW, weather: null }, NOW);
  assert.deepEqual(m.wl.primary.map((d) => d.countdown), [0, 5, 12, 90]);
  assert.deepEqual(m.wl.secondary.map((d) => d.countdown), [-1, 3, 70]);
  assert.equal(m.wl.primaryName, "Gesundheitszentrum Süd");
  assert.equal(m.wl.secondaryName, "Am Rosenhügel");
  assert.equal(m.wl.primary[0].live, false);
  assert.equal(m.wl.primary[1].time, "18:03");
  assert.deepEqual(m.wl.disruptions, ["Stau Altmannsdorfer Str.", "Umleitung 63A"]);

  const html = Dash.renderBody(m);
  assert.match(html, /<div class="big now">JETZT<\/div>/);
  assert.match(html, /ab 18:02 <span class="b plan">PLAN/);
  assert.match(html, /Wetter nicht verfügbar/);
  // 3 Folgeabfahrten primär + 3 sekundär (max 4)
  assert.equal((html.match(/<tr><td class="cd">/g) || []).length, 6);
});

test("Veralteter Cache: Countdown wird nachgezogen und markiert", () => {
  const wl = { data: { monitors: [mon(3890, [{ name: "63A", towards: "G", departures: { departure: [dep(3), dep(10)] } }])] } };
  const m = Dash.buildModel({ wl, wlAt: NOW - 5 * 60_000 }, NOW);
  assert.deepEqual(m.wl.primary.map((d) => d.countdown), [-1, 5].slice(1)); // 3-5=-2 fällt raus
  assert.equal(m.wlStale, true);
  assert.match(Dash.renderBody(m), /VERALTET/);
});

test("Keine Daten / Fehlertext wird escaped", () => {
  const m = Dash.buildModel({ wlError: "<ECONNRESET>" }, NOW);
  const html = Dash.renderBody(m);
  assert.match(html, /keine Daten/);
  assert.match(html, /&lt;ECONNRESET&gt;/);
});

test("Wetter", () => {
  const w = Dash.parseWeather({
    current: { temperature_2m: 6.6, apparent_temperature: 3.2, weathercode: 61, windspeed_10m: 14.4, winddirection_10m: 230 },
    daily: { temperature_2m_max: [8.9], temperature_2m_min: [-0.4] },
  });
  assert.deepEqual(w, { temp: 7, feels: 3, text: "Leichter Regen", min: 0, max: 9, wind: 14, windDir: "SW" });
});
