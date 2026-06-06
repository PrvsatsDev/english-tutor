import 'dotenv/config';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';

const WHISPER_BIN = process.env.WHISPER_BIN || './bin/whisper-cli';
const WHISPER_MODEL = process.env.WHISPER_MODEL || './data/models/ggml-small.en-q5_1.bin';
const WHISPER_THREADS = Number(process.env.WHISPER_THREADS) || availableParallelism();

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited ${code}\n${stderr}`));
    });
  });
}

// Normalize any input audio (webm, mp3, wav at wrong rate...) to 16 kHz mono PCM,
// which is what whisper.cpp expects.
async function toWhisperWav(inputPath, outputPath) {
  await run('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-i', inputPath,
    '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
    outputPath,
  ]);
  return outputPath;
}

export async function transcribe(audioPath, { language = 'en' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'stt-'));
  try {
    const wavPath = join(dir, 'in.wav');
    const outBase = join(dir, 'out');
    await toWhisperWav(audioPath, wavPath);
    await run(WHISPER_BIN, [
      '-m', WHISPER_MODEL,
      '-f', wavPath,
      '-l', language,
      '-t', String(WHISPER_THREADS),
      '-nt',                    // no timestamps
      '--no-prints',            // silence progress
      '-otxt', '-of', outBase,  // writes <outBase>.txt
    ]);
    const txt = await readFile(`${outBase}.txt`, 'utf8');
    return txt.trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node src/stt.js <audio-file>');
    process.exit(1);
  }
  console.time('stt');
  const text = await transcribe(file);
  console.timeEnd('stt');
  console.log('Transcription:', JSON.stringify(text));
}
