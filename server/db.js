import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      pw_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    -- status: suggested | queued | current | finished
    CREATE TABLE IF NOT EXISTS books (
      id INTEGER PRIMARY KEY,
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
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS votes (
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (book_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY,
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS meetings (
      id INTEGER PRIMARY KEY,
      book_id INTEGER REFERENCES books(id) ON DELETE SET NULL,
      starts_at TEXT NOT NULL,           -- ISO-8601 UTC
      duration_min INTEGER NOT NULL DEFAULT 120,
      location TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS rsvps (
      meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL,              -- yes | no | maybe
      PRIMARY KEY (meeting_id, user_id)
    );
  `);

  const ensure = (key, make) => {
    if (!db.prepare('SELECT 1 FROM settings WHERE key = ?').get(key))
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, make());
  };
  ensure('club_name', () => 'Unser Buchclub');
  ensure('invite_code', () => newInviteCode());
  ensure('cal_token', () => randomBytes(18).toString('hex'));
  return db;
}

export function newInviteCode() {
  // gut vorlesbar: keine 0/O/1/I
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export const getSetting = (db, key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
export const setSetting = (db, key, value) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
