// ─── URL Blocker Service Worker ───
// Manages declarativeNetRequest dynamic rules for blocking URLs.

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
  }
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

// BULLETPROOF FALLBACK: Manually intercept and redirect if DNR fails natively
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return; // Only intercept main page loads
  const data = await chrome.storage.local.get({ blockedUrls: [] });
  
  for (const item of data.blockedUrls) {
    // We do a simple includes match since our urlFilter is a substring
    if (details.url.includes(item.urlFilter)) {
      chrome.tabs.update(details.tabId, {
        url: chrome.runtime.getURL('blocked.html')
      });
      break;
    }
  }
});

/**
 * Parses a user-pasted URL into a declarativeNetRequest urlFilter pattern.
 * Strips protocol and query params, keeps hostname + pathname.
 */
function buildUrlFilter(rawUrl) {
  const urlObj = new URL(rawUrl);
  // Strip 'www.' to block the root domain and all its subdomains correctly
  let hostname = urlObj.hostname;
  if (hostname.startsWith('www.')) {
    hostname = hostname.substring(4);
  }
  let pathname = urlObj.pathname;
  // Strip trailing slash for consistency (unless it's just "/")
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }
  // Use a simple substring match instead of || anchoring, which is more resilient
  return `${hostname}${pathname}`;
}

async function addBlockedUrl(rawUrl) {
  try {
    // Validate URL
    const urlObj = new URL(rawUrl);
    const urlFilter = buildUrlFilter(rawUrl);
    
    // Canonical form for duplicate checking
    let host = urlObj.hostname;
    if (host.startsWith('www.')) host = host.substring(4);
    const canonical = `${urlObj.protocol}//${host}${urlObj.pathname.replace(/\/$/, '') || '/'}`;

    // Load existing data
    const data = await chrome.storage.local.get({ blockedUrls: [], nextRuleId: 1 });

    // Check for duplicates
    if (data.blockedUrls.some(item => item.canonical === canonical)) {
      return { success: false, error: 'This URL is already blocked' };
    }

    const ruleId = data.nextRuleId;

    // Create a dynamic redirect rule
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: [{
        id: ruleId,
        priority: 100, // Higher priority to override any default browser allow-lists
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

    // Persist
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
