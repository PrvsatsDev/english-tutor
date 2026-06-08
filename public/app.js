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
const userSelect = $('user-select');
const newUserDialog = $('new-user-dialog');
const newUserForm = $('new-user-form');
const deleteUserDialog = $('delete-user-dialog');

const LAST_USER_KEY = 'tutor.lastUserId';
const NEW_USER_VALUE = '__new__';
const DELETE_USER_VALUE = '__delete__';

let knownUsers = [];

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
let currentUserId = null;

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

// ─── Users ─────────────────────────────────────────────────────────────────

// Rebuild the header dropdown from the server's user list, plus trailing
// "new user" / "delete user" entries. Also handles a refresh after a deletion:
// if the active user vanished, reset and prompt for a new pick.
function populateUsers(users) {
  knownUsers = users;
  const activeGone = currentUserId != null && !users.some((u) => u.id === currentUserId);
  if (activeGone) {
    if (localStorage.getItem(LAST_USER_KEY) === String(currentUserId)) {
      localStorage.removeItem(LAST_USER_KEY);
    }
    currentUserId = null;
    resetSessionUI();
    sessionInfo.textContent = '';
    endBtn.disabled = true;
  }

  userSelect.innerHTML = '';
  if (currentUserId == null) {
    const ph = new Option('— Select user —', '');
    ph.disabled = true;
    userSelect.add(ph);
  }
  for (const u of users) userSelect.add(new Option(u.name, String(u.id)));
  userSelect.add(new Option('➕ New user…', NEW_USER_VALUE));
  if (users.length > 1) userSelect.add(new Option('🗑 Delete a user…', DELETE_USER_VALUE));
  userSelect.disabled = false;

  const stored = localStorage.getItem(LAST_USER_KEY);
  const known = users.some((u) => String(u.id) === stored);
  if (currentUserId != null) {
    userSelect.value = String(currentUserId);
  } else if (stored && known) {
    userSelect.value = stored;
    selectUser(Number(stored));
  } else {
    userSelect.value = '';
    setStatus('pick a user to start', '');
  }
}

// Make sure the dropdown has an option for this user (e.g. a just-created one
// that wasn't in the original list), then mark it selected.
function ensureUserOption(id, name) {
  const val = String(id);
  if (![...userSelect.options].some((o) => o.value === val)) {
    const newOpt = [...userSelect.options].find((o) => o.value === NEW_USER_VALUE);
    userSelect.add(new Option(name || `User ${id}`, val), newOpt || null);
  }
  // Drop the disabled "— Select user —" placeholder once we have a real user.
  const ph = [...userSelect.options].find((o) => o.value === '');
  if (ph) ph.remove();
  userSelect.value = val;
}

function selectUser(id) {
  if (ws?.readyState !== WebSocket.OPEN) return;
  resetSessionUI();
  ws.send(JSON.stringify({ type: 'select_user', user_id: id }));
}

// Clear per-session UI when starting fresh or switching users.
function resetSessionUI() {
  chatEl.innerHTML = '<div class="placeholder">Hold <kbd>Space</kbd> to speak.</div>';
  renderCorrections([]);
  renderPhrases([]);
  turnCount = 0;
  totalTokensIn = 0;
  totalTokensOut = 0;
  stats.turns.textContent = '0';
  stats.timings.textContent = '—';
  stats.tokens.textContent = '0 / 0';
  setState('connecting');
}

// Reset the dropdown to the active user (or the placeholder) so a special
// action entry never stays selected.
function restoreSelectValue() {
  userSelect.value = currentUserId != null ? String(currentUserId) : '';
}

userSelect.addEventListener('change', () => {
  const val = userSelect.value;
  if (val === NEW_USER_VALUE) {
    restoreSelectValue();
    newUserForm.reset();
    $('new-user-level').value = 'B1';
    newUserDialog.showModal();
    $('new-user-name').focus();
    return;
  }
  if (val === DELETE_USER_VALUE) {
    restoreSelectValue();
    openDeleteDialog();
    return;
  }
  if (!val) return;
  const id = Number(val);
  if (id === currentUserId) return;
  selectUser(id);
});

newUserForm.addEventListener('submit', (e) => {
  const name = $('new-user-name').value.trim();
  const level = $('new-user-level').value;
  const interests = $('new-user-interests').value.trim();
  const goals = $('new-user-goals').value.trim();
  if (!name) { e.preventDefault(); return; }
  // method="dialog" closes the dialog; we just fire the request.
  if (ws?.readyState === WebSocket.OPEN) {
    resetSessionUI();
    ws.send(JSON.stringify({ type: 'create_user', name, level, interests, goals }));
  }
});

$('new-user-cancel').addEventListener('click', () => newUserDialog.close());

// Build the delete dialog from the last known user list, with a per-row
// delete button guarded by a confirm().
function openDeleteDialog() {
  const list = $('delete-user-list');
  list.innerHTML = '';
  for (const u of knownUsers) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = u.name + (u.id === currentUserId ? ' (current)' : '');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'danger';
    btn.textContent = 'Delete';
    btn.addEventListener('click', () => {
      if (!confirm(`Delete "${u.name}" and all their data? This cannot be undone.`)) return;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'delete_user', user_id: u.id }));
      }
      deleteUserDialog.close();
    });
    li.append(name, btn);
    list.appendChild(li);
  }
  deleteUserDialog.showModal();
}

$('delete-user-close').addEventListener('click', () => deleteUserDialog.close());

// ─── WebSocket ─────────────────────────────────────────────────────────────

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/voice`);
  ws.binaryType = 'blob';

  ws.onopen = () => {
    setStatus('connected', 'ok');
    // "End" stays disabled until a user is selected and a session starts.
    endBtn.disabled = true;
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
    case 'users':
      populateUsers(msg.users);
      break;

    case 'session_start':
      currentUserId = msg.userId;
      currentLevel = msg.profile.level || null;
      localStorage.setItem(LAST_USER_KEY, String(msg.userId));
      ensureUserOption(msg.userId, msg.userName);
      sessionInfo.textContent = `Session #${msg.sessionId} · ${msg.memory.summaries} prior summaries · ${msg.memory.corrections} prior corrections`;
      stats.level.textContent = currentLevel || '—';
      endBtn.disabled = false;
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
      // A switch finalizes the previous user's session in the background;
      // don't interrupt with their summary dialog.
      if (msg.reason === 'switch') break;
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
