// English Tutor — push-to-talk frontend.
// State machine: connecting → idle → recording → processing → idle (loop), or ended.

const $ = (id) => document.getElementById(id);
const chatEl       = $('chat');
const correctionsEl = $('corrections');
const phrasesEl    = $('phrases');
const pttEl        = $('ptt');
const pttLabel     = $('ptt-label');
const statusEl     = $('status');
const endBtn       = $('end-btn');
const sessionInfo  = $('session-info');
const summaryDialog = $('summary-dialog');
const vocabDialog = $('vocab-dialog');
const vocabBtn = $('vocab-btn');

const stats = {
  level: $('stat-level'),
  turns: $('stat-turns'),
  timings: $('stat-timings'),
  tokens: $('stat-tokens'),
};

let state = 'connecting';
let ws = null;
let mediaStream = null;
let recorder = null;
let chunks = [];
let totalTokensIn = 0;
let totalTokensOut = 0;
let turnCount = 0;
let currentLevel = null;

function setState(next) {
  state = next;
  pttEl.classList.remove('idle', 'recording', 'processing', 'disabled');
  switch (state) {
    case 'connecting':
      pttEl.classList.add('disabled');
      pttLabel.innerHTML = 'Connecting…';
      break;
    case 'idle':
      pttEl.classList.add('idle');
      pttLabel.innerHTML = 'Hold <kbd>Space</kbd> to talk';
      break;
    case 'recording':
      pttEl.classList.add('recording');
      pttLabel.innerHTML = 'Recording… release <kbd>Space</kbd> to send';
      break;
    case 'processing':
      pttEl.classList.add('processing');
      pttLabel.innerHTML = 'Thinking…';
      break;
    case 'ended':
      pttEl.classList.add('disabled');
      pttLabel.innerHTML = 'Session ended';
      endBtn.disabled = true;
      break;
  }
}

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = 'status ' + kind;
}

function clearPlaceholder() {
  const ph = chatEl.querySelector('.placeholder');
  if (ph) ph.remove();
}

function addBubble(role, text, { pending = false, audioUrl = null } = {}) {
  clearPlaceholder();
  const div = document.createElement('div');
  div.className = `bubble ${role}${pending ? ' pending' : ''}`;
  div.innerHTML = `<span class="role">${role === 'user' ? 'You' : 'Tutor'}</span>`;
  const span = document.createElement('span');
  span.textContent = text;
  div.appendChild(span);
  if (audioUrl) attachReplay(div, audioUrl);
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
  return div;
}

function attachReplay(bubble, url) {
  // Avoid duplicate buttons if called twice
  bubble.querySelector('.replay')?.remove();
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'replay';
  btn.title = 'Play your recording';
  btn.textContent = '▶';
  btn.addEventListener('click', () => { new Audio(url).play().catch(() => {}); });
  bubble.appendChild(btn);
}

function renderCorrections(items) {
  correctionsEl.innerHTML = '';
  if (!items.length) {
    correctionsEl.innerHTML = '<li class="muted">— none —</li>';
    return;
  }
  for (const c of items) {
    const li = document.createElement('li');
    li.className = 'correction';
    if (c.id) li.dataset.correctionId = c.id;
    li.innerHTML = `
      <span class="cat">${c.category}</span>
      <span class="orig">${escapeHtml(c.original)}</span>
      → <span class="corr">${escapeHtml(c.corrected)}</span>
      <span class="why">${escapeHtml(c.explanation)}</span>
    `;
    if (c.id) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'resolve';
      btn.title = "Mark as understood — stops being injected in future sessions";
      btn.textContent = '✓';
      btn.addEventListener('click', () => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'mark_understood', correction_id: c.id }));
        }
      });
      li.appendChild(btn);
    }
    correctionsEl.appendChild(li);
  }
}

function renderPhrases(items) {
  phrasesEl.innerHTML = '';
  if (!items.length) {
    phrasesEl.innerHTML = '<li class="muted">— none —</li>';
    return;
  }
  for (const p of items) {
    const li = document.createElement('li');
    li.textContent = '• ' + p;
    phrasesEl.appendChild(li);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function playAudio(b64) {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.play().catch((err) => console.warn('audio play failed:', err));
  audio.onended = () => URL.revokeObjectURL(url);
}

// ─── WebSocket ─────────────────────────────────────────────────────────────

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/voice`);
  ws.binaryType = 'blob';

  ws.onopen = () => {
    setStatus('connected', 'ok');
    endBtn.disabled = false;
  };

  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); }
    catch { console.error('bad ws message', e.data); return; }
    handleServerMessage(msg);
  };

  ws.onclose = () => {
    setStatus('disconnected');
    if (state !== 'ended') setState('ended');
  };

  ws.onerror = (e) => {
    console.error('ws error', e);
    setStatus('connection error', 'error');
  };
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'session_start':
      currentLevel = msg.profile.level || null;
      sessionInfo.textContent = `Session #${msg.sessionId} · ${msg.memory.summaries} prior summaries · ${msg.memory.corrections} prior corrections`;
      stats.level.textContent = currentLevel || '—';
      setState('idle');
      break;

    case 'turn': {
      // Promote the pending "..." bubble to the real transcript, then add tutor reply
      let userBubble = chatEl.querySelector('.bubble.pending');
      if (userBubble) {
        userBubble.classList.remove('pending');
        userBubble.querySelector('span:last-child').textContent = msg.transcript;
      } else {
        userBubble = addBubble('user', msg.transcript);
      }
      if (msg.user_audio_url) attachReplay(userBubble, msg.user_audio_url);
      addBubble('tutor', msg.response.spoken);
      renderCorrections(msg.response.corrections);
      renderPhrases(msg.response.suggested_phrases);

      turnCount += 1;
      stats.turns.textContent = turnCount;
      const t = msg.timings;
      stats.timings.textContent = `${t.stt_ms} / ${t.llm_ms} / ${t.tts_ms} ms`;
      totalTokensIn  += msg.usage.input_tokens + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0);
      totalTokensOut += msg.usage.output_tokens;
      stats.tokens.textContent = `${totalTokensIn} / ${totalTokensOut}`;

      if (msg.response.level_signal !== 'none') {
        setStatus(`level signal: ${msg.response.level_signal}`, 'ok');
      }

      playAudio(msg.audio_b64);
      setState('idle');
      break;
    }

    case 'summary':
      if (msg.summary) {
        $('summary-text').textContent = msg.summary.summary;
        $('summary-topics').textContent = msg.summary.topics.join(', ') || '—';
        $('summary-weak').textContent = msg.summary.weak_areas.join('; ') || '—';

        const applyBtn = $('apply-level-btn');
        const appliedTag = $('level-applied');
        applyBtn.hidden = true;
        appliedTag.hidden = true;
        delete applyBtn.dataset.proposedTo;

        if (msg.summary.level_change_proposed) {
          const { from, to } = msg.summary.level_change_proposed;
          $('summary-level').textContent = `${from} → ${to}`;
          applyBtn.textContent = `Apply ${to}`;
          applyBtn.dataset.proposedTo = to;
          applyBtn.hidden = false;
        } else {
          $('summary-level').textContent =
            msg.summary.suggested_level === 'none'
              ? `${currentLevel} (unchanged)`
              : `${msg.summary.suggested_level} (unchanged)`;
        }
        summaryDialog.showModal();
      }
      setState('ended');
      break;

    case 'profile_updated': {
      currentLevel = msg.level;
      stats.level.textContent = msg.level;
      $('apply-level-btn').hidden = true;
      $('level-applied').hidden = false;
      setStatus(`level updated → ${msg.level}`, 'ok');
      break;
    }

    case 'correction_resolved': {
      const li = correctionsEl.querySelector(`li[data-correction-id="${msg.correction_id}"]`);
      if (li) li.classList.add('resolved');
      break;
    }

    case 'vocabulary': {
      const list = $('vocab-list');
      const empty = $('vocab-empty');
      list.innerHTML = '';
      if (!msg.items.length) {
        empty.hidden = false;
      } else {
        empty.hidden = true;
        for (const v of msg.items) {
          const li = document.createElement('li');
          const word = document.createElement('span');
          word.textContent = v.word;
          const when = document.createElement('span');
          when.className = 'when';
          when.textContent = v.introduced_at?.slice(0, 10) || '';
          li.append(word, when);
          list.appendChild(li);
        }
      }
      vocabDialog.showModal();
      break;
    }

    case 'error': {
      setStatus(`server: ${msg.message}`, 'error');
      // Recover from per-turn errors so the user can retry
      const pending = chatEl.querySelector('.bubble.pending');
      if (pending) pending.remove();
      if (state === 'processing') setState('idle');
      break;
    }
  }
}

// ─── Recording ─────────────────────────────────────────────────────────────

async function ensureMic() {
  if (mediaStream) return true;
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return true;
  } catch (err) {
    setStatus(`mic blocked: ${err.message}`, 'error');
    return false;
  }
}

async function startRecording() {
  if (state !== 'idle') return;
  if (!(await ensureMic())) return;

  chunks = [];
  recorder = new MediaRecorder(mediaStream, { mimeType: 'audio/webm;codecs=opus' });
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: 'audio/webm' });
    if (blob.size < 1000) {
      setStatus('utterance too short', 'error');
      setState('idle');
      return;
    }
    setState('processing');
    addBubble('user', '…', { pending: true });
    ws.send(blob);
  };
  recorder.start();
  setState('recording');
  setStatus('');
}

function stopRecording() {
  if (state !== 'recording') return;
  recorder?.stop();
}

// ─── Keyboard ──────────────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat) return;
  // Don't hijack space if the user is typing in something (defensive)
  if (e.target?.matches?.('input, textarea, [contenteditable]')) return;
  e.preventDefault();
  startRecording();
});
document.addEventListener('keyup', (e) => {
  if (e.code !== 'Space') return;
  if (e.target?.matches?.('input, textarea, [contenteditable]')) return;
  e.preventDefault();
  stopRecording();
});

// Click-to-talk fallback (long press on the indicator)
pttEl.addEventListener('mousedown', startRecording);
pttEl.addEventListener('mouseup',   stopRecording);
pttEl.addEventListener('mouseleave', stopRecording);
pttEl.addEventListener('touchstart', (e) => { e.preventDefault(); startRecording(); });
pttEl.addEventListener('touchend',   (e) => { e.preventDefault(); stopRecording(); });

endBtn.addEventListener('click', () => {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'end' }));
});

vocabBtn.addEventListener('click', () => {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'get_vocabulary' }));
  }
});

$('apply-level-btn').addEventListener('click', () => {
  const to = $('apply-level-btn').dataset.proposedTo;
  if (!to) return;
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'apply_level', level: to }));
  }
});

// When the user dismisses the summary dialog, ask the server to close
// the WebSocket cleanly (don't rely on tab-close to do it).
summaryDialog.addEventListener('close', () => {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'close' }));
  }
});

connect();
