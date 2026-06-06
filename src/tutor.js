import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { init as initDb } from './db.js';
import { RESPONSE_SCHEMA, buildSystemPrompt } from './prompts.js';
import { endSession, getSessionContext, persistTurn, startSession } from './memory.js';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

const client = new Anthropic();

// Create a tutor instance scoped to a single conversation session.
// `persist: true` (default) opens a DB session and writes each turn.
export function createTutor({ persist = true, sessionId: existingId } = {}) {
  const context = getSessionContext();
  const sessionId = persist ? (existingId ?? startSession()) : null;
  const system = [
    {
      type: 'text',
      text: buildSystemPrompt(context),
      cache_control: { type: 'ephemeral' },
    },
  ];
  const messages = [];

  async function respond(userText, { userAudioPath = null } = {}) {
    messages.push({ role: 'user', content: userText });

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system,
      messages,
      thinking: { type: 'disabled' },
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: RESPONSE_SCHEMA },
      },
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock) throw new Error('Tutor response had no text block');

    let parsed;
    try {
      parsed = JSON.parse(textBlock.text);
    } catch {
      throw new Error(`Tutor response was not valid JSON: ${textBlock.text}`);
    }

    messages.push({ role: 'assistant', content: textBlock.text });
    if (sessionId) persistTurn(sessionId, { userText, parsed, userAudioPath });
    return { parsed, usage: response.usage };
  }

  async function end({ applyLevel = false } = {}) {
    if (!sessionId) return null;
    return endSession(sessionId, { applyLevel });
  }

  return {
    respond,
    end,
    get sessionId() { return sessionId; },
    get history() { return messages.slice(); },
    get context() { return context; },
  };
}

// CLI: interactive readline chat. Type "/end" or Ctrl-C to close the session
// (which triggers summary generation and writes it to the DB).
if (import.meta.url === `file://${process.argv[1]}`) {
  const readline = await import('node:readline/promises');
  initDb();
  const tutor = createTutor();
  console.log(
    `Tutor ready  model=${MODEL}  level=${tutor.context.profile.level}  ` +
    `session=#${tutor.sessionId}  summaries=${tutor.context.recentSummaries.length}  ` +
    `recent_corrections=${tutor.context.recentCorrections.length}`
  );
  console.log('Type a message and press Enter. "/end" to close session. Ctrl-C also closes.\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  let closed = false;
  async function closeAndExit() {
    if (closed) return;
    closed = true;
    rl.close();
    console.log('\nClosing session, asking Claude for a summary...');
    try {
      const summary = await tutor.end();
      if (summary) {
        console.log('\n--- session summary ---');
        console.log(summary.summary);
        console.log('topics:', summary.topics.join(', ') || '(none)');
        console.log('weak areas:', summary.weak_areas.join(', ') || '(none)');
        console.log('suggested level:', summary.suggested_level);
      } else {
        console.log('(empty session, nothing to summarize)');
      }
    } catch (err) {
      console.error('summary failed:', err.message);
    }
    process.exit(0);
  }
  process.on('SIGINT', closeAndExit);

  while (!closed) {
    let input;
    try { input = await rl.question('you > '); }
    catch { break; } // rl closed
    if (!input.trim()) continue;
    if (input.trim() === '/end') { await closeAndExit(); break; }
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
        `  [${dt}ms · in=${usage.input_tokens}+${usage.cache_read_input_tokens ?? 0}cache_r+${usage.cache_creation_input_tokens ?? 0}cache_w · out=${usage.output_tokens}]\n`
      );
    } catch (err) {
      console.error(`error: ${err.message}\n`);
    }
  }
}
