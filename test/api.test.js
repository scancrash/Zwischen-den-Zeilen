import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connectPg, connectPglite, initSchema } from '../server/db.js';
import { createApp } from '../server/index.js';

let server, base;
before(async () => {
  // TEST_DATABASE_URL=postgres://… testet zusätzlich den echten Postgres-Treiber (wie auf Vercel); sonst eingebettetes Postgres im Speicher.
  const url = process.env.TEST_DATABASE_URL;
  const db = await initSchema(url ? await connectPg(url) : await connectPglite());
  if (url) await db.exec('TRUNCATE users, sessions, books, votes, comments, meetings, rsvps RESTART IDENTITY CASCADE');
  server = createServer(createApp(db));
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

function client() {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    const json = res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
    return { status: res.status, json, text, headers: res.headers };
  };
}

const admin = client(), anna = client();
let invite, bookId, meetingId, calPath;

test('erster Nutzer wird Admin, weitere brauchen Einladungscode', async () => {
  assert.equal((await admin('POST', '/api/register', { name: 'Omar', password: 'geheim1' })).status, 200);
  const st = (await admin('GET', '/api/state')).json;
  assert.equal(st.me.is_admin, true);
  invite = st.invite_code;
  calPath = st.calendar_path;
  assert.equal((await anna('POST', '/api/register', { name: 'Anna', password: 'geheim1', invite: 'FALSCH' })).status, 403);
  assert.equal((await anna('POST', '/api/register', { name: 'Anna', password: 'geheim1', invite: invite.toLowerCase() })).status, 200);
  assert.equal((await anna('GET', '/api/state')).json.invite_code, undefined);
});

test('Vorschlag, Duplikat, Abstimmung, Kommentar', async () => {
  const r = await anna('POST', '/api/books', { title: 'Die Känguru-Chroniken', author: 'Marc-Uwe Kling', source_key: 'ol:/works/X1', cover_url: 'https://example.com/c.jpg' });
  assert.equal(r.status, 200);
  bookId = r.json.id;
  assert.equal((await admin('POST', '/api/books', { title: 'x', source_key: 'ol:/works/X1' })).status, 409);
  assert.equal((await admin('POST', `/api/books/${bookId}/vote`, {})).json.voted, true);
  assert.equal((await admin('POST', `/api/books/${bookId}/vote`, {})).json.voted, false);
  assert.equal((await admin('POST', `/api/books/${bookId}/vote`, {})).json.voted, true);
  assert.equal((await admin('POST', `/api/books/${bookId}/comments`, { body: 'Klingt gut!' })).status, 200);
  const b = (await anna('GET', '/api/state')).json.books[0];
  assert.equal(b.votes, 2);
  assert.equal(b.comment_count, 1);
  assert.equal((await anna('GET', `/api/books/${bookId}/comments`)).json.comments[0].name, 'Omar');
});

test('nur Admins verwalten Leseliste und Termine', async () => {
  assert.equal((await anna('PATCH', `/api/books/${bookId}`, { status: 'current' })).status, 403);
  assert.equal((await anna('POST', '/api/meetings', { starts_at: '2026-11-20T18:00:00Z' })).status, 403);
  assert.equal((await admin('PATCH', `/api/books/${bookId}`, { status: 'current' })).status, 200);
  const m = await admin('POST', '/api/meetings', { starts_at: '2026-11-20T18:00:00Z', location: 'Café Lesezeichen, Berlin', notes: 'Wein; Snacks' });
  assert.equal(m.status, 200);
  meetingId = m.json.id;
  const st = (await anna('GET', '/api/state')).json;
  assert.equal(st.meetings[0].book_id, bookId); // Termin hängt automatisch am aktuellen Buch
  assert.equal(st.meetings[0].book_title, 'Die Känguru-Chroniken');
});

test('neues aktuelles Buch schließt das alte ab, Warteschlange lässt sich sortieren', async () => {
  const ids = [];
  for (const t of ['A', 'B', 'C']) ids.push((await anna('POST', '/api/books', { title: t })).json.id);
  for (const id of ids) await admin('PATCH', `/api/books/${id}`, { status: 'queued' });
  await admin('POST', '/api/books/reorder', { ids: [ids[2], ids[0], ids[1]] });
  let books = (await admin('GET', '/api/state')).json.books;
  assert.deepEqual(books.filter((b) => b.status === 'queued').sort((a, b) => a.position - b.position).map((b) => b.title), ['C', 'A', 'B']);
  await admin('PATCH', `/api/books/${ids[2]}`, { status: 'current' });
  books = (await admin('GET', '/api/state')).json.books;
  assert.equal(books.filter((b) => b.status === 'current').length, 1);
  assert.equal(books.find((b) => b.id === bookId).status, 'finished');
});

test('RSVP', async () => {
  await anna('POST', `/api/meetings/${meetingId}/rsvp`, { status: 'yes' });
  const m = (await anna('GET', '/api/state')).json.meetings[0];
  assert.equal(m.my_rsvp, 'yes');
  assert.equal(m.rsvps.length, 1);
  assert.equal((await anna('POST', `/api/meetings/${meetingId}/rsvp`, { status: 'vielleicht' })).status, 400);
});

test('Kalender-Abo und Einzeltermin als .ics', async () => {
  const feed = await fetch(base + calPath);
  const ics = await feed.text();
  assert.match(feed.headers.get('content-type'), /text\/calendar/);
  assert.match(ics, /BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /DTSTART:20261120T180000Z/);
  assert.match(ics, /DTEND:20261120T200000Z/);
  assert.match(ics, /LOCATION:Café Lesezeichen\\, Berlin/);
  assert.equal((await fetch(base + '/calendar.ics?token=falsch')).status, 404);
  const one = await anna('GET', `/api/meetings/${meetingId}/ics`);
  assert.match(one.text, /UID:buchclub-meeting-1@buchclub/);
});

test('Login, Logout, falsches Passwort', async () => {
  const c = client();
  assert.equal((await c('POST', '/api/login', { name: 'anna', password: 'nope' })).status, 401);
  assert.equal((await c('POST', '/api/login', { name: 'anna', password: 'geheim1' })).status, 200);
  assert.ok((await c('GET', '/api/state')).json.me);
  await c('POST', '/api/logout', {});
  assert.equal((await c('GET', '/api/state')).json.me, null);
});

test('Admin: Mitglied befördern und entfernen; Static-Auslieferung ohne Pfad-Ausbruch', async () => {
  const annaId = (await admin('GET', '/api/state')).json.members.find((m) => m.name === 'Anna').id;
  assert.equal((await admin('PATCH', `/api/admin/members/${annaId}`, { is_admin: true })).status, 200);
  assert.equal((await admin('DELETE', `/api/admin/members/${annaId}`)).status, 200);
  assert.equal((await fetch(base + '/%2e%2e/package.json')).status, 404);
  assert.equal((await fetch(base + '/')).status, 200);
});

test('ungültige IDs liefern 404 statt 500', async () => {
  assert.equal((await admin('GET', '/api/books/abc/comments')).status, 404);
  assert.equal((await admin('POST', '/api/books/99999999999/vote', {})).status, 404);
});

test('Healthcheck ohne Login', async () => {
  const r = await fetch(base + '/healthz');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});
