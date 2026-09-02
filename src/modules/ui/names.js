/**
 * Player-facing names for entities the simulation does not name itself: streets, districts, buildings.
 * Deterministic — a hash of the entity's geometry / id, never Math.random — so the same segment shows the same
 * street name in every session and every collinear segment of a straight road shares one name (like a real grid).
 * Engine ids (s54, n30 → n31, lot 88) are only appended with `?debug`.
 */
export const DEBUG = typeof location !== 'undefined' && /[?&]debug(=|&|$)/.test(location.search);

const STEMS = ['Harbour', 'Maple', 'Oak', 'Elm', 'Cedar', 'Birch', 'Willow', 'Riverside', 'Lakeview', 'Hill', 'Park', 'Church', 'Market', 'Mill', 'Station', 'Bridge', 'King', 'Queen', 'Victoria', 'Albert', 'Union', 'Liberty', 'Lincoln', 'Meadow', 'Orchard', 'Highland', 'Sunset', 'Ocean', 'Bay', 'Pine', 'Chestnut', 'Aspen', 'Foundry', 'Cannery', 'Granite', 'Copper', 'Iron', 'Spring', 'Summer', 'Beacon', 'Fable', 'Windmill', 'Anchor', 'Garden', 'Vine', 'Hazel', 'Linden', 'Poplar', 'Rowan', 'Juniper'];
const SUFFIX = {
  local: ['Street', 'Road', 'Lane', 'Drive', 'Street', 'Way'],
  avenue: ['Avenue', 'Boulevard', 'Avenue', 'Parkway'],
  highway: ['Highway', 'Expressway', 'Motorway'],
  path: ['Walk', 'Path', 'Promenade', 'Trail'],
};
const DISTRICTS = ['Old Town', 'Harbourside', 'Northgate', 'Riverbend', 'Kingsfield', 'Ironworks', 'Sunny Slopes', 'Westmarch', 'Elmwood', 'Fable Heights', 'Saltmarsh', 'Greenvale', 'Crown Hill', 'Foundry District', 'Lakeside', 'Meadowbrook', 'Eastbank', 'Copperfield', 'Millbrook', 'Southgate'];
const RES_LOW = ['{S} Cottage', 'The {S}s', '{S} House', '{S} Villa', 'Little {S}'];
const RES_HIGH = ['{S} Court', '{S} Towers', '{S} Residences', '{S} Heights', '{S} Gardens', '{S} Terrace'];
const COM_LOW = ['{S} Deli', '{S} Bakery', '{S} Corner Store', '{S} Café', '{S} Pharmacy', '{S} Books', '{S} Barbers', '{S} Grocer'];
const COM_HIGH = ['{S} Mall', '{S} Plaza', 'Hotel {S}', '{S} Galleria', '{S} Department Store', '{S} Arcade'];
const IND = ['{S} Works', '{S} Foundry', '{S} Logistics', '{S} Mill', '{S} Fabrication', '{S} Freight', '{S} Timber Co.'];
const OFFICE = ['{S} Technologies', '{S} & Partners', '{S} Holdings', '{S} Financial', '{S} Software', '{S} Consulting', '{S} Media'];
const BY_ZONE = { 'res-low': RES_LOW, 'res-high': RES_HIGH, 'com-low': COM_LOW, 'com-high': COM_HIGH, ind: IND, office: OFFICE };

/** 32-bit FNV-1a of a string → unsigned int. */
export function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
/** `seed >>> n` keeps the hash unsigned — a signed shift would index the list negatively. */
const pick = (list, seed) => list[Math.abs(Math.trunc(seed)) % list.length];

/** District from a coarse 256 m cell — neighbouring lots and roads share it. */
export function districtName(x, z) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  const cx = Math.floor(x / 256), cz = Math.floor(z / 256);
  return pick(DISTRICTS, hash(`d:${cx}:${cz}`));
}

/** Street name for a road segment. Collinear straight segments (same axis, same line) share the name. */
export function streetName(seg) {
  if (!seg) return 'Road';
  if (seg.name) return seg.name;
  const type = SUFFIX[seg.type] ? seg.type : 'local';
  const pts = seg.points && seg.points.length >= 2 ? seg.points : null;
  let key;
  if (pts) {
    const a = pts[0], b = pts[pts.length - 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const alongX = Math.abs(dx) >= Math.abs(dz);
    // line coordinate quantised to 16 m; straight roads on the same line hash identically
    const lineCoord = alongX ? (a.z + b.z) / 2 : (a.x + b.x) / 2;
    key = `${type}:${alongX ? 'x' : 'z'}:${Math.round(lineCoord / 16)}`;
  } else key = `${type}:${seg.id ?? '0'}`;
  const hsh = hash(key);
  const stem = pick(STEMS, hsh);
  if (type === 'highway' && (hsh >>> 8) % 3 === 0) return `Route ${1 + ((hsh >>> 12) % 89)}`;
  return `${stem} ${pick(SUFFIX[type], hsh >>> 6)}`;
}

/** Business / residence name for a zoned building. */
export function buildingName(b, zoneLabel) {
  if (!b) return zoneLabel || 'Building';
  if (b.name) return b.name;
  const list = BY_ZONE[b.type];
  if (!list) return zoneLabel || 'Building';
  const hsh = hash(`b:${b.id ?? ''}:${Math.round(b.x || 0)}:${Math.round(b.z || 0)}`);
  return pick(list, hsh >>> 4).replace('{S}', pick(STEMS, hsh));
}

/** ' · s54' style engine-id suffix, only with ?debug. */
export const debugId = (...parts) => (DEBUG ? ' · ' + parts.filter((p) => p != null && p !== '').join(' ') : '');
