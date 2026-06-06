// Headless WebSocket client. Sends one wav to /voice, prints the turn,
// writes the tutor's audio reply to disk, then asks the server to close
// the session and prints the summary.
//
// Usage: node src/test-voice-client.js <path-to-wav>

import { readFile, writeFile } from 'node:fs/promises';
import WebSocket from 'ws';

const URL = process.env.WS_URL || 'ws://localhost:3000/voice';
const wav = process.argv[2];
if (!wav) {
  console.error('Usage: node src/test-voice-client.js <path-to-wav>');
  process.exit(1);
}

const audio = await readFile(wav);
const ws = new WebSocket(URL);
const outPath = './data/audio/_test_client_reply.wav';

ws.on('open', () => {
  console.log(`[client] connected ${URL}`);
});

ws.on('message', async (raw) => {
  const msg = JSON.parse(raw.toString());
  switch (msg.type) {
    case 'session_start':
      console.log(`[client] session #${msg.sessionId}, level=${msg.profile.level}, memory: ${msg.memory.summaries} summaries / ${msg.memory.corrections} corrections`);
      console.log(`[client] uploading ${audio.byteLength} bytes of audio...`);
      ws.send(audio);
      break;
    case 'turn':
      console.log(`\n[client] TRANSCRIPT: ${JSON.stringify(msg.transcript)}`);
      console.log(`[client] TUTOR: ${msg.response.spoken}`);
      if (msg.response.corrections.length) {
        for (const c of msg.response.corrections) {
          console.log(`  fix [${c.category}] "${c.original}" → "${c.corrected}" — ${c.explanation}`);
        }
      }
      if (msg.response.suggested_phrases.length) {
        console.log('  phrases:', msg.response.suggested_phrases);
      }
      console.log(`  timings: STT=${msg.timings.stt_ms}ms · LLM=${msg.timings.llm_ms}ms · TTS=${msg.timings.tts_ms}ms · total=${msg.timings.total_ms}ms`);
      console.log(`  usage: in=${msg.usage.input_tokens}+${msg.usage.cache_read_input_tokens ?? 0}cache_r+${msg.usage.cache_creation_input_tokens ?? 0}cache_w · out=${msg.usage.output_tokens}`);
      await writeFile(outPath, Buffer.from(msg.audio_b64, 'base64'));
      console.log(`[client] wrote tutor reply → ${outPath} (${msg.audio_b64.length * 3 / 4 | 0} bytes)`);
      ws.send(JSON.stringify({ type: 'end' }));
      break;
    case 'summary':
      if (msg.summary) {
        console.log('\n[client] SUMMARY:');
        console.log(' ', msg.summary.summary);
        console.log('  topics:', msg.summary.topics.join(', '));
        console.log('  weak areas:', msg.summary.weak_areas.join('; ') || '(none)');
        console.log('  suggested level:', msg.summary.suggested_level);
        if (msg.summary.level_change_proposed) {
          const { from, to } = msg.summary.level_change_proposed;
          console.log(`  level change proposed: ${from} → ${to}`);
          if (process.env.APPLY_LEVEL === '1') {
            console.log('  (APPLY_LEVEL=1) sending apply_level...');
            ws.send(JSON.stringify({ type: 'apply_level', level: to }));
            return; // wait for profile_updated before closing
          }
        } else {
          console.log('  level change proposed: none');
        }
      } else {
        console.log('\n[client] (empty session, no summary)');
      }
      ws.send(JSON.stringify({ type: 'close' }));
      break;
    case 'profile_updated':
      console.log(`[client] PROFILE UPDATED: level → ${msg.level}`);
      ws.send(JSON.stringify({ type: 'close' }));
      break;
    case 'error':
      console.error('[client] SERVER ERROR:', msg.message);
      ws.close();
      process.exit(1);
  }
});

ws.on('close', () => { console.log('[client] disconnected'); process.exit(0); });
ws.on('error', (err) => { console.error('[client] ws error:', err.message); process.exit(1); });
