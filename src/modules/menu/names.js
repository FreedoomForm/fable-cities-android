/**
 * Deterministic city-name suggestions for the start screen.
 * Same seed → same suggestion, so a screenshot of the menu is reproducible.
 */
import { makeRng } from '../../shared/random.js';

const PREFIX = ['New', 'Port', 'Fort', 'Lake', 'Mount', 'Cape', 'North', 'East', 'West', 'South', 'Old', 'Saint', 'Great', 'Little', 'Upper'];
const ROOT = [
  'Fable', 'Haven', 'Ridge', 'Harbour', 'Vale', 'Crest', 'Reach', 'Marrow', 'Hollow', 'Aster',
  'Kessel', 'Bramble', 'Quill', 'Alder', 'Thorne', 'Sable', 'Wren', 'Larkin', 'Hallow', 'Vesper',
  'Corbin', 'Marlow', 'Ember', 'Ashby', 'Dunmore', 'Selby', 'Ravel', 'Halcyon', 'Belden', 'Ferrow',
];
const SUFFIX = ['ton', 'ford', 'burgh', 'stead', 'mouth', 'bury', 'field', 'wick', 'holm', 'gate', 'shore', 'dale', 'moor', 'bridge'];
const STANDALONE = ['Bay', 'Falls', 'Point', 'Junction', 'Crossing', 'Landing', 'Heights', 'Springs', 'Basin', 'Quarry', 'Sound', 'Mills'];

/** A plausible city name derived from `seed`. */
export function suggestName(seed) {
  const rng = makeRng((seed >>> 0) ^ 0x5f3a91);
  const root = rng.pick(ROOT);
  const shape = rng();
  if (shape < 0.3) return `${rng.pick(PREFIX)} ${root}`;
  if (shape < 0.62) return `${root}${rng.pick(SUFFIX)}`;
  if (shape < 0.84) return `${root} ${rng.pick(STANDALONE)}`;
  return `${rng.pick(PREFIX)} ${root}${rng.pick(SUFFIX)}`;
}

/** A fresh seed in the 0…999999 range the seed field accepts. */
export function randomSeed() {
  const buf = new Uint32Array(1);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(buf);
  else buf[0] = (Math.random() * 0xffffffff) >>> 0;
  return buf[0] % 1000000;
}
