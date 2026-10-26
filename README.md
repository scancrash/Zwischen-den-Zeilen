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
| `BASE_URL` | aus der Anfrage | öffentliche URL, wird in Kalendereinträge geschrieben |

### Docker

```sh
docker build -t buchclub .
docker run -d -p 3000:3000 -v buchclub-data:/data buchclub
```

## Online stellen

Damit das **Kalender-Abo** auf den Handys funktioniert, muss die App aus dem Internet erreichbar sein – und zwar per **HTTPS** (Kalender-Apps und Cookies mögen kein reines HTTP). Geeignet ist jeder Hoster, der Docker oder Node mit dauerhaftem Speicher (Volume) anbietet, z. B. Fly.io, Railway, Render oder ein kleiner Server mit Caddy davor. Der SQLite-Ordner (`/data`) muss persistent sein.

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
