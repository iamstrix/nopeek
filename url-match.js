// ─── URL Normalization & Matching ───
// Every decision about "does this navigation hit a blocked entry?" lives here.
// Previously this was a bare `navUrl.includes(urlFilter)`, which matched any
// substring anywhere in the URL — blocking `x.com` also blocked `netflix.com`
// and anything carrying `?ref=x.com`.

/**
 * Normalizes a user-pasted URL into the pieces every other module needs.
 * Strips `www.` and any trailing slash so `https://www.site.com/a/` and
 * `http://site.com/a` collapse to the same entry.
 */
export function parseTarget(rawUrl) {
  const urlObj = new URL(rawUrl);

  if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
    throw new Error('Only http and https URLs can be blocked');
  }

  const host = urlObj.hostname.replace(/^www\./, '').toLowerCase();
  if (!host) throw new Error('That URL has no hostname');

  let path = urlObj.pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  if (path === '/') path = '';

  return {
    url: rawUrl,
    canonical: `${host}${path}` || host,
    host,
    path,
    urlFilter: `${host}${path}`
  };
}

/**
 * True when a navigation should be blocked by this entry.
 * Matches the host itself plus any subdomain, and — when the entry has a path —
 * only that path or a deeper segment beneath it.
 */
export function matchesEntry(navUrl, entry) {
  if (!entry || !entry.host) return false;
  if (entry.unlockUntil && Date.now() < entry.unlockUntil) return false;

  let u;
  try {
    u = new URL(navUrl);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;

  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  if (host !== entry.host && !host.endsWith('.' + entry.host)) return false;

  if (!entry.path) return true;

  const path = u.pathname.length > 1 ? u.pathname.replace(/\/$/, '') : u.pathname;
  return path === entry.path || path.startsWith(entry.path + '/');
}

/**
 * Builds the declarativeNetRequest pattern for an entry.
 * `||host^` anchors to the domain (and its subdomains) instead of matching the
 * hostname as a floating substring.
 */
export function dnrFilterFor(entry) {
  return entry.path ? `||${entry.host}${entry.path}` : `||${entry.host}^`;
}

/** Where a blocked navigation is sent. The id lets blocked.html name the entry. */
export function blockedPagePath(entryId) {
  return `/blocked.html?e=${entryId}`;
}
