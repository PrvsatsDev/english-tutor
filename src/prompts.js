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

export function buildSystemPrompt(profile) {
  const lines = [
    RULES,
    '',
    'STUDENT PROFILE',
    `- CEFR level: ${profile.level || 'B1'}`,
    `- Interests: ${fmtList(profile.interests)}`,
    `- Goals: ${profile.goals || '(none stated)'}`,
    `- Weak areas: ${fmtList(profile.weak_areas)}`,
  ];
  return lines.join('\n');
}
