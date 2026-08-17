// ─── Blocked Page Handlers ───
// Separate JS file to comply with extension CSP (no inline event handlers).
//
// This page shows the entry's codename, but never the URL and never a way out.
// The block page is the moment of peak temptation, so it stays a dead end by
// design — no counters, no scoreboard, nothing to argue with.

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('goBackBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'goBack' });
  });

  document.getElementById('closeTabBtn').addEventListener('click', () => {
    window.close();
  });

  showTally();
});

async function showTally() {
  const entryId = new URLSearchParams(location.search).get('e');
  if (!entryId) return;

  const meta = await chrome.runtime.sendMessage({ action: 'getEntryMeta', id: entryId });
  if (!meta || !meta.alias) return;

  const tally = document.getElementById('tally');

  tally.innerHTML = '';
  // No <br>: .alias is a block, so the codename already sits on its own line.
  tally.append(
    buildAlias(meta.alias),
    document.createTextNode("Take a breath. You're doing fine.")
  );
}

function buildAlias(alias) {
  const el = document.createElement('span');
  el.className = 'alias';
  el.textContent = alias;
  return el;
}
