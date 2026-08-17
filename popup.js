// ─── Nopeek Popup Logic ───
// The list deliberately never shows a URL. Seeing the things you're avoiding is
// itself the cue you're trying to avoid, so entries are named, not spelled out.

import { loadGate, saveGate, openGate } from './gate.js';

const welcomeView = document.getElementById('welcomeView');
const welcomeBtn = document.getElementById('welcomeBtn');
const setupView = document.getElementById('setupView');
const setupLead = document.getElementById('setupLead');
const setupConfirm = document.getElementById('setupConfirm');
const currentPhrase = document.getElementById('currentPhrase');
const confirmInput = document.getElementById('confirmInput');
const mainView = document.getElementById('mainView');
const phraseInput = document.getElementById('phraseInput');
const cooldownInput = document.getElementById('cooldownInput');
const tempUnlockInput = document.getElementById('tempUnlockInput');
const saveGateBtn = document.getElementById('saveGateBtn');
const setupCancelBtn = document.getElementById('setupCancelBtn');
const editPhraseBtn = document.getElementById('editPhraseBtn');
const setupFeedback = document.getElementById('setupFeedback');

const urlInput = document.getElementById('urlInput');
const addBtn = document.getElementById('addBtn');
const urlList = document.getElementById('urlList');
const countEl = document.getElementById('count');
const feedback = document.getElementById('feedback');

let feedbackTimer = null;
let gate = null;

// TEMPORARY, for working on the welcome screen: show it on every open instead
// of only before setup. Flip to false to get the first-run-only behaviour back.
const ALWAYS_WELCOME = true;

// ─── Init ───
init();

addBtn.addEventListener('click', addUrl);
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addUrl();
});
// Straight through to the list if there's already a phrase, otherwise on to setup.
welcomeBtn.addEventListener('click', () => (gate.configured ? showMain() : showSetup()));
saveGateBtn.addEventListener('click', submitGate);
editPhraseBtn.addEventListener('click', showSetup);
setupCancelBtn.addEventListener('click', showMain);

// Same reasoning as the gate itself: the new phrase has to be typed, not pasted.
for (const evt of ['paste', 'drop', 'contextmenu']) {
  confirmInput.addEventListener(evt, e => e.preventDefault());
}

async function init() {
  gate = await loadGate();
  if (gate.configured && !ALWAYS_WELCOME) showMain();
  else showWelcome();
}

// ─── Welcome ───
// No stored "seen" flag: it stands in front of setup, so it goes away the
// moment there's a phrase to get back in with, and not before.
function showWelcome() {
  welcomeBtn.textContent = gate.configured ? 'Go on in' : 'Set it up';
  mainView.classList.add('hidden');
  setupView.classList.add('hidden');
  welcomeView.classList.remove('hidden');
  welcomeBtn.focus();
}

// ─── Setup, first-run and edit ───
function showSetup() {
  const editing = gate.configured;

  setupLead.textContent = editing
    ? 'Want a new phrase? Type the old one first.'
    : "Pick the sentence you'll have to type out by hand every time you want back in.";

  setupConfirm.classList.toggle('hidden', !editing);
  setupCancelBtn.classList.toggle('hidden', !editing);
  saveGateBtn.textContent = editing ? 'Replace it' : 'Lock it in';

  if (editing) {
    currentPhrase.textContent = gate.phrase;
    confirmInput.value = '';
    phraseInput.value = gate.phrase;
    cooldownInput.value = String(gate.cooldownSeconds);
    tempUnlockInput.value = String(gate.tempUnlockMinutes);
  }

  welcomeView.classList.add('hidden');
  mainView.classList.add('hidden');
  setupView.classList.remove('hidden');
  (editing ? confirmInput : phraseInput).focus();
}

function showMain() {
  welcomeView.classList.add('hidden');
  setupView.classList.add('hidden');
  mainView.classList.remove('hidden');
  loadUrls();
}

async function submitGate() {
  const response = await saveGate({
    phrase: phraseInput.value,
    cooldownSeconds: Number(cooldownInput.value),
    tempUnlockMinutes: Number(tempUnlockInput.value)
  }, confirmInput.value);

  if (!response.success) {
    showFeedback(response.error, 'error', setupFeedback);
    return;
  }

  gate = await loadGate();
  showMain();
  showFeedback('Phrase saved', 'success');
}

// ─── Load blocked entries from storage ───
async function loadUrls() {
  const response = await chrome.runtime.sendMessage({ action: 'getUrls' });
  renderList(response.urls);
}

// ─── Add a URL ───
async function addUrl() {
  const raw = urlInput.value.trim();
  if (!raw) {
    urlInput.focus();
    return;
  }

  // Basic validation
  try {
    new URL(raw);
  } catch {
    showFeedback('Need a full URL, with https://', 'error');
    return;
  }

  addBtn.disabled = true;
  const response = await chrome.runtime.sendMessage({ action: 'addUrl', url: raw });
  addBtn.disabled = false;

  if (response.success) {
    urlInput.value = '';
    urlInput.focus();
    showFeedback(`Blocked as “${response.alias}”`, 'success');
    loadUrls();
  } else {
    showFeedback(response.error, 'error');
  }
}

// ─── Unblocking goes through the gate ───
async function requestUnblock(entry) {
  const { changed, message } = await openGate(entry, gate);
  if (changed) {
    showFeedback(message, 'success');
    loadUrls();
  }
}

// ─── Render the list ───
function renderList(entries) {
  countEl.textContent = entries.length;

  if (entries.length === 0) {
    urlList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="1.5"
               stroke-linecap="round" stroke-linejoin="round" opacity="0.3">
            <circle cx="12" cy="12" r="10"/>
            <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
          </svg>
        </div>
        <p>Nothing blocked yet</p>
        <p class="empty-sub">Paste one above to start</p>
      </div>`;
    return;
  }

  urlList.innerHTML = entries.map(entry => `
    <div class="url-item" data-id="${entry.id}">
      <div class="url-info">
        <span class="url-alias">${escapeHtml(entry.alias)}</span>
        <span class="url-meta">${escapeHtml(`Blocked ${formatDate(entry.addedAt)}`)}</span>
      </div>
      ${unlockPill(entry)}
      <button class="btn-remove" data-id="${entry.id}" title="Unblock (needs your phrase)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>`).join('');

  // Attach click handlers
  urlList.querySelectorAll('.btn-remove').forEach(btn => {
    const entry = entries.find(item => item.id === Number(btn.dataset.id));
    btn.addEventListener('click', () => requestUnblock(entry));
  });
}

function unlockPill(entry) {
  const remaining = entry.unlockUntil ? entry.unlockUntil - Date.now() : 0;
  if (remaining <= 0) return '';
  return `<span class="unlock-pill">open · ${Math.ceil(remaining / 60000)}m</span>`;
}

function formatDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ─── Feedback toast ───
function showFeedback(message, type, target = feedback) {
  clearTimeout(feedbackTimer);
  target.textContent = message;
  target.className = `feedback ${type}`;
  feedbackTimer = setTimeout(() => {
    target.className = 'feedback hidden';
  }, 2500);
}

// ─── Helpers ───
function escapeHtml(text) {
  const el = document.createElement('span');
  el.textContent = text;
  return el.innerHTML;
}
