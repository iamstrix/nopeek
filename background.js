// ─── Nopeek Service Worker ───
// Manages declarativeNetRequest dynamic rules, per-tab navigation tracking, the
// encrypted blocklist, and the shame-phrase gate.
//
// Blocked URLs are only ever stored encrypted. They are decrypted once into
// `entryCache` so navigation matching never touches storage or ciphertext on the
// hot path.

import { encryptJson, decryptJson } from './crypto-utils.js';
import { aliasFor } from './codename.js';
import { parseTarget, matchesEntry, dnrFilterFor, blockedPagePath } from './url-match.js';

const SCHEMA_VERSION = 2;
const HIT_DEBOUNCE_MS = 2000;

// In-memory tracker for the last safe (unblocked) URL per tab
const lastSafeUrlMap = new Map();

// Decrypted entries: { id, host, path, urlFilter, canonical, alias, hits, unlockUntil }
let entryCache = [];

// Suppresses double-counting when both navigation listeners see the same block
const recentHits = new Map();

// Serializes cache rebuilds so overlapping refreshes can't interleave
let refreshChain = Promise.resolve();

// Everything waits on this: migration must finish before any rule or match runs.
// It deliberately never rejects — every message handler is chained off it, and a
// rejection would leave the popup awaiting a response that never arrives.
const ready = (async () => {
  try {
    await migrate();
    await refreshCache();
    await reconcileExpiredUnlocks();
    await syncRules();
  } catch (err) {
    console.error('Nopeek failed to initialize:', err);
  }
})();

// ─── Messaging ───

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'addUrl':
      ready.then(() => addBlockedUrl(message.url)).then(sendResponse);
      return true;
    case 'removeUrl':
      ready.then(() => removeBlockedUrl(message.id, message.confirm)).then(sendResponse);
      return true;
    case 'tempUnlock':
      ready.then(() => tempUnlock(message.id, message.confirm)).then(sendResponse);
      return true;
    case 'getUrls':
      ready.then(getBlockedUrls).then(sendResponse);
      return true;
    case 'getGate':
      getGate().then(gate => sendResponse({
        configured: Boolean(gate),
        phrase: gate ? gate.phrase : '',
        cooldownSeconds: gate ? gate.cooldownSeconds : 30,
        tempUnlockMinutes: gate ? gate.tempUnlockMinutes : 15
      }));
      return true;
    case 'setGate':
      setGate(message.settings, message.confirm).then(sendResponse);
      return true;
    case 'getEntryMeta':
      ready.then(() => getEntryMeta(message.id)).then(sendResponse);
      return true;
    case 'goBack':
      handleGoBack(sender.tab).then(sendResponse);
      return true;
  }
});

// Clean up trackers when tabs close
chrome.tabs.onRemoved.addListener((tabId) => {
  lastSafeUrlMap.delete(tabId);
  for (const key of recentHits.keys()) {
    if (key.startsWith(`${tabId}:`)) recentHits.delete(key);
  }
});

chrome.runtime.onInstalled.addListener(() => { ready.then(syncRules); });
chrome.runtime.onStartup.addListener(() => { ready.then(syncRules); });

// Safety net if storage is changed from anywhere other than our own mutations
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.blockedUrls) refreshCache();
});

// ─── Storage schema ───

/**
 * Converts a v1 (plaintext) blocklist to the v2 encrypted schema, preserving
 * every entry's id and addedAt so DNR rule ids and list ordering stay stable.
 */
async function migrate() {
  const data = await chrome.storage.local.get({ schemaVersion: 1, blockedUrls: [] });
  if (data.schemaVersion === SCHEMA_VERSION) return;

  const taken = [];
  const migrated = [];

  for (const item of data.blockedUrls) {
    // Already encrypted (a partial migration) — carry it through untouched.
    if (item.ct && item.iv) {
      taken.push(item.alias);
      migrated.push(item);
      continue;
    }
    try {
      const target = parseTarget(item.url);
      const alias = await aliasFor(target.canonical, taken);
      taken.push(alias);
      migrated.push({
        id: item.id,
        ...(await encryptJson(target)),
        alias,
        addedAt: item.addedAt || Date.now(),
        hits: 0,
        lastHitAt: null,
        unlockUntil: null
      });
    } catch (err) {
      console.error('Skipping unmigratable entry', item.id, err);
    }
  }

  await chrome.storage.local.set({
    blockedUrls: migrated,
    schemaVersion: SCHEMA_VERSION
  });
}

/** Decrypts the stored blocklist into `entryCache`. */
function refreshCache() {
  refreshChain = refreshChain.then(async () => {
    const data = await chrome.storage.local.get({ blockedUrls: [] });
    const decrypted = [];

    for (const item of data.blockedUrls) {
      const target = await decryptJson(item);
      if (!target) {
        console.error('Could not decrypt entry', item.id);
        continue;
      }
      decrypted.push({
        id: item.id,
        host: target.host,
        path: target.path,
        urlFilter: target.urlFilter,
        canonical: target.canonical,
        alias: item.alias,
        addedAt: item.addedAt,
        hits: item.hits || 0,
        unlockUntil: item.unlockUntil || null
      });
    }

    entryCache = decrypted;
  }).catch(err => console.error('Failed to refresh entry cache:', err));

  return refreshChain;
}

/** Applies a mutation to the stored blocklist and rebuilds the cache. */
async function updateStoredEntry(id, mutate) {
  const data = await chrome.storage.local.get({ blockedUrls: [] });
  const entry = data.blockedUrls.find(item => item.id === id);
  if (!entry) return false;

  mutate(entry);
  await chrome.storage.local.set({ blockedUrls: data.blockedUrls });
  await refreshCache();
  return true;
}

// ─── declarativeNetRequest rules ───

// The `?e=<id>` on the redirect target is what lets the block page name the
// entry. If a Chromium build rejects a query string in extensionPath it would
// reject the whole updateDynamicRules call and leave us with no rules at all,
// so we degrade to a bare path instead of losing the DNR layer entirely.
let supportsQueryRedirect = true;

function ruleFor(entry) {
  return {
    id: entry.id,
    priority: 100,
    action: {
      type: 'redirect',
      redirect: {
        extensionPath: supportsQueryRedirect ? blockedPagePath(entry.id) : '/blocked.html'
      }
    },
    condition: {
      urlFilter: dnrFilterFor(entry),
      resourceTypes: ['main_frame']
    }
  };
}

function isUnlocked(entry) {
  return Boolean(entry.unlockUntil && Date.now() < entry.unlockUntil);
}

/**
 * Reconciles dynamic rules with the decrypted cache. Temporarily unlocked
 * entries deliberately get no rule.
 */
async function syncRules() {
  const existingRules = await chrome.declarativeNetRequest.getDynamicRules().catch(() => []);
  const removeRuleIds = existingRules.map(r => r.id);
  const active = entryCache.filter(e => !isUnlocked(e));

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds, addRules: active.map(ruleFor)
    });
  } catch (err) {
    if (!supportsQueryRedirect) {
      console.error('Failed to sync DNR rules:', err);
      return;
    }
    console.warn('Redirect with query string rejected, falling back to a bare block page:', err);
    supportsQueryRedirect = false;
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds, addRules: active.map(ruleFor)
      });
    } catch (retryErr) {
      console.error('Failed to sync DNR rules:', retryErr);
    }
  }
}

/**
 * Adds (or replaces) one entry's rule, falling back to a full resync — which
 * carries the query-redirect fallback — if the single-rule write is rejected.
 */
async function putRule(entry) {
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [entry.id],
      addRules: [ruleFor(entry)]
    });
  } catch (err) {
    console.warn('Single rule write failed, resyncing:', err);
    await syncRules();
  }
}

/**
 * Clears unlock windows that lapsed while the browser (or the service worker)
 * was asleep, so a missed alarm can't leave a site permanently open.
 */
async function reconcileExpiredUnlocks() {
  const data = await chrome.storage.local.get({ blockedUrls: [] });
  let changed = false;

  for (const item of data.blockedUrls) {
    if (item.unlockUntil && Date.now() >= item.unlockUntil) {
      item.unlockUntil = null;
      changed = true;
    } else if (item.unlockUntil) {
      // Still open — make sure the relock alarm survived the restart.
      chrome.alarms.create(`relock:${item.id}`, { when: item.unlockUntil });
    }
  }

  if (changed) {
    await chrome.storage.local.set({ blockedUrls: data.blockedUrls });
    await refreshCache();
  }
}

// ─── Navigation tracking ───

/**
 * Records safe URLs per tab so "Go Back" can reliably return to the last safe
 * website without getting trapped in history loops.
 */
function trackSafeUrl(tabId, url) {
  if (!url || url.startsWith('chrome-extension://') || url.startsWith('chrome://') || url.startsWith('about:')) {
    return;
  }
  if (!entryCache.some(entry => matchesEntry(url, entry))) {
    lastSafeUrlMap.set(tabId, url);
  }
}

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  await ready;
  trackSafeUrl(details.tabId, details.url);
});

/**
 * Fallback navigation inspector, for the cases where a DNR redirect never fires:
 * SPA route changes (X/Twitter profile navigation) and Chromium forks that treat
 * extension-path redirects unreliably.
 */
async function checkNavigation(details, isHistoryUpdate) {
  if (details.frameId !== 0) return;
  await ready;

  const entry = entryCache.find(item => matchesEntry(details.url, item));
  if (!entry) return;

  countHit(details.tabId, entry.id);

  // Only rewind for client-side route changes: the blocked SPA state is already
  // on the history stack, so without this "Go Back" lands right back on it. A
  // full page load hasn't committed yet, so there is nothing to erase.
  if (isHistoryUpdate) {
    try {
      await chrome.tabs.goBack(details.tabId);
    } catch {
      // Tab has no previous history entry — the redirect below still applies.
    }
  }

  await chrome.tabs.update(details.tabId, {
    url: chrome.runtime.getURL(blockedPagePath(entry.id))
  });
}

chrome.webNavigation.onBeforeNavigate.addListener(d => checkNavigation(d, false));

chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  if (details.frameId !== 0) return;
  await ready;
  trackSafeUrl(details.tabId, details.url);
  await checkNavigation(details, true);
});

/**
 * Increments the visit counter, ignoring repeats of the same block within a
 * short window so one navigation seen by two listeners only counts once.
 *
 * `hits` / `lastHitAt` are diagnostics only — nothing in the UI surfaces them.
 * Showing someone their own relapse count is a scoreboard for shame, not help.
 */
function countHit(tabId, entryId) {
  const key = `${tabId}:${entryId}`;
  const now = Date.now();
  const last = recentHits.get(key);
  if (last && now - last < HIT_DEBOUNCE_MS) return;

  recentHits.set(key, now);
  updateStoredEntry(entryId, entry => {
    entry.hits = (entry.hits || 0) + 1;
    entry.lastHitAt = now;
  });
}

/** Navigates the tab to its last recorded safe URL, avoiding history loops. */
async function handleGoBack(tab) {
  if (!tab || !tab.id) return { success: false };
  try {
    await chrome.tabs.goBack(tab.id);
  } catch {
    const safeUrl = lastSafeUrlMap.get(tab.id);
    await chrome.tabs.update(tab.id, { url: safeUrl || 'about:blank' });
  }
  return { success: true };
}

// ─── Blocklist mutations ───

async function addBlockedUrl(rawUrl) {
  try {
    const target = parseTarget(rawUrl);

    if (entryCache.some(entry => entry.canonical === target.canonical)) {
      return { success: false, error: 'Already blocked.' };
    }

    const data = await chrome.storage.local.get({ blockedUrls: [], nextRuleId: 1 });
    const ruleId = data.nextRuleId;
    const alias = await aliasFor(target.canonical, data.blockedUrls.map(i => i.alias));

    data.blockedUrls.push({
      id: ruleId,
      ...(await encryptJson(target)),
      alias,
      addedAt: Date.now(),
      hits: 0,
      lastHitAt: null,
      unlockUntil: null
    });

    await chrome.storage.local.set({
      blockedUrls: data.blockedUrls,
      nextRuleId: ruleId + 1
    });
    await refreshCache();

    const entry = entryCache.find(item => item.id === ruleId);
    await putRule(entry);
    await redirectMatchingTabs(entry);

    return { success: true, alias };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function removeBlockedUrl(ruleId, confirm) {
  try {
    const gateError = await checkGate(confirm);
    if (gateError) return gateError;

    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [ruleId] });
    chrome.alarms.clear(`relock:${ruleId}`);

    const data = await chrome.storage.local.get({ blockedUrls: [] });
    data.blockedUrls = data.blockedUrls.filter(item => item.id !== ruleId);
    await chrome.storage.local.set({ blockedUrls: data.blockedUrls });
    await refreshCache();

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Opens a blocked site for a fixed window, then re-blocks it. A reversible lapse
 * is a better outcome than deleting the entry outright.
 */
async function tempUnlock(ruleId, confirm) {
  try {
    const gateError = await checkGate(confirm);
    if (gateError) return gateError;

    const gate = await getGate();
    const minutes = gate ? gate.tempUnlockMinutes : 15;
    const unlockUntil = Date.now() + minutes * 60 * 1000;

    const found = await updateStoredEntry(ruleId, entry => { entry.unlockUntil = unlockUntil; });
    if (!found) return { success: false, error: "That one's gone." };

    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [ruleId] });
    chrome.alarms.create(`relock:${ruleId}`, { when: unlockUntil });

    return { success: true, unlockUntil, minutes };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith('relock:')) return;
  await ready;

  const ruleId = Number(alarm.name.slice('relock:'.length));
  const found = await updateStoredEntry(ruleId, entry => { entry.unlockUntil = null; });
  if (!found) return;

  const entry = entryCache.find(item => item.id === ruleId);
  if (!entry) return;

  await putRule(entry);
  await redirectMatchingTabs(entry);
});

/** Sends any open tab sitting on a (re)blocked site to the block page. */
async function redirectMatchingTabs(entry) {
  try {
    const openTabs = await chrome.tabs.query({});
    for (const tab of openTabs) {
      if (tab.url && matchesEntry(tab.url, entry)) {
        chrome.tabs.update(tab.id, {
          url: chrome.runtime.getURL(blockedPagePath(entry.id))
        });
      }
    }
  } catch (err) {
    console.error('Failed to redirect open matching tabs:', err);
  }
}

async function getBlockedUrls() {
  // Deliberately never returns the URL — the popup has no use for it and
  // rendering it would defeat the point of encrypting it.
  return {
    urls: entryCache.map(entry => ({
      id: entry.id,
      alias: entry.alias,
      addedAt: entry.addedAt,
      hits: entry.hits,
      unlockUntil: entry.unlockUntil
    })).sort((a, b) => b.id - a.id)
  };
}

async function getEntryMeta(id) {
  const entry = entryCache.find(item => item.id === Number(id));
  return entry ? { alias: entry.alias, hits: entry.hits } : { alias: null, hits: 0 };
}

// ─── The gate ───

async function getGate() {
  const data = await chrome.storage.local.get({ gate: null });
  return data.gate;
}

/**
 * Enforced here rather than in the popup so the gate can't be stepped around
 * with a stray sendMessage from a console.
 */
async function checkGate(confirm) {
  const gate = await getGate();
  if (!gate) return { success: false, error: 'Set your phrase first.' };
  if ((confirm || '').trim() !== gate.phrase.trim()) {
    return { success: false, error: "That's not the phrase." };
  }
  return null;
}

async function setGate(settings, confirm) {
  const existing = await getGate();

  // Changing an established phrase is itself a gated action.
  if (existing) {
    const gateError = await checkGate(confirm);
    if (gateError) return gateError;
  }

  const phrase = (settings.phrase || '').trim().replace(/\s+/g, ' ');
  if (phrase.length < 12) {
    return { success: false, error: 'Too short — 12 characters minimum.' };
  }

  await chrome.storage.local.set({
    gate: {
      phrase,
      cooldownSeconds: Number(settings.cooldownSeconds) || 0,
      tempUnlockMinutes: Number(settings.tempUnlockMinutes) || 15
    }
  });

  return { success: true };
}
