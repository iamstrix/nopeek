// ─── The Gate ───
// The last stand between an impulse and an unblocked site: your own sentence,
// on screen, retyped by hand, after a cooldown. Nothing here is a security
// boundary — it's a speed bump placed exactly where you're moving fastest.

const overlay = document.getElementById('gateOverlay');
const aliasEl = document.getElementById('gateAlias');
const leadEl = document.getElementById('gateLead');
const phraseEl = document.getElementById('gatePhrase');
const inputEl = document.getElementById('gateInput');
const progressBar = document.getElementById('gateProgressBar');
const statusEl = document.getElementById('gateStatus');
const cancelBtn = document.getElementById('gateCancelBtn');
const tempBtn = document.getElementById('gateTempBtn');
const removeBtn = document.getElementById('gateRemoveBtn');

let session = null;

/** Fetches the configured phrase and timings. */
export async function loadGate() {
  return chrome.runtime.sendMessage({ action: 'getGate' });
}

export async function saveGate(settings, confirm) {
  return chrome.runtime.sendMessage({ action: 'setGate', settings, confirm });
}

/**
 * Opens the gate for one entry. Resolves `true` if the blocklist changed
 * (removed or temporarily unlocked), `false` if the user backed out.
 */
export function openGate(entry, gate) {
  return new Promise((resolve) => {
    session = { entry, gate, resolve, timer: null, unlockedAt: 0 };

    aliasEl.textContent = entry.alias;
    leadEl.textContent = entry.hits
      ? `Blocked ${entry.hits} ${entry.hits === 1 ? 'time' : 'times'}. Still want in?`
      : 'Still want in?';
    phraseEl.textContent = gate.phrase;
    tempBtn.textContent = `Open ${gate.tempUnlockMinutes}m`;

    inputEl.value = '';
    statusEl.textContent = '';
    progressBar.style.width = '0%';
    setArmed(false);

    overlay.classList.remove('hidden');
    inputEl.focus();

    startCooldown();
  });
}

// ─── Cooldown ───

/**
 * The countdown survives the popup closing — Chrome tears the popup down the
 * moment it loses focus, and restarting the timer every time would make the
 * gate impossible rather than merely annoying.
 */
async function startCooldown() {
  const { entry, gate } = session;
  const key = `cooldown:${entry.id}`;

  if (gate.cooldownSeconds <= 0) {
    session.unlockedAt = Date.now();
    tick();
    return;
  }

  const stored = await chrome.storage.session.get(key);
  let startedAt = stored[key];

  if (!startedAt || Date.now() - startedAt > gate.cooldownSeconds * 1000 * 4) {
    startedAt = Date.now();
    await chrome.storage.session.set({ [key]: startedAt });
  }

  session.unlockedAt = startedAt + gate.cooldownSeconds * 1000;
  session.timer = setInterval(tick, 250);
  tick();
}

function tick() {
  if (!session) return;
  const remaining = Math.max(0, session.unlockedAt - Date.now());

  if (remaining > 0) {
    statusEl.textContent = `Available in ${Math.ceil(remaining / 1000)}s…`;
    statusEl.className = 'gate-status waiting';
    setArmed(false);
    return;
  }

  clearInterval(session.timer);
  session.timer = null;
  evaluate();
}

// ─── Typing ───

function correctPrefixLength(typed, phrase) {
  let i = 0;
  while (i < typed.length && i < phrase.length && typed[i] === phrase[i]) i++;
  return i;
}

function evaluate() {
  if (!session) return;
  const phrase = session.gate.phrase;
  const typed = inputEl.value;
  const correct = correctPrefixLength(typed, phrase);

  progressBar.style.width = `${Math.round((correct / phrase.length) * 100)}%`;

  const cooling = Date.now() < session.unlockedAt;
  const matches = typed.trim() === phrase.trim();

  if (cooling) return;

  if (matches) {
    statusEl.textContent = 'Go on, then.';
    statusEl.className = 'gate-status ready';
  } else if (typed.length && correct < typed.length) {
    statusEl.textContent = 'Typo. Start that word again.';
    statusEl.className = 'gate-status wrong';
    progressBar.classList.add('wrong');
  } else {
    statusEl.textContent = `${correct} / ${phrase.length}`;
    statusEl.className = 'gate-status';
  }

  if (correct === typed.length) progressBar.classList.remove('wrong');
  setArmed(matches);
}

function setArmed(armed) {
  tempBtn.disabled = !armed;
  removeBtn.disabled = !armed;
}

inputEl.addEventListener('input', evaluate);

// Typing it out IS the friction — every shortcut around that is closed off.
for (const evt of ['paste', 'drop', 'contextmenu']) {
  inputEl.addEventListener(evt, e => e.preventDefault());
}
inputEl.addEventListener('beforeinput', (e) => {
  if (e.inputType === 'insertFromPaste' || e.inputType === 'insertFromDrop') {
    e.preventDefault();
  }
});

// A stray newline would silently stop the text matching, and Enter must never
// fall through to the destructive button.
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') e.preventDefault();
});

// ─── Outcomes ───

cancelBtn.addEventListener('click', () => close(false, true));

tempBtn.addEventListener('click', async () => {
  const { entry, gate } = session;
  const response = await chrome.runtime.sendMessage({
    action: 'tempUnlock', id: entry.id, confirm: inputEl.value
  });
  finish(response, `Open for ${gate.tempUnlockMinutes} minutes.`);
});

removeBtn.addEventListener('click', async () => {
  const response = await chrome.runtime.sendMessage({
    action: 'removeUrl', id: session.entry.id, confirm: inputEl.value
  });
  finish(response, 'Unblocked.');
});

function finish(response, successMessage) {
  if (response && response.success) {
    close(true, true, successMessage);
  } else {
    statusEl.textContent = (response && response.error) || 'That did not work';
    statusEl.className = 'gate-status wrong';
  }
}

async function close(changed, clearCooldown, message) {
  if (!session) return;
  const { entry, resolve } = session;

  clearInterval(session.timer);
  if (clearCooldown) await chrome.storage.session.remove(`cooldown:${entry.id}`);

  overlay.classList.add('hidden');
  inputEl.value = '';
  progressBar.classList.remove('wrong');
  session = null;

  resolve({ changed, message });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && session) close(false, true);
});
