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
CREATE TABLE IF NOT EXISTS profile (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  summary         TEXT,
  topics          TEXT,
  level_snapshot  TEXT
);

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
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_corrections_ts ON corrections(ts DESC);

CREATE TABLE IF NOT EXISTS vocabulary (
  word          TEXT PRIMARY KEY,
  introduced_at TEXT NOT NULL,
  times_used    INTEGER NOT NULL DEFAULT 0,
  last_used_at  TEXT,
  mastery       REAL NOT NULL DEFAULT 0
);
`;

const PROFILE_SEED = {
  level: 'B1',
  interests: JSON.stringify(['technology', 'software development']),
  goals: 'Improve conversational fluency for professional contexts.',
  weak_areas: JSON.stringify([]),
};

export function init() {
  db.exec(SCHEMA);
  const upsert = db.prepare(
    'INSERT INTO profile (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING'
  );
  const tx = db.transaction((seed) => {
    for (const [k, v] of Object.entries(seed)) upsert.run(k, v);
  });
  tx(PROFILE_SEED);
}

export function getProfile() {
  const rows = db.prepare('SELECT key, value FROM profile').all();
  const profile = {};
  for (const { key, value } of rows) {
    try { profile[key] = JSON.parse(value); }
    catch { profile[key] = value; }
  }
  return profile;
}

export function setProfile(key, value) {
  const v = typeof value === 'string' ? value : JSON.stringify(value);
  db.prepare(
    'INSERT INTO profile (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, v);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  init();
  console.log(`Initialized DB at ${DB_PATH}`);
  console.log('Profile:', getProfile());
}
