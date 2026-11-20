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
    nextPrimary: 2,
    nextSecondary: 2,
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
      code: code,
      temp: rnd(c.temperature_2m),
      feels: num(c.apparent_temperature) !== null ? rnd(c.apparent_temperature) : null,
      text: code !== null ? (WMO[code] || ("Code " + code)) : "",
      min: num(minT) !== null ? rnd(minT) : null,
      max: num(maxT) !== null ? rnd(maxT) : null,
      wind: num(c.windspeed_10m) !== null ? rnd(c.windspeed_10m) : null,
      windDir: windDir(c.winddirection_10m)
    };
  }

  // ---------------------------------------------------------------- Outfit-Figur
  function inList(x, list) {
    for (var i = 0; i < list.length; i++) { if (list[i] === x) { return true; } }
    return false;
  }
  var RAIN = [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99];
  var SNOW = [71, 73, 75, 77, 85, 86];

  /** Was soll man anziehen? Basis: gefühlte Temperatur + Wettercode + Tageszeit (Wien). */
  function outfit(w, now) {
    var t = w.feels !== null ? w.feels : w.temp;
    var p = viennaParts(now);
    var day = p.h >= 8 && p.h < 19;
    var o = {
      level: t <= 0 ? "winter" : t <= 7 ? "warm" : t <= 13 ? "jacket" : t <= 18 ? "pulli" : t <= 23 ? "shirt" : "hot",
      rain: inList(w.code, RAIN),
      snow: inList(w.code, SNOW),
      sun: day && (w.code === 0 || w.code === 1)
    };
    var items = {
      winter: ["Winterjacke", "Mütze", "Schal", "Handschuhe"],
      warm: ["Warme Jacke", "Mütze", "Schal"],
      jacket: ["Jacke"],
      pulli: ["Pulli oder leichte Jacke"],
      shirt: ["T-Shirt", "lange Hose"],
      hot: ["T-Shirt", "kurze Hose"]
    }[o.level].slice(0);
    if (o.rain) { items.push("Regenschirm", "Gummistiefel"); }
    if (o.snow) { items.push("Winterstiefel"); }
    if (o.sun && (o.level === "shirt" || o.level === "hot")) { items.push("Sonnenbrille"); }
    if (o.sun && o.level === "hot") { items.push("Kappe"); }
    o.text = items.join(", ");
    return o;
  }

  /** Süße Figur als SVG (schwarz/weiß/grau, E-Ink-tauglich). viewBox 120x182. */
  function figureSvg(o) {
    var S = ' stroke="#000" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"';
    var lv = o.level;
    var longSleeve = lv !== "shirt" && lv !== "hot";
    var top = { winter: "#333", warm: "#555", jacket: "#777", pulli: "#bbb", shirt: "#fff", hot: "#fff" }[lv];
    var boots = o.rain || o.snow;
    var s = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 182" width="120" height="182">';

    // Wetter-Deko hinten
    if (o.rain) {
      var drops = [[10, 70], [16, 110], [106, 84], [112, 124], [8, 146]];
      for (var i = 0; i < drops.length; i++) {
        s += '<path d="M' + drops[i][0] + " " + drops[i][1] + " q-4 7 0 9 q4 -2 0 -9 z\" fill=\"#000\"/>";
      }
    }
    if (o.snow) {
      var fl = [[12, 40], [108, 50], [10, 120], [110, 140], [18, 80]];
      for (var k = 0; k < fl.length; k++) {
        var x = fl[k][0], y = fl[k][1];
        s += '<path d="M' + (x - 5) + " " + y + " h10 M" + x + " " + (y - 5) + " v10 M" + (x - 4) + " " + (y - 4) +
          " l8 8 M" + (x + 4) + " " + (y - 4) + ' l-8 8" stroke="#000" stroke-width="2"/>';
      }
    }
    if (o.sun && !o.rain) {
      s += '<circle cx="14" cy="16" r="7" fill="#fff"' + S + "/>" +
        '<path d="M14 2 v4 M14 26 v4 M0 16 h4 M24 16 h4 M4 6 l3 3 M24 6 l-3 3 M4 26 l3 -3 M24 26 l-3 -3"' + S + "/>";
    }

    s += '<g transform="translate(0,12)">';
    // Beine + Schuhe
    var legFill = lv === "hot" ? "#fff" : "#555";
    s += '<rect x="41" y="118" width="15" height="34" rx="5" fill="' + legFill + '"' + S + "/>" +
      '<rect x="64" y="118" width="15" height="34" rx="5" fill="' + legFill + '"' + S + "/>";
    if (lv === "hot") { // kurze Hose
      s += '<rect x="38" y="114" width="44" height="18" rx="5" fill="#555"' + S + "/>";
    }
    if (boots) {
      s += '<rect x="38" y="136" width="20" height="22" rx="5" fill="#000"' + S + "/>" +
        '<rect x="62" y="136" width="20" height="22" rx="5" fill="#000"' + S + "/>";
    } else {
      s += '<ellipse cx="47" cy="154" rx="11" ry="6" fill="#000"' + S + "/>" +
        '<ellipse cx="73" cy="154" rx="11" ry="6" fill="#000"' + S + "/>";
    }
    // Arme
    if (longSleeve) {
      s += '<rect x="20" y="80" width="16" height="38" rx="8" fill="' + top + '"' + S + "/>" +
        '<rect x="84" y="80" width="16" height="38" rx="8" fill="' + top + '"' + S + "/>";
    } else {
      s += '<rect x="22" y="84" width="13" height="34" rx="6" fill="#fff"' + S + "/>" +
        '<rect x="85" y="84" width="13" height="34" rx="6" fill="#fff"' + S + "/>" +
        '<rect x="20" y="78" width="17" height="16" rx="6" fill="' + top + '"' + S + "/>" +
        '<rect x="83" y="78" width="17" height="16" rx="6" fill="' + top + '"' + S + "/>";
    }
    // Oberkörper
    var bw = lv === "winter" ? 54 : 48;
    s += '<rect x="' + (60 - bw / 2) + '" y="74" width="' + bw + '" height="50" rx="14" fill="' + top + '"' + S + "/>";
    if (lv === "winter") { // Steppjacke
      s += '<path d="M36 90 h48 M36 104 h48" stroke="#fff" stroke-width="2"/>';
    }
    if (lv === "winter" || lv === "warm" || lv === "jacket") { // Reißverschluss
      s += '<path d="M60 76 v46" stroke="#fff" stroke-width="2.5"/>';
    }
    if (lv === "pulli") { // Strickmuster
      s += '<path d="M40 96 l5 -5 l5 5 l5 -5 l5 5 l5 -5 l5 5 l5 -5 l5 5" fill="none" stroke="#000" stroke-width="2"/>';
    }
    if (lv === "shirt" || lv === "hot") { // Herz aufs T-Shirt
      s += '<path d="M60 108 l-8 -8 a4.5 4.5 0 0 1 8 -5 a4.5 4.5 0 0 1 8 5 z" fill="#000"/>';
    }
    // Regenschirm-Stiel (vor den Händen)
    if (o.rain) {
      s += '<path d="M97 4 V124 q0 8 -7 6"' + ' fill="none" stroke="#000" stroke-width="3.5" stroke-linecap="round"/>';
    }
    // Hände (Handschuhe schwarz)
    var hand = lv === "winter" ? "#000" : "#fff";
    s += '<circle cx="28" cy="120" r="7" fill="' + hand + '"' + S + "/>" +
      '<circle cx="92" cy="120" r="7" fill="' + hand + '"' + S + "/>";
    // Kopf
    s += '<circle cx="60" cy="44" r="31" fill="#fff"' + S + "/>" +
      '<circle cx="49" cy="46" r="4.5" fill="#000"/><circle cx="71" cy="46" r="4.5" fill="#000"/>' +
      '<circle cx="50.5" cy="44.5" r="1.5" fill="#fff"/><circle cx="72.5" cy="44.5" r="1.5" fill="#fff"/>' +
      '<ellipse cx="41" cy="56" rx="5" ry="3" fill="#bbb"/><ellipse cx="79" cy="56" rx="5" ry="3" fill="#bbb"/>' +
      '<path d="M53 58 q7 7 14 0" fill="none" stroke="#000" stroke-width="2.5" stroke-linecap="round"/>';
    if (o.sun && (lv === "shirt" || lv === "hot")) { // Sonnenbrille
      s += '<rect x="40" y="40" width="16" height="11" rx="4" fill="#000"/><rect x="64" y="40" width="16" height="11" rx="4" fill="#000"/>' +
        '<path d="M56 44 h8" stroke="#000" stroke-width="2.5"/>';
    }
    // Kopfbedeckung
    if (lv === "winter" || lv === "warm") { // Bommelmütze
      s += '<path d="M29 38 q31 -44 62 0 z" fill="#555"' + S + "/>" +
        '<rect x="27" y="32" width="66" height="11" rx="5" fill="#000"' + S + "/>" +
        '<circle cx="60" cy="6" r="7" fill="#fff"' + S + "/>";
    } else if (o.sun && lv === "hot") { // Kappe
      s += '<path d="M31 34 q29 -36 58 0 z" fill="#000"' + S + "/>" +
        '<path d="M86 33 q16 -2 20 4 h-22 z" fill="#000"' + S + "/>";
    }
    // Schal
    if (lv === "winter" || lv === "warm") {
      s += '<rect x="36" y="70" width="48" height="11" rx="5" fill="#fff"' + S + "/>" +
        '<path d="M46 71 v9 M56 71 v9 M66 71 v9 M76 71 v9" stroke="#000" stroke-width="3"/>' +
        '<rect x="66" y="76" width="11" height="24" rx="3" fill="#fff"' + S + "/>" +
        '<path d="M66 88 h11" stroke="#000" stroke-width="3"/>';
    }
    s += "</g>";
    // Regenschirm-Dach (ganz oben)
    if (o.rain) {
      s += '<path d="M8 30 Q60 -18 112 30 Q99 22 86 30 Q73 22 60 30 Q47 22 34 30 Q21 22 8 30 Z" fill="#000"' + S + "/>";
    }
    s += "</svg>";
    return s;
  }

  function figureImg(o) {
    return '<img class="fig" width="120" height="182" alt="" src="data:image/svg+xml;charset=utf-8,' +
      encodeURIComponent(figureSvg(o)) + '">';
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

    // Kopf: große Uhr über die volle Breite
    h += '<div class="clock"><div class="time">' + esc(m.time) + '</div>' +
      '<div class="date">' + esc(m.date) + "</div></div>";

    // Wetter-Band: Figur links, Werte rechts (Tabelle statt Flexbox – alter WebKit)
    if (m.weather) {
      var w = m.weather;
      var o = outfit(w, m.now);
      h += '<table class="wxband"><tr><td class="figcell">' + figureImg(o) + "</td>" +
        '<td class="wxinfo"><div class="wxline"><span class="wxtemp">' + deg(w.temp) + "</span> " +
        '<span class="wxtext">' + esc(w.text) + "</span></div>" +
        '<div class="wxdet">gefühlt ' + deg(w.feels) + " · min " + deg(w.min) + " / max " + deg(w.max) +
        "<br>Wind " + (w.wind === null ? "–" : w.wind + " km/h") + " " + esc(w.windDir) + "</div>" +
        '<div class="wear">Anziehen: ' + esc(o.text) + "</div></td></tr></table>";
    } else {
      h += '<div class="wxdet">Wetter nicht verfügbar' +
        (m.weatherError ? " (" + esc(m.weatherError) + ")" : "") + "</div>";
    }

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
    ".clock{text-align:center}" +
    ".clock .time{font-size:190px;font-weight:bold;line-height:0.92;letter-spacing:-6px}" +
    ".clock .date{font-size:28px;font-weight:bold;margin-top:2px}" +
    ".wxband{margin-top:6px;border-top:3px solid #000;border-bottom:3px solid #000}" +
    ".wxband td{vertical-align:middle;padding:2px 0}" +
    ".figcell{width:118px}" +
    ".fig{display:block;width:112px;height:170px}" +
    ".wxinfo{padding-left:14px !important}" +
    ".wxtemp{font-size:60px;font-weight:bold;line-height:1}" +
    ".wxtext{font-size:28px;font-weight:bold}" +
    ".wxdet{font-size:20px;margin-top:4px;line-height:1.3}" +
    ".wear{font-size:21px;font-weight:bold;margin-top:6px;line-height:1.25}" +
    ".hero{border:5px solid #000;margin-top:10px;padding:6px 14px 8px;text-align:center}" +
    ".herohead{font-size:26px;font-weight:bold;text-align:left}" +
    ".ln{background:#000;color:#fff;padding:0 8px}" +
    ".big{font-size:150px;font-weight:bold;line-height:1;letter-spacing:-5px;margin:0}" +
    ".big.now{font-size:120px;letter-spacing:0;margin:10px 0 8px}" +
    ".big.small{font-size:64px;letter-spacing:0;margin:24px 0}" +
    ".unit{font-size:44px;letter-spacing:0;margin-left:12px}" +
    ".herofoot{font-size:30px;font-weight:bold}" +
    ".b{display:inline-block;font-size:0.7em;font-weight:bold;padding:1px 7px;border:2px solid #000;vertical-align:middle}" +
    ".b.live{background:#000;color:#fff}" +
    ".b.plan{background:#fff;color:#000}" +
    ".sec{margin-top:10px}" +
    ".sechead{font-size:22px;font-weight:bold;border-bottom:3px solid #000;padding-bottom:3px}" +
    ".list td{font-size:28px;padding:3px 0;border-bottom:1px solid #000}" +
    ".list .cd{font-weight:bold;width:40%}" +
    ".list .tm{width:30%}" +
    ".list .bd{text-align:right;font-size:24px}" +
    ".list .none{font-size:22px}" +
    ".dis{margin-top:10px;border:3px solid #000;padding:8px 10px;font-size:20px}" +
    ".dishead{font-weight:bold;font-size:22px}" +
    ".foot{margin-top:8px;font-size:16px}" +
    ".inv{background:#000;color:#fff;padding:0 4px}" +
    // kleine / ältere Kindles (600x800)
    "@media (max-width:680px),(max-height:900px){" +
    "body{padding:8px 12px}" +
    ".clock .time{font-size:140px;letter-spacing:-4px}" +
    ".clock .date{font-size:20px}" +
    ".wxband{margin-top:6px}.wxband td{padding:3px 0}" +
    ".figcell{width:78px}.fig{width:72px;height:109px}" +
    ".wxinfo{padding-left:10px !important}" +
    ".wxtemp{font-size:42px}.wxtext{font-size:21px}.wxdet{font-size:16px}.wear{font-size:17px;margin-top:3px}" +
    ".hero{margin-top:8px;padding:6px 10px 8px;border-width:4px}" +
    ".herohead{font-size:21px}" +
    ".big{font-size:120px;letter-spacing:-4px;margin:0}" +
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
    windDir: windDir, parseWl: parseWl, parseWeather: parseWeather, esc: esc,
    outfit: outfit, figureSvg: figureSvg
  };
}));
