# 📚 Buchclub

Gemeinsame App für unseren Buchclub – installierbar als App auf iPhone und Android (Web-App), ohne Build-Schritt. Läuft auf Vercel (mit Postgres) oder selbst gehostet.

## Funktionen

- **Mitglieder** – Beitritt per Einladungscode, die erste Person wird automatisch Admin. Admins können weitere Admins ernennen, Mitglieder entfernen und den Code erneuern.
- **Buchvorschläge** – Suche im Internet (Open Library, Fallback Google Books) mit Cover, Autor:in, Jahr und Seitenzahl; Bücher lassen sich auch manuell eintragen.
- **Abstimmung & Kommentare** – 👍 pro Mitglied und Buch, Diskussion unter jedem Vorschlag.
- **Leseliste (Admin)** – Vorschläge in eine Warteschlange aufnehmen, per ↑/↓ sortieren, „Jetzt lesen“ setzt das aktuelle Buch (das vorherige wird automatisch „gelesen“).
- **Termine** – Datum, Uhrzeit, Ort, Notizen, verknüpft mit dem Buch (standardmäßig dem aktuellen). Zu-/Absagen pro Mitglied.
- **Kalender**
  - **Abo-Link** (`/calendar.ics?token=…`): Apple Kalender, Google Kalender und Android abonnieren alle Termine und bekommen Änderungen automatisch.
  - Pro Termin: `.ics`-Download (Apple/Android) und „Zu Google Kalender hinzufügen“.

## Starten (lokal)

Benötigt Node.js ≥ 22. Ohne `DATABASE_URL` läuft ein eingebettetes Postgres (PGlite) im Ordner `data/pglite` – nichts weiter zu installieren.

```sh
npm install
npm start            # http://localhost:3000
npm test             # API-Tests (eingebettetes Postgres)
```

Beim ersten Aufruf „Club gründen“ – dieses Konto wird Admin. Danach den Einladungscode unter **Club** weitergeben.

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `DATABASE_URL` | – | Postgres-Verbindung (Neon, Supabase, …). Ohne: eingebettetes Postgres |
| `DB_PATH` | `data/pglite` | Ordner des eingebetteten Postgres (nur ohne `DATABASE_URL`) |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Adresse des lokalen Servers |
| `BASE_URL` | aus der Anfrage | öffentliche URL, wird in Kalendereinträge geschrieben |
| `TRUST_PROXY` | – | `1` hinter einem Proxy: echte Client-IP für die Login-Drosselung (auf Vercel automatisch) |

Gegen einen echten Postgres-Server testen: `TEST_DATABASE_URL=postgres://… npm test` (leert die Tabellen!).

## Auf Vercel veröffentlichen

Damit das **Kalender-Abo** auf den Handys funktioniert, muss die App per **HTTPS** erreichbar sein – Vercel liefert das automatisch.

1. [vercel.com/new](https://vercel.com/new) → dieses Repository importieren. Einstellungen so lassen (Framework „Other“, `vercel.json` ist vorbereitet).
2. Im Projekt unter **Storage** → **Create Database** → **Neon (Postgres)** wählen und mit dem Projekt verbinden. Dadurch wird `DATABASE_URL` automatisch gesetzt. (Alternativ eine beliebige Postgres-URL als Umgebungsvariable `DATABASE_URL` eintragen.)
3. **Redeploy** auslösen. Das Schema legt die App beim ersten Aufruf selbst an.
4. Die URL öffnen, „Club gründen“ – das erste Konto wird Admin – und den Einladungscode teilen.

Tipp: Die Funktionsregion (Settings → Functions) auf die Region der Datenbank stellen, z. B. Frankfurt. Gesundheitscheck: `/healthz`.

Als App aufs Handy: Seite im Browser öffnen → „Zum Home-Bildschirm“ (iOS) bzw. „App installieren“ (Android).

## Alternativ: eigener Server / Fly.io / Render

`Dockerfile`, `fly.toml` und `render.yaml` liegen bei. Dort läuft das eingebettete Postgres im persistenten Volume `/data` (oder per `DATABASE_URL` extern).

```sh
docker build -t buchclub . && docker run -d -p 3000:3000 -v buchclub-data:/data buchclub
```

## Sicherheit

Passwörter mit scrypt gehasht, Sitzungen per HttpOnly-Cookie (`SameSite=Lax`, `Secure` unter HTTPS), Login-Drosselung (pro Serverinstanz), JSON-only-API, kein `innerHTML`. Der Kalender-Feed ist durch einen geheimen Token in der URL geschützt – nur im Club teilen.

## Aufbau

```
server/index.js        HTTP-Server, API, Auth
server/db.js           Postgres-Zugriff und Schema
api/index.js           Vercel-Einstiegspunkt
server/ics.js          iCalendar-Erzeugung
server/openlibrary.js  Buchsuche
public/                Web-App (PWA)
test/                  API-Tests
```
