import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';
import { openDb, getSetting, setSetting, newInviteCode } from './db.js';
import { buildCalendar } from './ics.js';
import { searchBooks, fetchDescription } from './openlibrary.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const COOKIE = 'bc_session';
const SESSION_DAYS = 90;
const STATUSES = ['suggested', 'queued', 'current', 'finished'];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new HttpError(400, msg);

// ---------- Passwörter ----------
function hashPassword(pw) {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(pw, salt, 64).toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const a = Buffer.from(hash, 'hex');
  const b = scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  return a.length === b.length && timingSafeEqual(a, b);
}

const str = (v, max, { required = false, name = 'Feld' } = {}) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) throw bad(`${name} fehlt.`);
  if (s.length > max) throw bad(`${name} ist zu lang (max. ${max} Zeichen).`);
  return s;
};

export function createApp(db, { baseUrl = process.env.BASE_URL } = {}) {
  const q = (sql) => db.prepare(sql);
  const tx = (fn) => {
    db.exec('BEGIN');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };

  const failures = new Map(); // ip -> {count, until}
  const throttled = (ip) => (failures.get(ip)?.until ?? 0) > Date.now() && failures.get(ip).count >= 10;
  const noteFailure = (ip) => {
    const f = failures.get(ip);
    failures.set(ip, !f || f.until < Date.now() ? { count: 1, until: Date.now() + 15 * 60000 } : { ...f, count: f.count + 1 });
  };

  // ---------- Daten ----------
  const booksFor = (uid) =>
    q(`SELECT b.id, b.title, b.author, b.cover_url, b.year, b.pages, b.description, b.status, b.position, b.created_at,
              u.name AS suggested_by_name, b.suggested_by,
              (SELECT COUNT(*) FROM votes v WHERE v.book_id = b.id) AS votes,
              EXISTS(SELECT 1 FROM votes v WHERE v.book_id = b.id AND v.user_id = ?) AS voted,
              (SELECT COUNT(*) FROM comments c WHERE c.book_id = b.id) AS comment_count
         FROM books b LEFT JOIN users u ON u.id = b.suggested_by
        ORDER BY b.created_at DESC, b.id DESC`).all(uid).map((b) => ({ ...b, voted: !!b.voted }));

  const meetingsFor = (uid) => {
    const rows = q(`SELECT m.*, b.title AS book_title, b.author AS book_author, b.cover_url AS book_cover
                      FROM meetings m LEFT JOIN books b ON b.id = m.book_id
                     ORDER BY m.starts_at`).all();
    const rs = q(`SELECT r.meeting_id, r.user_id, r.status, u.name FROM rsvps r JOIN users u ON u.id = r.user_id`).all();
    return rows.map((m) => {
      const mine = rs.filter((r) => r.meeting_id === m.id);
      return {
        ...m,
        rsvps: mine.map((r) => ({ user_id: r.user_id, name: r.name, status: r.status })),
        my_rsvp: mine.find((r) => r.user_id === uid)?.status ?? null,
      };
    });
  };

  const publicUser = (u) => ({ id: u.id, name: u.name, is_admin: !!u.is_admin });

  function startSession(res, userId) {
    const token = randomBytes(32).toString('hex');
    q('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, userId);
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`);
  }

  const bookById = (id) => {
    const b = q('SELECT * FROM books WHERE id = ?').get(id);
    if (!b) throw new HttpError(404, 'Buch nicht gefunden.');
    return b;
  };
  const meetingById = (id) => {
    const m = q('SELECT * FROM meetings WHERE id = ?').get(id);
    if (!m) throw new HttpError(404, 'Termin nicht gefunden.');
    return m;
  };
  const requireAdmin = (c) => {
    if (!c.user.is_admin) throw new HttpError(403, 'Nur Admins dürfen das.');
  };

  function meetingInput(body, existing = {}) {
    const startsRaw = body.starts_at ?? existing.starts_at;
    const start = new Date(startsRaw);
    if (!startsRaw || Number.isNaN(start.getTime())) throw bad('Bitte Datum und Uhrzeit angeben.');
    const duration = Number(body.duration_min ?? existing.duration_min ?? 120);
    if (!Number.isInteger(duration) || duration < 15 || duration > 720) throw bad('Dauer muss zwischen 15 und 720 Minuten liegen.');
    const bookId = 'book_id' in body ? (body.book_id ? Number(body.book_id) : null) : existing.book_id ?? null;
    if (bookId) bookById(bookId);
    return {
      starts_at: start.toISOString(),
      duration_min: duration,
      book_id: bookId,
      location: str(body.location ?? existing.location ?? '', 200, { name: 'Ort' }),
      notes: str(body.notes ?? existing.notes ?? '', 2000, { name: 'Notizen' }),
    };
  }

  const icsRows = () =>
    q(`SELECT m.*, b.title AS book_title, b.author AS book_author
         FROM meetings m LEFT JOIN books b ON b.id = m.book_id ORDER BY m.starts_at`).all();
  const calOpts = (c) => ({ clubName: getSetting(db, 'club_name'), baseUrl: baseUrl || c.origin });
  const raw = (body, type, filename) => ({ __raw: true, body, type, filename });

  // ---------- Routen ----------
  const routes = [];
  const route = (method, path, opts, fn) => {
    if (typeof opts === 'function') [fn, opts] = [opts, {}];
    routes.push({ method, re: new RegExp(`^${path.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), auth: opts.auth !== false, fn });
  };

  route('POST', '/api/register', { auth: false }, (c) => {
    const name = str(c.body.name, 40, { required: true, name: 'Name' });
    const pw = typeof c.body.password === 'string' ? c.body.password : '';
    if (pw.length < 6) throw bad('Das Passwort braucht mindestens 6 Zeichen.');
    const first = q('SELECT COUNT(*) AS n FROM users').get().n === 0;
    if (!first && String(c.body.invite ?? '').trim().toUpperCase() !== getSetting(db, 'invite_code'))
      throw new HttpError(403, 'Der Einladungscode stimmt nicht.');
    if (q('SELECT 1 FROM users WHERE name = ?').get(name)) throw new HttpError(409, 'Dieser Name ist schon vergeben.');
    const { lastInsertRowid } = q('INSERT INTO users (name, pw_hash, is_admin) VALUES (?, ?, ?)').run(name, hashPassword(pw), first ? 1 : 0);
    startSession(c.res, Number(lastInsertRowid));
    return { ok: true };
  });

  route('POST', '/api/login', { auth: false }, (c) => {
    if (throttled(c.ip)) throw new HttpError(429, 'Zu viele Versuche. Bitte später erneut probieren.');
    const u = q('SELECT * FROM users WHERE name = ?').get(String(c.body.name ?? '').trim());
    if (!u || !checkPassword(String(c.body.password ?? ''), u.pw_hash)) {
      noteFailure(c.ip);
      throw new HttpError(401, 'Name oder Passwort falsch.');
    }
    startSession(c.res, u.id);
    return { ok: true };
  });

  route('POST', '/api/logout', (c) => {
    q('DELETE FROM sessions WHERE token = ?').run(c.token);
    c.res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    return { ok: true };
  });

  route('GET', '/api/state', { auth: false }, (c) => {
    if (!c.user) return { me: null, has_users: q('SELECT COUNT(*) AS n FROM users').get().n > 0, club_name: getSetting(db, 'club_name') };
    return {
      me: publicUser(c.user),
      club_name: getSetting(db, 'club_name'),
      books: booksFor(c.user.id),
      meetings: meetingsFor(c.user.id),
      members: q('SELECT id, name, is_admin FROM users ORDER BY name').all().map(publicUser),
      calendar_path: `/calendar.ics?token=${getSetting(db, 'cal_token')}`,
      invite_code: c.user.is_admin ? getSetting(db, 'invite_code') : undefined,
    };
  });

  route('GET', '/api/search', (c) => {
    const term = str(c.url.searchParams.get('q'), 120);
    if (term.length < 2) return { results: [] };
    return searchBooks(term).then(
      (results) => ({ results: results.filter((r) => r.title) }),
      () => { throw new HttpError(502, 'Die Buchsuche ist gerade nicht erreichbar. Du kannst das Buch auch manuell eintragen.'); },
    );
  });

  route('POST', '/api/books', async (c) => {
    const b = c.body;
    const title = str(b.title, 300, { required: true, name: 'Titel' });
    const author = str(b.author, 200);
    const sourceKey = b.source_key ? str(b.source_key, 100) : null;
    if (sourceKey && q('SELECT 1 FROM books WHERE source_key = ?').get(sourceKey)) throw new HttpError(409, 'Dieses Buch wurde schon vorgeschlagen.');
    if (q('SELECT 1 FROM books WHERE lower(title) = lower(?) AND lower(author) = lower(?)').get(title, author))
      throw new HttpError(409, 'Dieses Buch wurde schon vorgeschlagen.');
    const int = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
    const cover = typeof b.cover_url === 'string' && /^https:\/\//.test(b.cover_url) ? b.cover_url.slice(0, 500) : '';
    const description = str(b.description, 2000) || (await fetchDescription(sourceKey));
    const id = tx(() => {
      const { lastInsertRowid } = q(`INSERT INTO books (title, author, cover_url, year, pages, description, source_key, suggested_by)
                                      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(title, author, cover, int(b.year), int(b.pages), description, sourceKey, c.user.id);
      q('INSERT INTO votes (book_id, user_id) VALUES (?, ?)').run(lastInsertRowid, c.user.id);
      return Number(lastInsertRowid);
    });
    return { id };
  });

  route('POST', '/api/books/reorder', (c) => {
    requireAdmin(c);
    const ids = Array.isArray(c.body.ids) ? c.body.ids.map(Number) : [];
    tx(() => ids.forEach((id, i) => q("UPDATE books SET position = ? WHERE id = ? AND status = 'queued'").run(i + 1, id)));
    return { ok: true };
  });

  route('PATCH', '/api/books/:id', (c) => {
    requireAdmin(c);
    const book = bookById(Number(c.params.id));
    const { status } = c.body;
    if (!STATUSES.includes(status)) throw bad('Ungültiger Status.');
    tx(() => {
      if (status === 'current') q("UPDATE books SET status = 'finished' WHERE status = 'current' AND id != ?").run(book.id);
      const pos = status === 'queued' ? q("SELECT COALESCE(MAX(position), 0) + 1 AS p FROM books WHERE status = 'queued'").get().p : 0;
      q('UPDATE books SET status = ?, position = ? WHERE id = ?').run(status, pos, book.id);
    });
    return { ok: true };
  });

  route('DELETE', '/api/books/:id', (c) => {
    const book = bookById(Number(c.params.id));
    const own = book.suggested_by === c.user.id && book.status === 'suggested';
    if (!c.user.is_admin && !own) throw new HttpError(403, 'Du darfst nur eigene, noch offene Vorschläge löschen.');
    q('DELETE FROM books WHERE id = ?').run(book.id);
    return { ok: true };
  });

  route('POST', '/api/books/:id/vote', (c) => {
    const book = bookById(Number(c.params.id));
    const has = q('SELECT 1 FROM votes WHERE book_id = ? AND user_id = ?').get(book.id, c.user.id);
    if (has) q('DELETE FROM votes WHERE book_id = ? AND user_id = ?').run(book.id, c.user.id);
    else q('INSERT INTO votes (book_id, user_id) VALUES (?, ?)').run(book.id, c.user.id);
    return { voted: !has };
  });

  route('GET', '/api/books/:id/comments', (c) => {
    const book = bookById(Number(c.params.id));
    return { comments: q(`SELECT c.id, c.body, c.created_at, c.user_id, u.name FROM comments c JOIN users u ON u.id = c.user_id
                           WHERE c.book_id = ? ORDER BY c.id`).all(book.id) };
  });

  route('POST', '/api/books/:id/comments', (c) => {
    const book = bookById(Number(c.params.id));
    const body = str(c.body.body, 2000, { required: true, name: 'Kommentar' });
    q('INSERT INTO comments (book_id, user_id, body) VALUES (?, ?, ?)').run(book.id, c.user.id, body);
    return { ok: true };
  });

  route('DELETE', '/api/comments/:id', (c) => {
    const cm = q('SELECT * FROM comments WHERE id = ?').get(Number(c.params.id));
    if (!cm) throw new HttpError(404, 'Kommentar nicht gefunden.');
    if (cm.user_id !== c.user.id && !c.user.is_admin) throw new HttpError(403, 'Nicht erlaubt.');
    q('DELETE FROM comments WHERE id = ?').run(cm.id);
    return { ok: true };
  });

  route('POST', '/api/meetings', (c) => {
    requireAdmin(c);
    const body = { ...c.body };
    if (!('book_id' in body)) body.book_id = q("SELECT id FROM books WHERE status = 'current'").get()?.id ?? null;
    const m = meetingInput(body);
    const { lastInsertRowid } = q('INSERT INTO meetings (book_id, starts_at, duration_min, location, notes) VALUES (?, ?, ?, ?, ?)')
      .run(m.book_id, m.starts_at, m.duration_min, m.location, m.notes);
    return { id: Number(lastInsertRowid) };
  });

  route('PATCH', '/api/meetings/:id', (c) => {
    requireAdmin(c);
    const m = meetingInput(c.body, meetingById(Number(c.params.id)));
    q('UPDATE meetings SET book_id = ?, starts_at = ?, duration_min = ?, location = ?, notes = ? WHERE id = ?')
      .run(m.book_id, m.starts_at, m.duration_min, m.location, m.notes, Number(c.params.id));
    return { ok: true };
  });

  route('DELETE', '/api/meetings/:id', (c) => {
    requireAdmin(c);
    q('DELETE FROM meetings WHERE id = ?').run(meetingById(Number(c.params.id)).id);
    return { ok: true };
  });

  route('POST', '/api/meetings/:id/rsvp', (c) => {
    const m = meetingById(Number(c.params.id));
    const s = c.body.status;
    if (s === null) q('DELETE FROM rsvps WHERE meeting_id = ? AND user_id = ?').run(m.id, c.user.id);
    else if (['yes', 'no', 'maybe'].includes(s))
      q('INSERT INTO rsvps (meeting_id, user_id, status) VALUES (?, ?, ?) ON CONFLICT(meeting_id, user_id) DO UPDATE SET status = excluded.status').run(m.id, c.user.id, s);
    else throw bad('Ungültige Antwort.');
    return { ok: true };
  });

  route('GET', '/api/meetings/:id/ics', (c) => {
    const m = icsRows().find((r) => r.id === Number(c.params.id));
    if (!m) throw new HttpError(404, 'Termin nicht gefunden.');
    return raw(buildCalendar([m], calOpts(c)), 'text/calendar; charset=utf-8', `buchclub-${m.id}.ics`);
  });

  route('GET', '/calendar.ics', { auth: false }, (c) => {
    // Abo-Feed: Kalender-Apps schicken keine Cookies, daher geheimer Token in der URL.
    if (c.url.searchParams.get('token') !== getSetting(db, 'cal_token')) throw new HttpError(404, 'Nicht gefunden.');
    return raw(buildCalendar(icsRows(), calOpts(c)), 'text/calendar; charset=utf-8');
  });

  // ---------- Admin ----------
  route('PATCH', '/api/admin/club', (c) => {
    requireAdmin(c);
    setSetting(db, 'club_name', str(c.body.club_name, 60, { required: true, name: 'Clubname' }));
    return { ok: true };
  });

  route('POST', '/api/admin/invite', (c) => {
    requireAdmin(c);
    const code = newInviteCode();
    setSetting(db, 'invite_code', code);
    return { invite_code: code };
  });

  route('PATCH', '/api/admin/members/:id', (c) => {
    requireAdmin(c);
    const id = Number(c.params.id);
    if (id === c.user.id) throw bad('Du kannst dir die eigene Rolle nicht ändern.');
    if (!q('SELECT 1 FROM users WHERE id = ?').get(id)) throw new HttpError(404, 'Mitglied nicht gefunden.');
    q('UPDATE users SET is_admin = ? WHERE id = ?').run(c.body.is_admin ? 1 : 0, id);
    return { ok: true };
  });

  route('DELETE', '/api/admin/members/:id', (c) => {
    requireAdmin(c);
    const id = Number(c.params.id);
    if (id === c.user.id) throw bad('Du kannst dich nicht selbst entfernen.');
    q('DELETE FROM users WHERE id = ?').run(id);
    return { ok: true };
  });

  // ---------- HTTP ----------
  const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  };

  async function serveStatic(res, pathname) {
    let rel;
    try {
      rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '') || 'index.html';
    } catch {
      throw new HttpError(404, 'Nicht gefunden.');
    }
    if (rel.startsWith('..')) throw new HttpError(404, 'Nicht gefunden.');
    try {
      const data = await readFile(join(PUBLIC_DIR, rel));
      res.writeHead(200, { 'Content-Type': MIME[extname(rel)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    } catch {
      throw new HttpError(404, 'Nicht gefunden.');
    }
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const ch of req) {
      size += ch.length;
      if (size > 64 * 1024) throw new HttpError(413, 'Anfrage zu groß.');
      chunks.push(ch);
    }
    if (!size) return {};
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'JSON erwartet.');
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) ?? {};
    } catch {
      throw bad('Ungültiges JSON.');
    }
  }

  return async function handler(req, res) {
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const url = new URL(req.url, `${proto}://${req.headers.host || 'localhost'}`);
    const send = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    try {
      const match = routes.map((r) => (r.method === req.method ? { r, m: r.re.exec(url.pathname) } : null)).find((x) => x?.m);
      if (!match) {
        if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return await serveStatic(res, url.pathname);
        throw new HttpError(404, 'Nicht gefunden.');
      }
      const token = /(?:^|;\s*)bc_session=([a-f0-9]+)/.exec(req.headers.cookie ?? '')?.[1];
      const user = token
        ? q(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
              WHERE s.token = ? AND s.created_at > datetime('now', ?)`).get(token, `-${SESSION_DAYS} days`)
        : undefined;
      if (match.r.auth && !user) throw new HttpError(401, 'Bitte zuerst anmelden.');
      const body = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req) : {};
      const out = await match.r.fn({
        req, res, url, body, user, token, params: { ...match.m.groups }, origin: url.origin,
        ip: req.socket.remoteAddress ?? '',
      });
      if (out?.__raw) {
        const h = { 'Content-Type': out.type, 'Cache-Control': 'no-store' };
        if (out.filename) h['Content-Disposition'] = `attachment; filename="${out.filename}"`;
        res.writeHead(200, h);
        return res.end(out.body);
      }
      send(200, out);
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.message });
      console.error(e);
      send(500, { error: 'Interner Fehler.' });
    }
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb(process.env.DB_PATH || join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'buchclub.db'));
  const port = Number(process.env.PORT) || 3000;
  createServer(createApp(db)).listen(port, () => console.log(`Buchclub läuft auf http://localhost:${port}`));
}
