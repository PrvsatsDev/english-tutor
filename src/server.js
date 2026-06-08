import 'dotenv/config';
import express from 'express';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { basename } from 'node:path';
import { init as initDb, listUsers, createUser, deleteUser } from './db.js';
import { listVocabulary, markCorrectionResolved, updateLevel } from './memory.js';
import { synthesize } from './tts.js';
import { transcribe } from './stt.js';
import { createTutor } from './tutor.js';

const PORT = Number(process.env.PORT) || 3000;
const AUDIO_DIR = process.env.AUDIO_DIR || './data/audio';
const PUBLIC_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'public');

initDb();
await mkdir(AUDIO_DIR, { recursive: true });

const app = express();
app.use(express.static(PUBLIC_DIR));
// Personal-use only: serves every user recording under data/audio/ over HTTP
// so the browser can play back your own utterances. Don't expose this server
// beyond localhost without an auth layer.
app.use('/audio', express.static(resolve(AUDIO_DIR)));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/voice' });

function send(ws, obj) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(obj));
}

wss.on('connection', (ws) => {
  // No session yet — the client must pick (or create) a user first. The tutor
  // is created lazily once we know who's talking, and can be swapped if the
  // user is changed mid-socket via the header dropdown.
  let tutor = null;
  let ended = false;
  let turnCounter = 0;
  console.log('[ws] connect (awaiting user selection)');

  send(ws, { type: 'users', users: listUsers() });

  async function finalize(reason) {
    if (!tutor || ended) return;
    ended = true;
    try {
      const summary = await tutor.end();
      console.log(`[ws] session=#${tutor.sessionId} closed (${reason})${summary ? ' summarized' : ' empty'}`);
      send(ws, { type: 'summary', summary, reason });
    } catch (err) {
      console.error(`[ws] session=#${tutor.sessionId} end failed: ${err.message}`);
      send(ws, { type: 'error', message: `summary failed: ${err.message}` });
    }
  }

  // Start (or switch to) a session for the given user. Finalizes any in-flight
  // session first so the previous user's summary is persisted.
  async function startForUser(userId) {
    if (tutor && !ended) await finalize('switch');
    tutor = createTutor({ userId });
    ended = false;
    turnCounter = 0;
    const user = listUsers().find((u) => u.id === userId);
    console.log(`[ws] user=#${userId} (${user?.name ?? '?'}) session=#${tutor.sessionId}`);
    send(ws, {
      type: 'session_start',
      sessionId: tutor.sessionId,
      userId,
      userName: user?.name ?? null,
      profile: tutor.context.profile,
      memory: {
        summaries: tutor.context.recentSummaries.length,
        corrections: tutor.context.recentCorrections.length,
      },
    });
  }

  ws.on('message', async (data, isBinary) => {
    if (isBinary) {
      if (!tutor) {
        send(ws, { type: 'error', message: 'Select a user before speaking.' });
        return;
      }
      const t0 = Date.now();
      turnCounter += 1;
      const audioPath = join(AUDIO_DIR, `s${tutor.sessionId}-t${turnCounter}-${Date.now()}.webm`);
      try {
        await writeFile(audioPath, data);

        const tSttStart = Date.now();
        const transcript = await transcribe(audioPath);
        const sttMs = Date.now() - tSttStart;

        if (!transcript.trim()) {
          send(ws, { type: 'error', message: 'Empty transcription — say something louder or longer.' });
          return;
        }

        const tLlmStart = Date.now();
        const { parsed, usage } = await tutor.respond(transcript, { userAudioPath: audioPath });
        const llmMs = Date.now() - tLlmStart;

        const tTtsStart = Date.now();
        const wav = await synthesize(parsed.spoken);
        const ttsMs = Date.now() - tTtsStart;

        send(ws, {
          type: 'turn',
          transcript,
          response: parsed,                          // corrections now include DB id
          user_audio_url: `/audio/${basename(audioPath)}`,
          audio_b64: wav.toString('base64'),
          timings: { stt_ms: sttMs, llm_ms: llmMs, tts_ms: ttsMs, total_ms: Date.now() - t0 },
          usage,
        });
      } catch (err) {
        console.error('[ws] turn error:', err);
        send(ws, { type: 'error', message: err.message });
      }
      return;
    }

    // Text frame — control messages
    let msg;
    try { msg = JSON.parse(data.toString()); }
    catch { send(ws, { type: 'error', message: 'Invalid JSON control message' }); return; }

    if (msg.type === 'select_user') {
      try {
        await startForUser(Number(msg.user_id));
      } catch (err) {
        send(ws, { type: 'error', message: err.message });
      }
      return;
    }
    if (msg.type === 'create_user') {
      try {
        const u = createUser(msg.name, msg.level, { interests: msg.interests, goals: msg.goals });
        await startForUser(u.id);
      } catch (err) {
        send(ws, { type: 'error', message: err.message });
      }
      return;
    }
    if (msg.type === 'delete_user') {
      try {
        const id = Number(msg.user_id);
        // If the active user is being deleted, discard their (now-doomed)
        // session without summarizing — its data is about to disappear.
        if (tutor && tutor.userId === id) { ended = true; tutor = null; }
        deleteUser(id);
        send(ws, { type: 'users', users: listUsers() });
      } catch (err) {
        send(ws, { type: 'error', message: err.message });
      }
      return;
    }

    // Everything below operates on the active session.
    if (!tutor) {
      send(ws, { type: 'error', message: 'Select a user first.' });
      return;
    }

    if (msg.type === 'end') {
      // Don't close the socket here — let the client send `apply_level`
      // or `close` after the user dismisses the summary dialog.
      await finalize('client end');
    } else if (msg.type === 'apply_level') {
      try {
        updateLevel(tutor.userId, msg.level);
        send(ws, { type: 'profile_updated', level: msg.level });
        console.log(`[ws] session=#${tutor.sessionId} level updated → ${msg.level}`);
      } catch (err) {
        send(ws, { type: 'error', message: err.message });
      }
    } else if (msg.type === 'mark_understood') {
      const changed = markCorrectionResolved(Number(msg.correction_id));
      send(ws, { type: 'correction_resolved', correction_id: Number(msg.correction_id), changed });
    } else if (msg.type === 'get_vocabulary') {
      send(ws, { type: 'vocabulary', items: listVocabulary({ userId: tutor.userId, limit: 200 }) });
    } else if (msg.type === 'close') {
      ws.close();
    } else {
      send(ws, { type: 'error', message: `Unknown control type: ${msg.type}` });
    }
  });

  ws.on('close', () => { finalize('disconnect'); });
  ws.on('error', (err) => { console.error(`[ws] session=#${tutor?.sessionId ?? '-'} error:`, err.message); });
});

server.listen(PORT, () => {
  console.log(`English tutor → http://localhost:${PORT}`);
  console.log(`WebSocket      → ws://localhost:${PORT}/voice`);
});
