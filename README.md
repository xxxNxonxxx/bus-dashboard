# Kindle E-Ink Dashboard – 63A Mona-Lisa-Steiner-Weg

Uhr + Datum (Europe/Vienna), Wiener Linien 63A in Echtzeit (Hero: Ri. Gesundheitszentrum Süd),
Gegenrichtung, Störungen und Wetter (Open-Meteo). Schwarz/Weiß, Refresh alle 30 s.

## Aufbau

| Datei | Zweck |
| --- | --- |
| `docs/core.js` | **Gemeinsamer Kern in reinem ES5**: Parsing, Filter, Wien-Zeit (manuelle CET/CEST), HTML-Rendering, CSS. Wird vom Server *und* vom Kindle-Browser benutzt. |
| `server.mjs` | Lokaler Server (Node ≥ 18, keine Dependencies). SSR-HTML für den Kindle, funktioniert ohne JS. |
| `docs/index.html` | GitHub-Pages-Variante (ES5, XMLHttpRequest), holt Daten über ein Relay. |
| `worker/relay.js` | Cloudflare Worker: WL + Wetter mit CORS-Header (nur für die Pages-Variante nötig). |
| `kindle-dashboard.service` | systemd-User-Service (Autostart). |
| `diag.mjs` | Netzwerk-Diagnose (fetch vs. https.get, IPv4/IPv6, `err.cause`, CORS-Header). |
| `test.mjs` | Tests (`node --test test.mjs`). |

## Lokaler Server (empfohlen)

```bash
node server.mjs                     # manuell
systemctl --user status kindle-dashboard     # als Service (Autostart, läuft dank Linger auch ohne Login)
systemctl --user restart kindle-dashboard    # nach Code-Änderungen
journalctl --user -u kindle-dashboard -f     # Logs
```

Endpunkte: `/` (Kindle), `/healthz` (Cache-Alter, letzte Fehler), `/api/raw` (JSON mit CORS),
`/pages/?relay=/api/raw` (Pages-Variante lokal testen).

Robustheit: IPv4-only, 15 s Timeout, 2 Retries (1 s / 3 s), Fehler mit `err.cause` geloggt.
Bei Fehlern wird der letzte gültige Stand ausgeliefert (Countdown wird nachgezogen, ab 90 s „VERALTET“).
Eine Kindle-Anfrage wartet höchstens 4 s auf frische Daten, sonst kommt der Cache.

Firewall (einmalig): `sudo ufw allow from 192.168.178.0/24 to any port 3000 proto tcp`

Kindle: Experimental Browser → `http://192.168.178.28:3000/`

## GitHub-Pages-Variante (ohne laufenden PC)

Die WL-API sendet **keinen** CORS-Header → direkter Browser-Aufruf von github.io geht nicht (getestet).
Open-Meteo erlaubt CORS. Daher Relay nötig:

1. dash.cloudflare.com → Workers & Pages → Create Worker → Code aus `worker/relay.js` einfügen → Deploy
2. Worker-URL in `docs/index.html` bei `RELAY_URL` eintragen (oder `?relay=<url>` an die Seiten-URL hängen)
3. `docs/` ins Repo pushen (Pages-Quelle `/docs`)

Fällt das Relay aus, zeigt die Seite den letzten Stand aus localStorage und holt das Wetter direkt.
