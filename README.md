# 📚 Buchclub

Gemeinsame App für unseren Buchclub – installierbar als App auf iPhone und Android (Web-App), ohne Build-Schritt und ohne externe Abhängigkeiten.

## Funktionen

- **Mitglieder** – Beitritt per Einladungscode, die erste Person wird automatisch Admin. Admins können weitere Admins ernennen, Mitglieder entfernen und den Code erneuern.
- **Buchvorschläge** – Suche im Internet (Open Library, Fallback Google Books) mit Cover, Autor:in, Jahr und Seitenzahl; Bücher lassen sich auch manuell eintragen.
- **Abstimmung & Kommentare** – 👍 pro Mitglied und Buch, Diskussion unter jedem Vorschlag.
- **Leseliste (Admin)** – Vorschläge in eine Warteschlange aufnehmen, per ↑/↓ sortieren, „Jetzt lesen“ setzt das aktuelle Buch (das vorherige wird automatisch „gelesen“).
- **Termine** – Datum, Uhrzeit, Ort, Notizen, verknüpft mit dem Buch (standardmäßig dem aktuellen). Zu-/Absagen pro Mitglied.
- **Kalender**
  - **Abo-Link** (`/calendar.ics?token=…`): Apple Kalender, Google Kalender und Android abonnieren alle Termine und bekommen Änderungen automatisch.
  - Pro Termin: `.ics`-Download (Apple/Android) und „Zu Google Kalender hinzufügen“.

## Starten

Benötigt Node.js ≥ 22.13 (nutzt das eingebaute `node:sqlite`).

```sh
npm start            # http://localhost:3000
npm test             # API-Tests
```

Beim ersten Aufruf „Club gründen“ – dieses Konto wird Admin. Danach den Einladungscode unter **Club** weitergeben.

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `PORT` | `3000` | HTTP-Port |
| `DB_PATH` | `data/buchclub.db` | SQLite-Datei (regelmäßig sichern!) |
| `TRUST_PROXY` | – | `1` hinter einem Proxy (Fly, Render, Caddy): echte Client-IP für die Login-Drosselung |
| `HOST` | `0.0.0.0` | Bind-Adresse |
| `BASE_URL` | aus der Anfrage | öffentliche URL, wird in Kalendereinträge geschrieben |

### Docker

```sh
docker build -t buchclub .
docker run -d -p 3000:3000 -v buchclub-data:/data buchclub
```

## Online stellen

Damit das **Kalender-Abo** auf den Handys funktioniert, muss die App per **HTTPS** im Internet erreichbar sein. Die Daten liegen in einer SQLite-Datei, daher braucht der Hoster ein **dauerhaftes Volume** unter `/data`.

**Fly.io** (`fly.toml` liegt bei, ca. 2–4 €/Monat, Konto mit Karte nötig):

```sh
fly auth login
fly launch --no-deploy --copy-config
fly volumes create buchclub_data --size 1 --region fra
fly deploy
```

**Render** (`render.yaml` liegt bei): Dashboard → New → Blueprint → Repository wählen. Das Persistent Disk setzt den Plan *Starter* (ca. 7 $/Monat) voraus.

**Eigener Server:** `docker build` / `docker run` wie oben, davor Caddy oder nginx für HTTPS und `TRUST_PROXY=1` setzen.

Nach dem Start die URL öffnen, „Club gründen“ – das erste Konto wird Admin – und den Einladungscode unter **Club** teilen. Gesundheitscheck: `/healthz`.

Als App aufs Handy: Seite im Browser öffnen → „Zum Home-Bildschirm“ (iOS) bzw. „App installieren“ (Android).

## Sicherheit

Passwörter mit scrypt gehasht, Sitzungen per HttpOnly-Cookie (`SameSite=Lax`), Login-Drosselung, JSON-only-API, kein `innerHTML`. Der Kalender-Feed ist durch einen geheimen Token in der URL geschützt – nur im Club teilen.

## Aufbau

```
server/index.js        HTTP-Server, API, Auth
server/db.js           SQLite-Schema
server/ics.js          iCalendar-Erzeugung
server/openlibrary.js  Buchsuche
public/                Web-App (PWA)
test/                  API-Tests
```
