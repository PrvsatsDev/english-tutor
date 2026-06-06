// JSON schema enforced via Anthropic structured outputs (output_config.format).
// Every tutor turn MUST validate against this — guarantees we always have
// a `spoken` string to TTS and a list of corrections to persist.
export const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['spoken', 'corrections', 'suggested_phrases', 'level_signal'],
  properties: {
    spoken: {
      type: 'string',
      description:
        'What you say back to the student. 1–3 sentences, conversational, English only.',
    },
    corrections: {
      type: 'array',
      description:
        'At most 1–2 of the most impactful issues from the student\'s last turn. Empty array if none.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['original', 'corrected', 'category', 'explanation'],
        properties: {
          original: { type: 'string', description: 'Exact phrase the student used.' },
          corrected: { type: 'string', description: 'How it should be phrased.' },
          category: {
            type: 'string',
            enum: [
              'grammar',
              'vocabulary',
              'preposition',
              'tense',
              'word_order',
              'pronunciation',
              'register',
              'other',
            ],
          },
          explanation: {
            type: 'string',
            description: 'One sentence explanation in English.',
          },
        },
      },
    },
    suggested_phrases: {
      type: 'array',
      description:
        'Optional. Useful phrases to teach when the student is stuck or asks how to say something.',
      items: { type: 'string' },
    },
    level_signal: {
      type: 'string',
      enum: ['raise', 'lower', 'none'],
      description:
        'Only "raise" or "lower" when there is strong, repeated evidence; otherwise "none".',
    },
  },
};

const RULES = `You are an English tutor for a Spanish-native adult learner.
Your job: hold a natural conversation, correct sparingly, and push them one
step beyond their comfort zone.

RULES
- Always respond in English, even if they speak Spanish.
- Keep "spoken" to 1–3 sentences — this is voice, not an essay.
- Use vocabulary slightly above their current level (i+1).
- At most 1–2 corrections per turn. Pick the most impactful. Fluency > perfection.
- If they hesitate, get stuck, or ask "how do you say X", give them the phrase
  in "suggested_phrases" and keep the conversation moving.
- If they speak Spanish, briefly encourage English in your spoken response,
  then continue with the topic.
- Occasionally steer toward a weak area, but naturally — not every turn.
- "level_signal": almost always "none". Only change after clear, repeated
  evidence across the session.
- Output ONLY the JSON object that matches the response schema. No prose outside it.`;

function fmtList(value) {
  if (!value) return '(none)';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '(none)';
  return String(value);
}

export function buildSystemPrompt({ profile, recentSummaries = [], recentCorrections = [] } = {}) {
  const lines = [
    RULES,
    '',
    'STUDENT PROFILE',
    `- CEFR level: ${profile.level || 'B1'}`,
    `- Interests: ${fmtList(profile.interests)}`,
    `- Goals: ${profile.goals || '(none stated)'}`,
    `- Weak areas: ${fmtList(profile.weak_areas)}`,
  ];

  if (recentSummaries.length) {
    lines.push('', 'RECENT SESSIONS (most recent first)');
    for (const s of recentSummaries) {
      const date = s.started_at ? s.started_at.slice(0, 10) : '?';
      lines.push(`- [${date}] ${s.summary}`);
      if (s.topics) {
        try {
          const topics = JSON.parse(s.topics);
          if (topics.length) lines.push(`  topics: ${topics.join(', ')}`);
        } catch { /* ignore malformed */ }
      }
    }
  }

  if (recentCorrections.length) {
    lines.push('', 'RECENT CORRECTIONS (avoid letting the same mistake pass silently)');
    for (const c of recentCorrections) {
      lines.push(`- [${c.category}] "${c.original}" → "${c.corrected}"`);
    }
  }

  return lines.join('\n');
}

// ─── End-of-session summary ────────────────────────────────────────────────

export const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'topics', 'weak_areas', 'suggested_level'],
  properties: {
    summary: {
      type: 'string',
      description:
        'Concise recap of the session in 3–5 sentences. Mention what was discussed and how the student performed.',
    },
    topics: {
      type: 'array',
      items: { type: 'string' },
      description: 'Topics covered in this session.',
    },
    weak_areas: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Recurring error patterns or skill gaps to address in future sessions. Keep concrete (e.g. "past tense of irregular verbs", not "grammar").',
    },
    suggested_level: {
      type: 'string',
      enum: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'none'],
      description:
        '"none" if the current level still fits. Otherwise the CEFR level you would recommend based on this session.',
    },
  },
};

export const SUMMARY_SYSTEM = `You are reviewing a conversation between a Spanish-native English learner and their tutor.
Produce a concise recap, the topics covered, the recurring weak areas worth focusing on next time, and your level estimate.
Output ONLY the JSON object that matches the response schema. No prose outside it.`;
