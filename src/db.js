import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import 'dotenv/config';

const DB_PATH = process.env.DB_PATH || './data/tutor.db';

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_profile (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key     TEXT NOT NULL,
  value   TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS sessions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  summary         TEXT,
  topics          TEXT,
  level_snapshot  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('user', 'tutor')),
  content     TEXT NOT NULL,
  audio_path  TEXT,
  ts          TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

CREATE TABLE IF NOT EXISTS corrections (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER,
  original    TEXT NOT NULL,
  corrected   TEXT NOT NULL,
  category    TEXT,
  explanation TEXT,
  ts          TEXT NOT NULL,
  resolved_at TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_corrections_ts ON corrections(ts DESC);

CREATE TABLE IF NOT EXISTS vocabulary (
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  word          TEXT NOT NULL,
  introduced_at TEXT NOT NULL,
  times_used    INTEGER NOT NULL DEFAULT 0,
  last_used_at  TEXT,
  mastery       REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, word)
);
`;

// Neutral default profile for a freshly created user. Deliberately has NO
// interests or goals — those are personal and are captured per user at
// creation time (see createUser). A blank profile means the tutor presumes
// nothing about who it's talking to. `level` is overridden per user.
const PROFILE_SEED = {
  level: 'B1',
  weak_areas: JSON.stringify([]),
};

export const VALID_LEVELS = new Set(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);

const nowIso = () => new Date().toISOString();

function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

// Seed a user's profile with PROFILE_SEED plus any overrides (level, interests,
// goals). Empty/blank override values are skipped so the profile stays neutral.
// Idempotent: existing keys are left untouched.
function seedProfile(userId, overrides = {}) {
  const upsert = db.prepare(
    'INSERT INTO user_profile (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO NOTHING'
  );
  const seed = { ...PROFILE_SEED, ...overrides };
  db.transaction(() => {
    for (const [k, v] of Object.entries(seed)) {
      if (v === undefined || v === null || v === '') continue;
      upsert.run(userId, k, typeof v === 'string' ? v : JSON.stringify(v));
    }
  })();
}

export function init() {
  db.exec(SCHEMA);
  // Idempotent forward migrations live here. Adding a column is safe; renaming
  // or dropping needs a real migration step.
  ensureColumn('corrections', 'resolved_at', 'TEXT');

  // Seed a default user the first time we run, so the picker isn't empty.
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count === 0) {
    const r = db.prepare('INSERT INTO users (name, created_at) VALUES (?, ?)').run('Martin', nowIso());
    seedProfile(r.lastInsertRowid);
  }
}

export function listUsers() {
  return db.prepare('SELECT id, name FROM users ORDER BY id').all();
}

// Create a new family member and seed their profile at the given CEFR level.
// Optional `interests` (free text) and `goals` personalize the tutor's prompt;
// blank values are skipped, leaving a neutral profile.
// Throws on a blank name, a duplicate, or an invalid level.
export function createUser(name, level, { interests, goals } = {}) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('User name is required');
  if (!VALID_LEVELS.has(level)) throw new Error(`Invalid CEFR level: ${level}`);
  const existing = db.prepare('SELECT id FROM users WHERE name = ?').get(trimmed);
  if (existing) throw new Error(`User "${trimmed}" already exists`);

  const r = db.prepare('INSERT INTO users (name, created_at) VALUES (?, ?)').run(trimmed, nowIso());
  const id = r.lastInsertRowid;
  seedProfile(id, {
    level,
    interests: String(interests || '').trim(),
    goals: String(goals || '').trim(),
  });
  return { id, name: trimmed };
}

// Delete a user and all their data. Cascades to user_profile, sessions,
// messages and vocabulary; corrections are deleted explicitly first because
// they only SET NULL on session delete (which would orphan, not remove them).
// Refuses to delete the last remaining user so the app never ends up empty.
export function deleteUser(userId) {
  const remaining = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (remaining <= 1) throw new Error('Cannot delete the last remaining user');
  const exists = db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId);
  if (!exists) throw new Error('User not found');

  db.transaction(() => {
    db.prepare('DELETE FROM corrections WHERE session_id IN (SELECT id FROM sessions WHERE user_id = ?)').run(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  })();
}

export function getProfile(userId) {
  const rows = db.prepare('SELECT key, value FROM user_profile WHERE user_id = ?').all(userId);
  const profile = {};
  for (const { key, value } of rows) {
    try { profile[key] = JSON.parse(value); }
    catch { profile[key] = value; }
  }
  return profile;
}

export function setProfile(userId, key, value) {
  const v = typeof value === 'string' ? value : JSON.stringify(value);
  db.prepare(
    'INSERT INTO user_profile (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value'
  ).run(userId, key, v);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  init();
  console.log(`Initialized DB at ${DB_PATH}`);
  console.log('Users:', listUsers());
}
