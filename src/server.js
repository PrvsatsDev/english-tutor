import 'dotenv/config';
import express from 'express';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { init as initDb } from './db.js';
import { updateLevel } from './memory.js';
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

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/voice' });

function send(ws, obj) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(obj));
}

wss.on('connection', (ws) => {
  const tutor = createTutor();
  let ended = false;
  let turnCounter = 0;
  console.log(`[ws] connect  session=#${tutor.sessionId}`);

  send(ws, {
    type: 'session_start',
    sessionId: tutor.sessionId,
    profile: tutor.context.profile,
    memory: {
      summaries: tutor.context.recentSummaries.length,
      corrections: tutor.context.recentCorrections.length,
    },
  });

  async function finalize(reason) {
    if (ended) return;
    ended = true;
    try {
      const summary = await tutor.end();
      console.log(`[ws] session=#${tutor.sessionId} closed (${reason})${summary ? ' summarized' : ' empty'}`);
      send(ws, { type: 'summary', summary });
    } catch (err) {
      console.error(`[ws] session=#${tutor.sessionId} end failed: ${err.message}`);
      send(ws, { type: 'error', message: `summary failed: ${err.message}` });
    }
  }

  ws.on('message', async (data, isBinary) => {
    if (isBinary) {
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
          response: parsed,
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

    if (msg.type === 'end') {
      // Don't close the socket here — let the client send `apply_level`
      // or `close` after the user dismisses the summary dialog.
      await finalize('client end');
    } else if (msg.type === 'apply_level') {
      try {
        updateLevel(msg.level);
        send(ws, { type: 'profile_updated', level: msg.level });
        console.log(`[ws] session=#${tutor.sessionId} level updated → ${msg.level}`);
      } catch (err) {
        send(ws, { type: 'error', message: err.message });
      }
    } else if (msg.type === 'close') {
      ws.close();
    } else {
      send(ws, { type: 'error', message: `Unknown control type: ${msg.type}` });
    }
  });

  ws.on('close', () => { finalize('disconnect'); });
  ws.on('error', (err) => { console.error(`[ws] session=#${tutor.sessionId} error:`, err.message); });
});

server.listen(PORT, () => {
  console.log(`English tutor → http://localhost:${PORT}`);
  console.log(`WebSocket      → ws://localhost:${PORT}/voice`);
});
