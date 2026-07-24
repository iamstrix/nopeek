// ─── ex-it Service Worker ───
// Manages declarativeNetRequest dynamic rules and per-tab navigation tracking.

// In-memory tracker for the last safe (unblocked) URL per tab
const lastSafeUrlMap = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'addUrl':
      addBlockedUrl(message.url).then(sendResponse);
      return true;
    case 'removeUrl':
      removeBlockedUrl(message.id).then(sendResponse);
      return true;
    case 'getUrls':
      getBlockedUrls().then(sendResponse);
      return true;
    case 'goBack':
      handleGoBack(sender.tab).then(sendResponse);
      return true;
  }
});

// Clean up tracker when tabs close
chrome.tabs.onRemoved.addListener((tabId) => {
  lastSafeUrlMap.delete(tabId);
});

// Sync dynamic rules with stored blocked URLs whenever extension starts or updates
chrome.runtime.onInstalled.addListener(() => {
  syncRules();
});

chrome.runtime.onStartup.addListener(() => {
  syncRules();
});

// Run initial sync on service worker load
syncRules();

/**
 * Reconciles declarativeNetRequest dynamic rules with stored URLs in chrome.storage.local.
 * Preserves user data across extension reloads and browser resets while keeping DNR rules in sync.
 */
async function syncRules() {
  try {
    const data = await chrome.storage.local.get({ blockedUrls: [] });
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const existingRuleIds = existingRules.map(r => r.id);

    const rulesToAdd = data.blockedUrls.map(item => ({
      id: item.id,
      priority: 100,
      action: {
        type: 'redirect',
        redirect: { extensionPath: '/blocked.html' }
      },
      condition: {
        urlFilter: item.urlFilter,
        resourceTypes: ['main_frame']
      }
    }));

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existingRuleIds,
      addRules: rulesToAdd
    });
  } catch (err) {
    console.error('Failed to sync DNR rules:', err);
  }
}

/**
 * Records safe URLs per tab so "Go Back" can reliably return to the last safe website
 * without getting trapped in history loops.
 */
async function trackSafeUrl(tabId, url) {
  if (!url || url.startsWith('chrome-extension://') || url.startsWith('chrome://') || url.startsWith('about:')) {
    return;
  }
  const data = await chrome.storage.local.get({ blockedUrls: [] });
  const isBlocked = data.blockedUrls.some(item => url.includes(item.urlFilter));
  if (!isBlocked) {
    lastSafeUrlMap.set(tabId, url);
  }
}

// Track safe navigations
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  trackSafeUrl(details.tabId, details.url);
});

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0) return;
  trackSafeUrl(details.tabId, details.url);
});

// Fallback navigation inspector
async function checkNavigation(details) {
  if (details.frameId !== 0) return; // Only intercept main page loads
  const data = await chrome.storage.local.get({ blockedUrls: [] });
  
  for (const item of data.blockedUrls) {
    if (details.url.includes(item.urlFilter)) {
      chrome.tabs.update(details.tabId, {
        url: chrome.runtime.getURL('blocked.html')
      });
      break;
    }
  }
}

// Intercept standard full page loads
chrome.webNavigation.onBeforeNavigate.addListener(checkNavigation);

// Intercept Single Page Application (SPA) client-side route changes
chrome.webNavigation.onHistoryStateUpdated.addListener(checkNavigation);

/**
 * Navigates the tab to its last recorded safe URL, avoiding history loops.
 */
async function handleGoBack(tab) {
  if (!tab || !tab.id) return { success: false };
  const safeUrl = lastSafeUrlMap.get(tab.id);
  if (safeUrl) {
    await chrome.tabs.update(tab.id, { url: safeUrl });
  } else {
    // If there is no previous safe URL for this tab (e.g. opened directly), go to new tab / blank
    await chrome.tabs.update(tab.id, { url: 'about:blank' });
  }
  return { success: true };
}

/**
 * Parses a user-pasted URL into a declarativeNetRequest urlFilter pattern.
 */
function buildUrlFilter(rawUrl) {
  const urlObj = new URL(rawUrl);
  let hostname = urlObj.hostname;
  if (hostname.startsWith('www.')) {
    hostname = hostname.substring(4);
  }
  let pathname = urlObj.pathname;
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }
  return `${hostname}${pathname}`;
}

async function addBlockedUrl(rawUrl) {
  try {
    const urlObj = new URL(rawUrl);
    const urlFilter = buildUrlFilter(rawUrl);
    
    let host = urlObj.hostname;
    if (host.startsWith('www.')) host = host.substring(4);
    const canonical = `${urlObj.protocol}//${host}${urlObj.pathname.replace(/\/$/, '') || '/'}`;

    const data = await chrome.storage.local.get({ blockedUrls: [], nextRuleId: 1 });

    if (data.blockedUrls.some(item => item.canonical === canonical)) {
      return { success: false, error: 'This URL is already blocked' };
    }

    const ruleId = data.nextRuleId;

    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: [{
        id: ruleId,
        priority: 100,
        action: {
          type: 'redirect',
          redirect: { extensionPath: '/blocked.html' }
        },
        condition: {
          urlFilter,
          resourceTypes: ['main_frame']
        }
      }]
    });

    data.blockedUrls.push({
      id: ruleId,
      url: rawUrl,
      canonical,
      urlFilter,
      addedAt: Date.now()
    });

    await chrome.storage.local.set({
      blockedUrls: data.blockedUrls,
      nextRuleId: ruleId + 1
    });

    // Auto-redirect any existing open tabs that match the newly blocked URL
    try {
      const openTabs = await chrome.tabs.query({});
      for (const tab of openTabs) {
        if (tab.url && tab.url.includes(urlFilter)) {
          chrome.tabs.update(tab.id, {
            url: chrome.runtime.getURL('blocked.html')
          });
        }
      }
    } catch (tabErr) {
      console.error('Failed to auto-redirect open matching tabs:', tabErr);
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function removeBlockedUrl(ruleId) {
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [ruleId]
    });

    const data = await chrome.storage.local.get({ blockedUrls: [] });
    data.blockedUrls = data.blockedUrls.filter(item => item.id !== ruleId);
    await chrome.storage.local.set({ blockedUrls: data.blockedUrls });

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function getBlockedUrls() {
  const data = await chrome.storage.local.get({ blockedUrls: [] });
  return { urls: data.blockedUrls };
}
