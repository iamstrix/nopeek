// ─── Codenames ───
// The popup never renders a blocked URL, it renders one of these. Words are
// deliberately drab — minerals, terrain, plants — so nothing in the list can
// point back at what it stands for.

import { sha256Hex } from './crypto-utils.js';

const ADJECTIVES = [
  'amber', 'ashen', 'azure', 'briny', 'bronze', 'chalk', 'cobalt', 'copper',
  'coral', 'crisp', 'dusty', 'ember', 'faded', 'flint', 'frost', 'glassy',
  'golden', 'hazel', 'hollow', 'indigo', 'ivory', 'jade', 'linen', 'marble',
  'mellow', 'misty', 'muted', 'ochre', 'olive', 'opal', 'pale', 'pewter',
  'quiet', 'rustic', 'sable', 'sage', 'sandy', 'silver', 'slate', 'smoky',
  'soft', 'spruce', 'still', 'sunlit', 'tawny', 'teal', 'velvet', 'wintry'
];

const NOUNS = [
  'anchor', 'arbor', 'badger', 'basin', 'beacon', 'bramble', 'canyon', 'cedar',
  'cinder', 'cliff', 'clover', 'cove', 'dune', 'falcon', 'fathom', 'fern',
  'ferry', 'garnet', 'gully', 'harbor', 'heather', 'heron', 'juniper', 'kestrel',
  'lantern', 'ledger', 'marsh', 'meadow', 'mesa', 'orchard', 'otter', 'pebble',
  'pillar', 'quarry', 'ridge', 'sparrow', 'spindle', 'tangle', 'thicket',
  'thistle', 'timber', 'trellis', 'valley', 'vessel', 'warren', 'willow',
  'window', 'yarrow'
];

/**
 * Deterministic codename for a canonical URL — the same site always earns the
 * same name, so re-blocking something you removed feels continuous.
 * `taken` is a Set/array of aliases already in use; collisions get a numeric suffix.
 */
export async function aliasFor(canonical, taken = []) {
  const hash = await sha256Hex(canonical);
  const adjective = ADJECTIVES[parseInt(hash.slice(0, 4), 16) % ADJECTIVES.length];
  const noun = NOUNS[parseInt(hash.slice(4, 8), 16) % NOUNS.length];

  const base = `${adjective}-${noun}`;
  const used = new Set(taken);
  if (!used.has(base)) return base;

  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}
