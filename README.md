# Kindle E-Ink Dashboard – 63A Mona-Lisa-Steiner-Weg

Ein minimalistisches, für E-Ink optimiertes Web-Dashboard, das auf einem Kindle im Heimnetzwerk läuft.

## Features

| Feature | Detail |
|---|---|
| **Öffi-Echtzeitdaten** | Wiener Linien 63A ab Mona-Lisa-Steiner-Weg (Ri. Meidling Hauptstraße + Gesundheitszentrum Süd) |
| **Countdown** | Minuten bis Abfahrt oder `JETZT` |
| **Live/Plan** | LIVE-Badge wenn Echtzeitdaten verfügbar |
| **Störungen** | Kurzstörungen der WL-API |
| **Wetter** | Open-Meteo (kostenlos, kein API-Key): Temperatur, Gefühlt, Zustand, Min/Max, Wind |
| **Uhrzeit** | Große Digitaluhr + Datum (Europe/Vienna) |
| **Auto-Refresh** | alle 30 s via `<meta http-equiv="refresh">` + JS-Fallback |

## Voraussetzungen

- Node.js ≥ 18 (natives `fetch`)
- Heimnetzwerk-Zugang vom Kindle zum Server-Rechner

## Installation & Start

```bash
cd bus
npm install
node server.js
```

Dashboard ist dann unter `http://<IP-des-Servers>:3000` erreichbar.

## Kindle einrichten

1. Kindle-Browser öffnen (Experimental Browser)
2. URL eingeben: `http://192.168.x.x:3000` (eigene LAN-IP)
3. Die Seite lädt alle 30 Sekunden automatisch neu

## API-Details

| API | Cache | Auth |
|---|---|---|
| `wienerlinien.at/ogd_realtime/monitor` | 20 s | keine |
| `api.open-meteo.com` | 10 min | keine |

## Systemd-Service (Linux-Server)

```ini
# /etc/systemd/system/kindle-dashboard.service
[Unit]
Description=Kindle E-Ink Dashboard
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/bus
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable kindle-dashboard
sudo systemctl start kindle-dashboard
sudo journalctl -u kindle-dashboard -f
```

## RBL-Nummern anpassen

Falls die Haltestellen-IDs sich ändern, können diese über die [Wiener Linien OGD-Haltestellenliste](https://www.data.gv.at/katalog/dataset/wiener-linien-echtzeitdaten) nachgeschlagen werden. Die RBL-Nummern stehen in `server.js` in der Konstante `WL_RBL_IDS`.

## Projektstruktur

```
bus/
├── package.json
├── server.js       ← Haupt-Server (Express + SSR)
└── README.md
```
