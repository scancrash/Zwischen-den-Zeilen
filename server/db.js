import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';

// Dünne asynchrone Schicht über Postgres. SQL wird mit "?"-Platzhaltern geschrieben und hier zu $1, $2 … umgesetzt.
// Produktion (Vercel): Postgres über DATABASE_URL (z. B. Neon). Lokal/Selbsthosting ohne DATABASE_URL: eingebettetes Postgres (PGlite) in einem Ordner.

const toPg = (sql) => {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
};

const bind = (query) => ({
  all: (sql, params = []) => query(toPg(sql), params),
  get: async (sql, params = []) => (await query(toPg(sql), params))[0],
  run: async (sql, params = []) => void (await query(toPg(sql), params)),
});

export function makeDb({ query, transaction, exec }) {
  return { ...bind(query), exec, tx: (fn) => transaction((txQuery) => fn(bind(txQuery))) };
}

export async function connectFromEnv() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (url) return connectPg(url);
  const dir = process.env.DB_PATH || 'data/pglite';
  mkdirSync(dir, { recursive: true });
  return connectPglite(dir);
}

export async function connectPg(connectionString) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString, max: 3, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 10_000 });
  return makeDb({
    query: async (sql, params) => (await pool.query(sql, params)).rows,
    exec: async (sql) => void (await pool.query(sql)),
    transaction: async (fn) => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const r = await fn(async (sql, params) => (await c.query(sql, params)).rows);
        await c.query('COMMIT');
        return r;
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    },
  });
}

export async function connectPglite(dataDir) {
  // Dynamischer Import über Variable: wird auf Vercel nicht mit in die Funktion gepackt.
  const mod = '@electric-sql/pglite';
  const { PGlite } = await import(mod);
  const pg = new PGlite(dataDir);
  await pg.waitReady;
  return makeDb({
    query: async (sql, params) => (await pg.query(sql, params)).rows,
    exec: async (sql) => void (await pg.exec(sql)),
    transaction: (fn) => pg.transaction((tx) => fn(async (sql, params) => (await tx.query(sql, params)).rows)),
  });
}

const NOW = `to_char(timezone('utc', now()), 'YYYY-MM-DD HH24:MI:SS')`;

export async function initSchema(db) {
  await db.tx(async (t) => {
    await t.run('SELECT pg_advisory_xact_lock(727274)'); // mehrere Kaltstarts gleichzeitig
    for (const stmt of [
      `CREATE TABLE IF NOT EXISTS users (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        name TEXT NOT NULL,
        pw_hash TEXT NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT ${NOW})`,
      `CREATE UNIQUE INDEX IF NOT EXISTS users_name_ci ON users (lower(name))`,
      `CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
      `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
      // status: suggested | queued | current | finished
      `CREATE TABLE IF NOT EXISTS books (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        title TEXT NOT NULL,
        author TEXT NOT NULL DEFAULT '',
        cover_url TEXT NOT NULL DEFAULT '',
        year INTEGER,
        pages INTEGER,
        description TEXT NOT NULL DEFAULT '',
        source_key TEXT UNIQUE,
        status TEXT NOT NULL DEFAULT 'suggested',
        position INTEGER NOT NULL DEFAULT 0,
        suggested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT ${NOW})`,
      `CREATE TABLE IF NOT EXISTS votes (
        book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY (book_id, user_id))`,
      `CREATE TABLE IF NOT EXISTS comments (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT ${NOW})`,
      `CREATE TABLE IF NOT EXISTS meetings (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        book_id INTEGER REFERENCES books(id) ON DELETE SET NULL,
        starts_at TEXT NOT NULL,
        duration_min INTEGER NOT NULL DEFAULT 120,
        location TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT ${NOW})`,
      `CREATE TABLE IF NOT EXISTS rsvps (
        meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        PRIMARY KEY (meeting_id, user_id))`,
    ]) await t.run(stmt);
    const ensure = (key, value) => t.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', [key, value]);
    await ensure('club_name', 'Unser Buchclub');
    await ensure('invite_code', newInviteCode());
    await ensure('cal_token', randomBytes(18).toString('hex'));
  });
  return db;
}

export function newInviteCode() {
  // gut vorlesbar: keine 0/O/1/I
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export const getSetting = async (db, key) => (await db.get('SELECT value FROM settings WHERE key = ?', [key]))?.value;
export const setSetting = (db, key, value) =>
  db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, value]);
