import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { db, getProfile, setProfile } from './db.js';
import { SUMMARY_SCHEMA, SUMMARY_SYSTEM } from './prompts.js';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const client = new Anthropic();

const nowIso = () => new Date().toISOString();

export function startSession() {
  const r = db.prepare('INSERT INTO sessions (started_at) VALUES (?)').run(nowIso());
  return r.lastInsertRowid;
}

export function getSessionContext({ summariesLimit = 3, correctionsLimit = 20 } = {}) {
  const profile = getProfile();
  const recentSummaries = db
    .prepare(`
      SELECT summary, topics, level_snapshot, started_at
      FROM sessions
      WHERE summary IS NOT NULL
      ORDER BY id DESC
      LIMIT ?
    `)
    .all(summariesLimit);
  const recentCorrections = db
    .prepare(`
      SELECT id, original, corrected, category, explanation, ts
      FROM corrections
      WHERE resolved_at IS NULL
      ORDER BY id DESC
      LIMIT ?
    `)
    .all(correctionsLimit);
  return { profile, recentSummaries, recentCorrections };
}

const insertMessage = () =>
  db.prepare(
    'INSERT INTO messages (session_id, role, content, audio_path, ts) VALUES (?, ?, ?, ?, ?)'
  );
const insertCorrection = () =>
  db.prepare(
    'INSERT INTO corrections (session_id, original, corrected, category, explanation, ts) VALUES (?, ?, ?, ?, ?, ?)'
  );
const upsertVocab = () =>
  db.prepare(`
    INSERT INTO vocabulary (word, introduced_at, times_used, last_used_at)
    VALUES (?, ?, 0, NULL)
    ON CONFLICT(word) DO NOTHING
  `);

// Persist one full turn: student utterance, tutor reply, any corrections,
// and any vocabulary the tutor suggested. Mutates parsed.corrections in
// place to add a DB `id` to each — the UI needs it to mark them resolved.
export function persistTurn(sessionId, { userText, parsed, userAudioPath = null }) {
  const ts = nowIso();
  const msg = insertMessage();
  const corr = insertCorrection();
  const vocab = upsertVocab();
  db.transaction(() => {
    msg.run(sessionId, 'user', userText, userAudioPath, ts);
    msg.run(sessionId, 'tutor', parsed.spoken, null, ts);
    for (const c of parsed.corrections || []) {
      const r = corr.run(sessionId, c.original, c.corrected, c.category || null, c.explanation || null, ts);
      c.id = r.lastInsertRowid;
    }
    for (const phrase of parsed.suggested_phrases || []) {
      const word = phrase.trim().toLowerCase();
      if (word) vocab.run(word, ts);
    }
  })();
}

export function markCorrectionResolved(id) {
  const r = db
    .prepare('UPDATE corrections SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL')
    .run(nowIso(), id);
  return r.changes > 0;
}

export function listVocabulary({ limit = 200 } = {}) {
  return db
    .prepare(`
      SELECT word, introduced_at, times_used, last_used_at, mastery
      FROM vocabulary
      ORDER BY introduced_at DESC
      LIMIT ?
    `)
    .all(limit);
}

// Close a session: ask Claude to summarize, persist the summary, and merge
// any new weak areas into the profile so they show up in future sessions.
// Does NOT auto-update the level — returns level_change_proposed so the
// caller (UI) can confirm with the user before mutating the profile.
export async function endSession(sessionId, { applyLevel = false } = {}) {
  const rows = db
    .prepare('SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC')
    .all(sessionId);

  if (rows.length < 2) {
    db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(nowIso(), sessionId);
    return null;
  }

  const transcript = rows
    .map((m) => `${m.role === 'user' ? 'STUDENT' : 'TUTOR'}: ${m.content}`)
    .join('\n');

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SUMMARY_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `Session transcript:\n\n${transcript}\n\nSummarize this session.`,
      },
    ],
    thinking: { type: 'disabled' },
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: SUMMARY_SCHEMA },
    },
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Summary response had no text block');
  const summary = JSON.parse(textBlock.text);

  const profile = getProfile();
  const levelSnapshot = summary.suggested_level === 'none' ? null : summary.suggested_level;
  const levelChangeProposed =
    levelSnapshot && levelSnapshot !== profile.level
      ? { from: profile.level, to: levelSnapshot }
      : null;

  db.prepare(`
    UPDATE sessions
    SET ended_at = ?, summary = ?, topics = ?, level_snapshot = ?
    WHERE id = ?
  `).run(nowIso(), summary.summary, JSON.stringify(summary.topics), levelSnapshot, sessionId);

  if (summary.weak_areas?.length) {
    const existing = Array.isArray(profile.weak_areas) ? profile.weak_areas : [];
    const merged = Array.from(new Set([...existing, ...summary.weak_areas])).slice(-15);
    setProfile('weak_areas', merged);
  }

  if (applyLevel && levelChangeProposed) {
    setProfile('level', levelChangeProposed.to);
  }

  return { ...summary, level_change_proposed: levelChangeProposed };
}

const VALID_LEVELS = new Set(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);

// Explicit level update, used when the UI confirms an end-of-session suggestion.
export function updateLevel(level) {
  if (!VALID_LEVELS.has(level)) {
    throw new Error(`Invalid CEFR level: ${level}`);
  }
  setProfile('level', level);
}

// CLI: inspect what's currently in memory. Useful for debugging.
if (import.meta.url === `file://${process.argv[1]}`) {
  const profile = getProfile();
  const sessions = db
    .prepare('SELECT id, started_at, ended_at, summary, level_snapshot FROM sessions ORDER BY id DESC LIMIT 10')
    .all();
  const corrections = db
    .prepare('SELECT category, original, corrected FROM corrections ORDER BY id DESC LIMIT 20')
    .all();
  const vocab = db
    .prepare('SELECT word, introduced_at, times_used FROM vocabulary ORDER BY introduced_at DESC LIMIT 20')
    .all();
  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM sessions) AS sessions,
      (SELECT COUNT(*) FROM messages) AS messages,
      (SELECT COUNT(*) FROM corrections) AS corrections,
      (SELECT COUNT(*) FROM vocabulary) AS vocabulary
  `).get();

  console.log('--- counts ---'); console.log(counts);
  console.log('\n--- profile ---'); console.log(profile);
  console.log('\n--- sessions (last 10) ---');
  for (const s of sessions) {
    console.log(`#${s.id}  ${s.started_at} → ${s.ended_at || '(open)'}  level=${s.level_snapshot || '-'}`);
    if (s.summary) console.log(`   ${s.summary}`);
  }
  console.log('\n--- corrections (last 20) ---');
  for (const c of corrections) console.log(`[${c.category}] "${c.original}" → "${c.corrected}"`);
  console.log('\n--- vocabulary (last 20) ---');
  for (const v of vocab) console.log(`${v.word}  (used ${v.times_used}x)`);
}
