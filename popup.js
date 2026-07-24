// ─── URL Blocker Popup Logic ───

const urlInput = document.getElementById('urlInput');
const addBtn   = document.getElementById('addBtn');
const urlList  = document.getElementById('urlList');
const countEl  = document.getElementById('count');
const feedback = document.getElementById('feedback');

let feedbackTimer = null;

// ─── Init ───
document.addEventListener('DOMContentLoaded', loadUrls);
addBtn.addEventListener('click', addUrl);
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addUrl();
});

// ─── Load blocked URLs from storage ───
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
    showFeedback('Enter a valid URL (include https://)', 'error');
    return;
  }

  addBtn.disabled = true;
  const response = await chrome.runtime.sendMessage({ action: 'addUrl', url: raw });
  addBtn.disabled = false;

  if (response.success) {
    urlInput.value = '';
    urlInput.focus();
    showFeedback('URL blocked ✓', 'success');
    loadUrls();
  } else {
    showFeedback(response.error, 'error');
  }
}

// ─── Remove a URL ───
async function removeUrl(ruleId) {
  const response = await chrome.runtime.sendMessage({ action: 'removeUrl', id: ruleId });
  if (response.success) {
    showFeedback('URL unblocked', 'success');
    loadUrls();
  } else {
    showFeedback(response.error || 'Failed to remove', 'error');
  }
}

// ─── Render the list ───
function renderList(urls) {
  countEl.textContent = urls.length;

  if (urls.length === 0) {
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
        <p>No URLs blocked yet</p>
        <p class="empty-sub">Paste a URL above to get started</p>
      </div>`;
    return;
  }

  urlList.innerHTML = urls.map(item => `
    <div class="url-item" data-id="${item.id}">
      <div class="url-info">
        <span class="url-text" title="${escapeAttr(item.url)}">${escapeHtml(displayUrl(item.url))}</span>
        <span class="url-date">${formatDate(item.addedAt)}</span>
      </div>
      <button class="btn-remove" data-id="${item.id}" title="Unblock this URL">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>`).join('');

  // Attach click handlers
  urlList.querySelectorAll('.btn-remove').forEach(btn => {
    btn.addEventListener('click', () => removeUrl(Number(btn.dataset.id)));
  });
}

// ─── Feedback toast ───
function showFeedback(message, type) {
  clearTimeout(feedbackTimer);
  feedback.textContent = message;
  feedback.className = `feedback ${type}`;
  feedbackTimer = setTimeout(() => {
    feedback.className = 'feedback hidden';
  }, 2500);
}

// ─── Helpers ───
function displayUrl(url) {
  // Strip protocol for a cleaner display
  return url.replace(/^https?:\/\//, '');
}

function formatDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

function escapeHtml(text) {
  const el = document.createElement('span');
  el.textContent = text;
  return el.innerHTML;
}

function escapeAttr(text) {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
             .replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
