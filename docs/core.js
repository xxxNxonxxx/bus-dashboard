/*
 * Kindle-Dashboard – gemeinsamer Kern (reines ES5!)
 * Wird vom Node-Server (SSR) UND vom Kindle-Browser (docs/index.html) benutzt.
 * Kein let/const, keine Arrow-Functions, keine Template-Literals, kein ?. / ??,
 * kein Set, kein Intl. Bitte so lassen – der Kindle-Browser ist ein alter WebKit.
 *
 * Eingabe ("raw"): { wl: <WL-JSON>, wlAt: ms, wlError: str,
 *                    weather: <Open-Meteo-JSON>, weatherAt: ms, weatherError: str }
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) { module.exports = factory(); }
  else { root.Dash = factory(); }
}(this, function () {
  "use strict";

  var CFG = {
    line: "63A",
    primaryRbl: 3890,     // Ri. Gesundheitszentrum Süd
    secondaryRbl: 3889,   // Ri. Am Rosenhügel / Meidling
    primaryName: "Gesundheitszentrum Süd",
    secondaryName: "Am Rosenhügel",
    minCountdown: -1,
    primaryMax: 90,
    secondaryMax: 70,
    nextPrimary: 3,
    nextSecondary: 4,
    staleAfterSec: 90     // ab diesem Datenalter "VERALTET" anzeigen
  };

  var WEEKDAYS = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
  var MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli",
    "August", "September", "Oktober", "November", "Dezember"];

  var WMO = {
    0: "Klar", 1: "Überwiegend klar", 2: "Teilweise bewölkt", 3: "Bedeckt",
    45: "Nebel", 48: "Raureifnebel",
    51: "Leichter Nieselregen", 53: "Nieselregen", 55: "Starker Nieselregen",
    56: "Gefrierender Niesel", 57: "Starker gefr. Niesel",
    61: "Leichter Regen", 63: "Regen", 65: "Starker Regen",
    66: "Gefrierender Regen", 67: "Starker gefr. Regen",
    71: "Leichter Schneefall", 73: "Schneefall", 75: "Starker Schneefall",
    77: "Schneegriesel",
    80: "Leichte Regenschauer", 81: "Regenschauer", 82: "Heftige Regenschauer",
    85: "Schneeschauer", 86: "Starke Schneeschauer",
    95: "Gewitter", 96: "Gewitter mit Hagel", 99: "Schweres Gewitter mit Hagel"
  };

  var WIND_DIRS = ["N", "NO", "O", "SO", "S", "SW", "W", "NW"];

  // ---------------------------------------------------------------- Zeit (Europe/Vienna, manuell)
  // EU-Regel: Sommerzeit von letztem So im März 01:00 UTC bis letztem So im Oktober 01:00 UTC.
  function lastSundayUtc(year, month) {
    var d = new Date(Date.UTC(year, month + 1, 0, 1, 0, 0)); // letzter Tag des Monats, 01:00 UTC
    d.setUTCDate(d.getUTCDate() - d.getUTCDay());
    return d.getTime();
  }

  function viennaOffsetMin(ms) {
    var y = new Date(ms).getUTCFullYear();
    return (ms >= lastSundayUtc(y, 2) && ms < lastSundayUtc(y, 9)) ? 120 : 60;
  }

  function viennaParts(ms) {
    var off = viennaOffsetMin(ms);
    var d = new Date(ms + off * 60000);
    return {
      y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), wd: d.getUTCDay(),
      h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), dst: off === 120
    };
  }

  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function hhmm(ms) { var p = viennaParts(ms); return pad(p.h) + ":" + pad(p.mi); }
  function hhmmss(ms) { var p = viennaParts(ms); return pad(p.h) + ":" + pad(p.mi) + ":" + pad(p.s); }
  function dateLong(ms) {
    var p = viennaParts(ms);
    return WEEKDAYS[p.wd] + ", " + p.d + ". " + MONTHS[p.mo] + " " + p.y;
  }

  // "2026-11-19T18:02:00.000+0100" -> ms (alter WebKit kann "+0100" nicht parsen)
  var TS_RE = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d))?(?:\.\d+)?(Z|([+-])(\d\d):?(\d\d))?$/;
  function parseTs(str) {
    if (typeof str !== "string") { return null; }
    var m = TS_RE.exec(str);
    if (!m) { return null; }
    var ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
    if (m[7] && m[7] !== "Z") {
      var off = (+m[9]) * 60 + (+m[10]);
      ms -= (m[8] === "-" ? -off : off) * 60000;
    }
    return ms;
  }

  // ---------------------------------------------------------------- Helfer
  function isArray(x) { return Object.prototype.toString.call(x) === "[object Array]"; }
  function arr(x) { return isArray(x) ? x : []; }
  function get(obj, path) {
    var cur = obj;
    for (var i = 0; i < path.length; i++) {
      if (cur === null || cur === undefined) { return undefined; }
      cur = cur[path[i]];
    }
    return cur;
  }
  function trim(s) { return String(s === undefined || s === null ? "" : s).replace(/^\s+|\s+$/g, ""); }
  function esc(s) {
    return String(s === undefined || s === null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function num(x) { return (typeof x === "number" && !isNaN(x)) ? x : null; }
  function rnd(x) { return Math.round(x) || 0; } // kein "-0"

  // ---------------------------------------------------------------- Wiener Linien
  function parseWl(wl, wlAt, now) {
    var res = { primary: [], secondary: [], disruptions: [],
      primaryName: CFG.primaryName, secondaryName: CFG.secondaryName, hasData: false };
    var monitors = arr(get(wl, ["data", "monitors"]));
    var ageMin = wlAt ? Math.max(0, Math.floor((now - wlAt) / 60000)) : 0;
    var seen = {};

    function addDisruption(t) {
      t = trim(t);
      if (t && !seen[t]) { seen[t] = true; res.disruptions.push(t); }
    }

    for (var i = 0; i < monitors.length; i++) {
      var mon = monitors[i];
      var rbl = +get(mon, ["locationStop", "properties", "attributes", "rbl"]);
      var isPrimary = rbl === CFG.primaryRbl;
      var isSecondary = rbl === CFG.secondaryRbl;
      if (!isPrimary && !isSecondary) { continue; }
      var lines = arr(mon.lines);

      // Spezifikation: monitor.lines[0].trafficjam, falls Array
      if (lines[0] && isArray(lines[0].trafficjam)) {
        var tj = lines[0].trafficjam;
        for (var k = 0; k < tj.length; k++) {
          addDisruption(typeof tj[k] === "string" ? tj[k] : (tj[k] && (tj[k].title || tj[k].description)));
        }
      }

      for (var j = 0; j < lines.length; j++) {
        var line = lines[j];
        if (!line || line.name !== CFG.line) { continue; }
        res.hasData = true;
        var towards = trim(line.towards);
        if (towards) {
          if (isPrimary) { res.primaryName = towards; } else { res.secondaryName = towards; }
        }
        var deps = arr(get(line, ["departures", "departure"]));
        for (var d = 0; d < deps.length; d++) {
          var dt = deps[d] && deps[d].departureTime;
          if (!dt || num(dt.countdown) === null) { continue; }
          var cd = dt.countdown - ageMin;           // bei Cache-Alter nachziehen
          var max = isPrimary ? CFG.primaryMax : CFG.secondaryMax;
          if (cd < CFG.minCountdown || cd > max) { continue; }
          var live = !!dt.timeReal;
          var t = parseTs(dt.timeReal || dt.timePlanned);
          (isPrimary ? res.primary : res.secondary).push({
            countdown: cd, live: live, time: t !== null ? hhmm(t) : ""
          });
        }
      }
    }

    function byCd(a, b) { return a.countdown - b.countdown; }
    res.primary.sort(byCd);
    res.secondary.sort(byCd);

    var infos = arr(get(wl, ["data", "trafficInfos"]));
    for (var n = 0; n < infos.length; n++) {
      addDisruption(get(infos[n], ["attributes", "title"]) || (infos[n] && infos[n].title));
    }
    return res;
  }

  // ---------------------------------------------------------------- Wetter
  function windDir(deg) {
    if (num(deg) === null) { return ""; }
    return WIND_DIRS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
  }

  function parseWeather(w) {
    var c = w && w.current;
    if (!c || num(c.temperature_2m) === null) { return null; }
    var maxT = arr(get(w, ["daily", "temperature_2m_max"]))[0];
    var minT = arr(get(w, ["daily", "temperature_2m_min"]))[0];
    var code = num(c.weathercode !== undefined ? c.weathercode : c.weather_code);
    return {
      temp: rnd(c.temperature_2m),
      feels: num(c.apparent_temperature) !== null ? rnd(c.apparent_temperature) : null,
      text: code !== null ? (WMO[code] || ("Code " + code)) : "",
      min: num(minT) !== null ? rnd(minT) : null,
      max: num(maxT) !== null ? rnd(maxT) : null,
      wind: num(c.windspeed_10m) !== null ? rnd(c.windspeed_10m) : null,
      windDir: windDir(c.winddirection_10m)
    };
  }

  // ---------------------------------------------------------------- Modell
  function buildModel(raw, now) {
    raw = raw || {};
    var wl = parseWl(raw.wl, raw.wlAt, now);
    var wlAge = raw.wlAt ? Math.round((now - raw.wlAt) / 1000) : null;
    return {
      now: now,
      time: hhmm(now),
      date: dateLong(now),
      wl: wl,
      wlOk: wl.hasData,
      wlAgeSec: wlAge,
      wlStale: wlAge !== null && wlAge > CFG.staleAfterSec,
      wlError: raw.wlError || "",
      weather: parseWeather(raw.weather),
      weatherError: raw.weatherError || ""
    };
  }

  // ---------------------------------------------------------------- Rendering
  function cdText(cd) { return cd <= 0 ? "JETZT" : String(cd); }
  function badge(live) {
    return live ? '<span class="b live">LIVE</span>' : '<span class="b plan">PLAN</span>';
  }
  function deg(v) { return v === null ? "–" : v + "°"; }

  function rows(list) {
    if (!list.length) { return '<tr><td class="none" colspan="3">keine Abfahrten</td></tr>'; }
    var h = "";
    for (var i = 0; i < list.length; i++) {
      var d = list[i];
      h += "<tr><td class=\"cd\">" + (d.countdown <= 0 ? "JETZT" : d.countdown + " min") + "</td>" +
        "<td class=\"tm\">" + esc(d.time) + "</td><td class=\"bd\">" + badge(d.live) + "</td></tr>";
    }
    return h;
  }

  function fmtAge(sec) {
    if (sec === null) { return "–"; }
    if (sec < 90) { return sec + " s"; }
    return Math.round(sec / 60) + " min";
  }

  function renderBody(m) {
    var h = "";

    // Kopf: Uhr links, Wetter rechts (Tabelle statt Flexbox – alter WebKit)
    h += '<table class="head"><tr><td class="clock">' +
      '<div class="time">' + esc(m.time) + '</div>' +
      '<div class="date">' + esc(m.date) + "</div></td>";
    h += '<td class="wx">';
    if (m.weather) {
      var w = m.weather;
      h += '<div class="wxtemp">' + deg(w.temp) + "</div>" +
        '<div class="wxtext">' + esc(w.text) + "</div>" +
        '<div class="wxdet">gefühlt ' + deg(w.feels) + "<br>" +
        "min " + deg(w.min) + " / max " + deg(w.max) + "<br>" +
        "Wind " + (w.wind === null ? "–" : w.wind + " km/h") + " " + esc(w.windDir) + "</div>";
    } else {
      h += '<div class="wxdet">Wetter nicht verfügbar' +
        (m.weatherError ? "<br>(" + esc(m.weatherError) + ")" : "") + "</div>";
    }
    h += "</td></tr></table>";

    // Hero
    var p = m.wl.primary;
    h += '<div class="hero"><div class="herohead"><span class="ln">' + esc(CFG.line) + "</span> Ri. " +
      esc(m.wl.primaryName) + "</div>";
    if (p.length) {
      var first = p[0];
      h += '<div class="big' + (first.countdown <= 0 ? " now" : "") + '">' + cdText(first.countdown) +
        (first.countdown > 0 ? '<span class="unit">min</span>' : "") + "</div>" +
        '<div class="herofoot">ab ' + esc(first.time) + " " + badge(first.live) + "</div>";
    } else {
      h += '<div class="big small">' + (m.wlOk ? "keine Abfahrt" : "keine Daten") + "</div>" +
        (m.wlError ? '<div class="herofoot">' + esc(m.wlError) + "</div>" : "");
    }
    h += "</div>";

    // Listen
    h += '<div class="sec"><div class="sechead">Danach Ri. ' + esc(m.wl.primaryName) + "</div>" +
      '<table class="list">' + rows(p.slice(1, 1 + CFG.nextPrimary)) + "</table></div>";
    h += '<div class="sec"><div class="sechead">Gegenrichtung Ri. ' + esc(m.wl.secondaryName) + "</div>" +
      '<table class="list">' + rows(m.wl.secondary.slice(0, CFG.nextSecondary)) + "</table></div>";

    // Störungen
    if (m.wl.disruptions.length) {
      h += '<div class="dis"><div class="dishead">! STÖRUNG</div>';
      for (var i = 0; i < m.wl.disruptions.length; i++) {
        h += "<div>" + esc(m.wl.disruptions[i]) + "</div>";
      }
      h += "</div>";
    }

    // Fußzeile
    h += '<div class="foot">Stand ' + hhmmss(m.now) + " · Echtzeitdaten " + fmtAge(m.wlAgeSec) + " alt";
    if (m.wlStale) { h += ' · <b class="inv">VERALTET</b>'; }
    if (m.wlError && m.wlOk) { h += " · Fehler: " + esc(m.wlError); }
    h += "</div>";
    return h;
  }

  var CSS =
    "*{margin:0;padding:0}" +
    "html,body{background:#fff;color:#000}" +
    "body{font-family:Helvetica,Arial,sans-serif;padding:14px 18px;-webkit-text-size-adjust:none}" +
    "table{border-collapse:collapse;width:100%}" +
    ".head td{vertical-align:top}" +
    ".clock .time{font-size:110px;font-weight:bold;line-height:1;letter-spacing:-3px}" +
    ".clock .date{font-size:24px;font-weight:bold;margin-top:6px}" +
    ".wx{text-align:right;width:40%}" +
    ".wxtemp{font-size:64px;font-weight:bold;line-height:1}" +
    ".wxtext{font-size:24px;font-weight:bold;margin-top:4px}" +
    ".wxdet{font-size:19px;margin-top:4px;line-height:1.3}" +
    ".hero{border:5px solid #000;margin-top:14px;padding:10px 14px 12px;text-align:center}" +
    ".herohead{font-size:26px;font-weight:bold;text-align:left}" +
    ".ln{background:#000;color:#fff;padding:0 8px}" +
    ".big{font-size:190px;font-weight:bold;line-height:1;letter-spacing:-6px;margin:4px 0}" +
    ".big.now{font-size:150px;letter-spacing:0;margin:24px 0 18px}" +
    ".big.small{font-size:64px;letter-spacing:0;margin:24px 0}" +
    ".unit{font-size:44px;letter-spacing:0;margin-left:12px}" +
    ".herofoot{font-size:30px;font-weight:bold}" +
    ".b{display:inline-block;font-size:0.7em;font-weight:bold;padding:1px 7px;border:2px solid #000;vertical-align:middle}" +
    ".b.live{background:#000;color:#fff}" +
    ".b.plan{background:#fff;color:#000}" +
    ".sec{margin-top:14px}" +
    ".sechead{font-size:22px;font-weight:bold;border-bottom:3px solid #000;padding-bottom:3px}" +
    ".list td{font-size:28px;padding:5px 0;border-bottom:1px solid #000}" +
    ".list .cd{font-weight:bold;width:40%}" +
    ".list .tm{width:30%}" +
    ".list .bd{text-align:right;font-size:24px}" +
    ".list .none{font-size:22px}" +
    ".dis{margin-top:14px;border:3px solid #000;padding:8px 10px;font-size:20px}" +
    ".dishead{font-weight:bold;font-size:22px}" +
    ".foot{margin-top:12px;font-size:16px}" +
    ".inv{background:#000;color:#fff;padding:0 4px}" +
    // kleine / ältere Kindles (600x800)
    "@media (max-width:680px),(max-height:900px){" +
    "body{padding:8px 12px}" +
    ".clock .time{font-size:80px;letter-spacing:-2px}" +
    ".clock .date{font-size:19px}" +
    ".wxtemp{font-size:48px}.wxtext{font-size:20px}.wxdet{font-size:16px}" +
    ".hero{margin-top:8px;padding:6px 10px 8px;border-width:4px}" +
    ".herohead{font-size:21px}" +
    ".big{font-size:140px;letter-spacing:-4px;margin:0}" +
    ".big.now{font-size:104px;letter-spacing:0;margin:12px 0 10px}" +
    ".unit{font-size:34px}.herofoot{font-size:24px}" +
    ".sec{margin-top:8px}.sechead{font-size:18px}" +
    ".list td{font-size:22px;padding:2px 0}.list .bd{font-size:18px}" +
    ".dis{margin-top:8px;font-size:17px;padding:5px 8px}" +
    ".foot{margin-top:6px;font-size:14px}}";

  return {
    CFG: CFG, CSS: CSS,
    buildModel: buildModel, renderBody: renderBody,
    // für Tests
    viennaParts: viennaParts, viennaOffsetMin: viennaOffsetMin, parseTs: parseTs,
    windDir: windDir, parseWl: parseWl, parseWeather: parseWeather, esc: esc
  };
}));
