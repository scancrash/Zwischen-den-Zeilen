import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';
import { connectFromEnv, initSchema, getSetting, setSetting, newInviteCode } from './db.js';
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
const idOf = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 2147483647) throw new HttpError(404, 'Nicht gefunden.');
  return n;
};

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
  const failures = new Map(); // ip -> {count, until}
  const throttled = (ip) => (failures.get(ip)?.until ?? 0) > Date.now() && failures.get(ip).count >= 10;
  const noteFailure = (ip) => {
    const f = failures.get(ip);
    failures.set(ip, !f || f.until < Date.now() ? { count: 1, until: Date.now() + 15 * 60000 } : { ...f, count: f.count + 1 });
  };

  // ---------- Daten ----------
  const booksFor = async (uid) =>
    (await db.all(`SELECT b.id, b.title, b.author, b.cover_url, b.year, b.pages, b.description, b.status, b.position, b.created_at,
              u.name AS suggested_by_name, b.suggested_by,
              (SELECT COUNT(*) FROM votes v WHERE v.book_id = b.id)::int AS votes,
              EXISTS(SELECT 1 FROM votes v WHERE v.book_id = b.id AND v.user_id = ?) AS voted,
              (SELECT COUNT(*) FROM comments c WHERE c.book_id = b.id)::int AS comment_count
         FROM books b LEFT JOIN users u ON u.id = b.suggested_by
        ORDER BY b.created_at DESC, b.id DESC`, [uid])).map((b) => ({ ...b, voted: !!b.voted }));

  const meetingsFor = async (uid) => {
    const rows = await db.all(`SELECT m.*, b.title AS book_title, b.author AS book_author, b.cover_url AS book_cover
                      FROM meetings m LEFT JOIN books b ON b.id = m.book_id
                     ORDER BY m.starts_at`);
    const rs = await db.all('SELECT r.meeting_id, r.user_id, r.status, u.name FROM rsvps r JOIN users u ON u.id = r.user_id');
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

  async function startSession(res, userId, secure) {
    const token = randomBytes(32).toString('hex');
    await db.run('INSERT INTO sessions (token, user_id) VALUES (?, ?)', [token, userId]);
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
  }

  const bookById = async (id) => {
    const b = await db.get('SELECT * FROM books WHERE id = ?', [idOf(id)]);
    if (!b) throw new HttpError(404, 'Buch nicht gefunden.');
    return b;
  };
  const meetingById = async (id) => {
    const m = await db.get('SELECT * FROM meetings WHERE id = ?', [idOf(id)]);
    if (!m) throw new HttpError(404, 'Termin nicht gefunden.');
    return m;
  };
  const requireAdmin = (c) => {
    if (!c.user.is_admin) throw new HttpError(403, 'Nur Admins dürfen das.');
  };

  async function meetingInput(body, existing = {}) {
    const startsRaw = body.starts_at ?? existing.starts_at;
    const start = new Date(startsRaw);
    if (!startsRaw || Number.isNaN(start.getTime())) throw bad('Bitte Datum und Uhrzeit angeben.');
    const duration = Number(body.duration_min ?? existing.duration_min ?? 120);
    if (!Number.isInteger(duration) || duration < 15 || duration > 720) throw bad('Dauer muss zwischen 15 und 720 Minuten liegen.');
    const bookId = 'book_id' in body ? (body.book_id ? Number(body.book_id) : null) : existing.book_id ?? null;
    if (bookId) await bookById(bookId);
    return {
      starts_at: start.toISOString(),
      duration_min: duration,
      book_id: bookId,
      location: str(body.location ?? existing.location ?? '', 200, { name: 'Ort' }),
      notes: str(body.notes ?? existing.notes ?? '', 2000, { name: 'Notizen' }),
    };
  }

  const icsRows = () =>
    db.all(`SELECT m.*, b.title AS book_title, b.author AS book_author
         FROM meetings m LEFT JOIN books b ON b.id = m.book_id ORDER BY m.starts_at`);
  const calOpts = async (c) => ({ clubName: await getSetting(db, 'club_name'), baseUrl: baseUrl || c.origin });
  const raw = (body, type, filename) => ({ __raw: true, body, type, filename });

  // ---------- Routen ----------
  const routes = [];
  const route = (method, path, opts, fn) => {
    if (typeof opts === 'function') [fn, opts] = [opts, {}];
    routes.push({ method, re: new RegExp(`^${path.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), auth: opts.auth !== false, fn });
  };
  const secure = (c) => c.origin.startsWith('https:');
  const count = async (sql) => (await db.get(sql)).n;

  route('POST', '/api/register', { auth: false }, async (c) => {
    const name = str(c.body.name, 40, { required: true, name: 'Name' });
    const pw = typeof c.body.password === 'string' ? c.body.password : '';
    if (pw.length < 6) throw bad('Das Passwort braucht mindestens 6 Zeichen.');
    const first = (await count('SELECT COUNT(*)::int AS n FROM users')) === 0;
    if (!first && String(c.body.invite ?? '').trim().toUpperCase() !== (await getSetting(db, 'invite_code')))
      throw new HttpError(403, 'Der Einladungscode stimmt nicht.');
    if (await db.get('SELECT 1 FROM users WHERE lower(name) = lower(?)', [name])) throw new HttpError(409, 'Dieser Name ist schon vergeben.');
    const { id } = await db.get('INSERT INTO users (name, pw_hash, is_admin) VALUES (?, ?, ?) RETURNING id', [name, hashPassword(pw), first ? 1 : 0]);
    await startSession(c.res, id, secure(c));
    return { ok: true };
  });

  route('POST', '/api/login', { auth: false }, async (c) => {
    if (throttled(c.ip)) throw new HttpError(429, 'Zu viele Versuche. Bitte später erneut probieren.');
    const u = await db.get('SELECT * FROM users WHERE lower(name) = lower(?)', [String(c.body.name ?? '').trim()]);
    if (!u || !checkPassword(String(c.body.password ?? ''), u.pw_hash)) {
      noteFailure(c.ip);
      throw new HttpError(401, 'Name oder Passwort falsch.');
    }
    await startSession(c.res, u.id, secure(c));
    return { ok: true };
  });

  route('POST', '/api/logout', async (c) => {
    await db.run('DELETE FROM sessions WHERE token = ?', [c.token]);
    c.res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure(c) ? '; Secure' : ''}`);
    return { ok: true };
  });

  route('GET', '/api/state', { auth: false }, async (c) => {
    const clubName = await getSetting(db, 'club_name');
    if (!c.user) return { me: null, has_users: (await count('SELECT COUNT(*)::int AS n FROM users')) > 0, club_name: clubName };
    return {
      me: publicUser(c.user),
      club_name: clubName,
      books: await booksFor(c.user.id),
      meetings: await meetingsFor(c.user.id),
      members: (await db.all('SELECT id, name, is_admin FROM users ORDER BY lower(name)')).map(publicUser),
      calendar_path: `/calendar.ics?token=${await getSetting(db, 'cal_token')}`,
      invite_code: c.user.is_admin ? await getSetting(db, 'invite_code') : undefined,
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
    if (sourceKey && (await db.get('SELECT 1 FROM books WHERE source_key = ?', [sourceKey]))) throw new HttpError(409, 'Dieses Buch wurde schon vorgeschlagen.');
    if (await db.get('SELECT 1 FROM books WHERE lower(title) = lower(?) AND lower(author) = lower(?)', [title, author]))
      throw new HttpError(409, 'Dieses Buch wurde schon vorgeschlagen.');
    const int = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 && Number(v) < 2147483647 ? Number(v) : null);
    const cover = typeof b.cover_url === 'string' && /^https:\/\//.test(b.cover_url) ? b.cover_url.slice(0, 500) : '';
    const description = str(b.description, 2000) || (await fetchDescription(sourceKey));
    const id = await db.tx(async (t) => {
      const row = await t.get(`INSERT INTO books (title, author, cover_url, year, pages, description, source_key, suggested_by)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        [title, author, cover, int(b.year), int(b.pages), description, sourceKey, c.user.id]);
      await t.run('INSERT INTO votes (book_id, user_id) VALUES (?, ?)', [row.id, c.user.id]);
      return row.id;
    });
    return { id };
  });

  route('POST', '/api/books/reorder', async (c) => {
    requireAdmin(c);
    const ids = Array.isArray(c.body.ids) ? c.body.ids.map(idOf) : [];
    await db.tx(async (t) => {
      for (const [i, id] of ids.entries()) await t.run("UPDATE books SET position = ? WHERE id = ? AND status = 'queued'", [i + 1, id]);
    });
    return { ok: true };
  });

  route('PATCH', '/api/books/:id', async (c) => {
    requireAdmin(c);
    const book = await bookById(c.params.id);
    const { status } = c.body;
    if (!STATUSES.includes(status)) throw bad('Ungültiger Status.');
    await db.tx(async (t) => {
      if (status === 'current') await t.run("UPDATE books SET status = 'finished' WHERE status = 'current' AND id != ?", [book.id]);
      const pos = status === 'queued' ? (await t.get("SELECT COALESCE(MAX(position), 0)::int + 1 AS p FROM books WHERE status = 'queued'")).p : 0;
      await t.run('UPDATE books SET status = ?, position = ? WHERE id = ?', [status, pos, book.id]);
    });
    return { ok: true };
  });

  route('DELETE', '/api/books/:id', async (c) => {
    const book = await bookById(c.params.id);
    const own = book.suggested_by === c.user.id && book.status === 'suggested';
    if (!c.user.is_admin && !own) throw new HttpError(403, 'Du darfst nur eigene, noch offene Vorschläge löschen.');
    await db.run('DELETE FROM books WHERE id = ?', [book.id]);
    return { ok: true };
  });

  route('POST', '/api/books/:id/vote', async (c) => {
    const book = await bookById(c.params.id);
    const del = await db.get('DELETE FROM votes WHERE book_id = ? AND user_id = ? RETURNING book_id', [book.id, c.user.id]);
    if (!del) await db.run('INSERT INTO votes (book_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING', [book.id, c.user.id]);
    return { voted: !del };
  });

  route('GET', '/api/books/:id/comments', async (c) => {
    const book = await bookById(c.params.id);
    return { comments: await db.all(`SELECT c.id, c.body, c.created_at, c.user_id, u.name FROM comments c JOIN users u ON u.id = c.user_id
                           WHERE c.book_id = ? ORDER BY c.id`, [book.id]) };
  });

  route('POST', '/api/books/:id/comments', async (c) => {
    const book = await bookById(c.params.id);
    const body = str(c.body.body, 2000, { required: true, name: 'Kommentar' });
    await db.run('INSERT INTO comments (book_id, user_id, body) VALUES (?, ?, ?)', [book.id, c.user.id, body]);
    return { ok: true };
  });

  route('DELETE', '/api/comments/:id', async (c) => {
    const cm = await db.get('SELECT * FROM comments WHERE id = ?', [idOf(c.params.id)]);
    if (!cm) throw new HttpError(404, 'Kommentar nicht gefunden.');
    if (cm.user_id !== c.user.id && !c.user.is_admin) throw new HttpError(403, 'Nicht erlaubt.');
    await db.run('DELETE FROM comments WHERE id = ?', [cm.id]);
    return { ok: true };
  });

  route('POST', '/api/meetings', async (c) => {
    requireAdmin(c);
    const body = { ...c.body };
    if (!('book_id' in body)) body.book_id = (await db.get("SELECT id FROM books WHERE status = 'current'"))?.id ?? null;
    const m = await meetingInput(body);
    const { id } = await db.get('INSERT INTO meetings (book_id, starts_at, duration_min, location, notes) VALUES (?, ?, ?, ?, ?) RETURNING id',
      [m.book_id, m.starts_at, m.duration_min, m.location, m.notes]);
    return { id };
  });

  route('PATCH', '/api/meetings/:id', async (c) => {
    requireAdmin(c);
    const existing = await meetingById(c.params.id);
    const m = await meetingInput(c.body, existing);
    await db.run('UPDATE meetings SET book_id = ?, starts_at = ?, duration_min = ?, location = ?, notes = ? WHERE id = ?',
      [m.book_id, m.starts_at, m.duration_min, m.location, m.notes, existing.id]);
    return { ok: true };
  });

  route('DELETE', '/api/meetings/:id', async (c) => {
    requireAdmin(c);
    await db.run('DELETE FROM meetings WHERE id = ?', [(await meetingById(c.params.id)).id]);
    return { ok: true };
  });

  route('POST', '/api/meetings/:id/rsvp', async (c) => {
    const m = await meetingById(c.params.id);
    const s = c.body.status;
    if (s === null) await db.run('DELETE FROM rsvps WHERE meeting_id = ? AND user_id = ?', [m.id, c.user.id]);
    else if (['yes', 'no', 'maybe'].includes(s))
      await db.run('INSERT INTO rsvps (meeting_id, user_id, status) VALUES (?, ?, ?) ON CONFLICT (meeting_id, user_id) DO UPDATE SET status = EXCLUDED.status', [m.id, c.user.id, s]);
    else throw bad('Ungültige Antwort.');
    return { ok: true };
  });

  route('GET', '/api/meetings/:id/ics', async (c) => {
    const id = idOf(c.params.id);
    const m = (await icsRows()).find((r) => r.id === id);
    if (!m) throw new HttpError(404, 'Termin nicht gefunden.');
    return raw(buildCalendar([m], await calOpts(c)), 'text/calendar; charset=utf-8', `buchclub-${m.id}.ics`);
  });

  route('GET', '/calendar.ics', { auth: false }, async (c) => {
    // Abo-Feed: Kalender-Apps schicken keine Cookies, daher geheimer Token in der URL.
    if (c.url.searchParams.get('token') !== (await getSetting(db, 'cal_token'))) throw new HttpError(404, 'Nicht gefunden.');
    return raw(buildCalendar(await icsRows(), await calOpts(c)), 'text/calendar; charset=utf-8');
  });

  route('GET', '/healthz', { auth: false }, async () => {
    await db.get('SELECT 1 AS ok');
    return { ok: true };
  });

  // ---------- Admin ----------
  route('PATCH', '/api/admin/club', async (c) => {
    requireAdmin(c);
    await setSetting(db, 'club_name', str(c.body.club_name, 60, { required: true, name: 'Clubname' }));
    return { ok: true };
  });

  route('POST', '/api/admin/invite', async (c) => {
    requireAdmin(c);
    const code = newInviteCode();
    await setSetting(db, 'invite_code', code);
    return { invite_code: code };
  });

  route('PATCH', '/api/admin/members/:id', async (c) => {
    requireAdmin(c);
    const id = idOf(c.params.id);
    if (id === c.user.id) throw bad('Du kannst dir die eigene Rolle nicht ändern.');
    if (!(await db.get('SELECT 1 FROM users WHERE id = ?', [id]))) throw new HttpError(404, 'Mitglied nicht gefunden.');
    await db.run('UPDATE users SET is_admin = ? WHERE id = ?', [c.body.is_admin ? 1 : 0, id]);
    return { ok: true };
  });

  route('DELETE', '/api/admin/members/:id', async (c) => {
    requireAdmin(c);
    const id = idOf(c.params.id);
    if (id === c.user.id) throw bad('Du kannst dich nicht selbst entfernen.');
    await db.run('DELETE FROM users WHERE id = ?', [id]);
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
        ? await db.get(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
              WHERE s.token = ? AND s.created_at > now() - make_interval(days => ?)`, [token, SESSION_DAYS])
        : undefined;
      if (match.r.auth && !user) throw new HttpError(401, 'Bitte zuerst anmelden.');
      const body = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req) : {};
      const out = await match.r.fn({
        req, res, url, body, user, token, params: { ...match.m.groups }, origin: url.origin,
        ip: ((process.env.TRUST_PROXY === '1' || process.env.VERCEL) && String(req.headers['fly-client-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '',
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
      if (e?.code === '23505') return send(409, { error: 'Dieser Eintrag existiert bereits.' });
      console.error(e);
      send(500, { error: 'Interner Fehler.' });
    }
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = await initSchema(await connectFromEnv());
  const port = Number(process.env.PORT) || 3000;
  createServer(createApp(db)).listen(port, process.env.HOST || '0.0.0.0', () => console.log(`Buchclub läuft auf http://localhost:${port}`));
}
