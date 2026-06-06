import 'dotenv/config';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const PIPER_BIN = process.env.PIPER_BIN || './bin/piper';
const PIPER_VOICE = process.env.PIPER_VOICE || './data/models/en_US-lessac-high.onnx';

// Returns a WAV (PCM s16le) Buffer for `text` using Piper.
// Piper streams audio to stdout when --output_file is '-'.
export function synthesize(text) {
  return new Promise((resolve, reject) => {
    const child = spawn(PIPER_BIN, [
      '--model', PIPER_VOICE,
      '--output_file', '-',
    ]);
    const chunks = [];
    let stderr = '';
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`piper exited ${code}\n${stderr}`));
    });
    child.stdin.end(text);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const text = process.argv.slice(2).join(' ')
    || 'Hello, this is a quick test of the text to speech engine.';
  console.time('tts');
  const wav = await synthesize(text);
  console.timeEnd('tts');
  const out = './data/audio/_tts_test.wav';
  await writeFile(out, wav);
  console.log(`Wrote ${wav.length} bytes to ${out}`);
}
