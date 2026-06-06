import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { getProfile, init as initDb } from './db.js';
import { RESPONSE_SCHEMA, buildSystemPrompt } from './prompts.js';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

const client = new Anthropic();

// Create a tutor instance scoped to a single conversation session.
// Holds the message history in memory; persistence comes later (memory.js).
export function createTutor({ profile } = {}) {
  const studentProfile = profile || getProfile();
  const system = [
    {
      type: 'text',
      text: buildSystemPrompt(studentProfile),
      cache_control: { type: 'ephemeral' }, // ~10x cheaper after first turn
    },
  ];
  const messages = [];

  async function respond(userText) {
    messages.push({ role: 'user', content: userText });

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system,
      messages,
      thinking: { type: 'disabled' },          // voice chat — latency over depth
      output_config: {
        effort: 'low',                          // Sonnet 4.6 defaults to high; we want fast
        format: { type: 'json_schema', schema: RESPONSE_SCHEMA },
      },
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock) throw new Error('Tutor response had no text block');

    let parsed;
    try {
      parsed = JSON.parse(textBlock.text);
    } catch (err) {
      throw new Error(`Tutor response was not valid JSON: ${textBlock.text}`);
    }

    messages.push({ role: 'assistant', content: textBlock.text });
    return { parsed, usage: response.usage };
  }

  return {
    respond,
    get history() { return messages.slice(); },
    get profile() { return studentProfile; },
  };
}

// CLI test: text-only chat loop. Lets us validate the tutor before wiring audio.
if (import.meta.url === `file://${process.argv[1]}`) {
  const readline = await import('node:readline/promises');
  initDb();
  const tutor = createTutor();
  console.log(`Tutor ready (model=${MODEL}, level=${tutor.profile.level}).`);
  console.log('Type your message and press Enter. Ctrl-C to quit.\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  while (true) {
    const input = await rl.question('you > ');
    if (!input.trim()) continue;
    try {
      const t0 = Date.now();
      const { parsed, usage } = await tutor.respond(input);
      const dt = Date.now() - t0;
      console.log(`\ntutor > ${parsed.spoken}`);
      if (parsed.corrections.length) {
        console.log('  corrections:');
        for (const c of parsed.corrections) {
          console.log(`   • [${c.category}] "${c.original}" → "${c.corrected}"`);
          console.log(`     ${c.explanation}`);
        }
      }
      if (parsed.suggested_phrases.length) {
        console.log('  try saying:');
        for (const p of parsed.suggested_phrases) console.log(`   • ${p}`);
      }
      if (parsed.level_signal !== 'none') {
        console.log(`  level signal: ${parsed.level_signal}`);
      }
      console.log(
        `  [${dt}ms · in=${usage.input_tokens}+${usage.cache_read_input_tokens ?? 0}cache+${usage.cache_creation_input_tokens ?? 0}write · out=${usage.output_tokens}]\n`
      );
    } catch (err) {
      console.error(`error: ${err.message}\n`);
    }
  }
}
