// ─── At-Rest Encryption ───
// Blocked URLs are AES-GCM encrypted so the stored blocklist carries no readable
// hostname — opening the popup shouldn't put the thing you're avoiding back in
// front of you.
//
// HONEST SCOPE: the service worker has to decrypt these to match navigations, so
// the key sits in chrome.storage.local next to the ciphertext. This defeats a
// glance at your own blocklist, not a determined you with devtools open. That is
// the intended bar — a scheme you genuinely couldn't reverse would brick your
// browsing the day you forgot something.

const KEY_STORAGE = 'cryptoKey';

let keyPromise = null;

/** Returns the AES-GCM CryptoKey, generating and persisting one on first use. */
function getOrCreateKey() {
  if (!keyPromise) keyPromise = loadOrGenerateKey();
  return keyPromise;
}

async function loadOrGenerateKey() {
  const stored = await chrome.storage.local.get(KEY_STORAGE);

  if (stored[KEY_STORAGE]) {
    return crypto.subtle.importKey(
      'jwk', stored[KEY_STORAGE], { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']
    );
  }

  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
  );
  const jwk = await crypto.subtle.exportKey('jwk', key);
  await chrome.storage.local.set({ [KEY_STORAGE]: jwk });
  return key;
}

/** Encrypts a plain object into a storable `{ iv, ct }` pair of base64 strings. */
export async function encryptJson(obj) {
  const key = await getOrCreateKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(obj));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);

  return { iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) };
}

/** Reverses encryptJson. Returns null when the record can't be decrypted. */
export async function decryptJson(record) {
  if (!record || !record.iv || !record.ct) return null;
  try {
    const key = await getOrCreateKey();
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(record.iv) }, key, fromBase64(record.ct)
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return null;
  }
}

/** Hex SHA-256 — used to derive stable codenames from a canonical URL. */
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function toBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
