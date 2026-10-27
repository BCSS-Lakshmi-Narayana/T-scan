// ── State boundary geometry for the command-centre map ─────────────────────
// Serves a state's district polygons, merged from the bundled AC-level GeoJSON
// and slimmed down for the browser (the raw files are 300–600 KB each, mostly
// coordinate precision nobody can see at dashboard scale).
//
// Two things this deliberately does NOT do:
//   * invent geometry for a district the source file doesn't contain, and
//   * silently substitute a near-name match.
// Instead it reports `coverage`, so the UI can state plainly which districts it
// can draw and which it cannot. In an intelligence product a map that quietly
// mislabels a boundary is worse than no map.
const fs = require('fs');
const path = require('path');

const MAPS_DIR = process.env.MAPS_DIR || path.join(__dirname, '..', 'data', 'maps', 'states');

// Cache per state slug — the files never change at runtime, and parsing a
// 600 KB GeoJSON on every dashboard load would be pure waste.
const cache = new Map();

const slugify = (s) => String(s || '')
  .toLowerCase().trim()
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

// District names drift between sources: "Ranga Reddy" / "RANGAREDDI",
// "Mahabubnagar" / "MAHBUBNAGAR", "Jagitial" / "Jagtial". Compare on letters
// only, and fold the vowels that account for most transliteration variance.
const normDistrict = (s) => String(s || '')
  .toUpperCase()
  .replace(/[^A-Z]/g, '')
  .replace(/AA/g, 'A')
  .replace(/EE/g, 'I')
  .replace(/OO/g, 'U');

// A few names differ by more than spelling drift; map them explicitly rather
// than loosening the matcher (fuzzy matching is how wrong districts get drawn).
//
// IMPORTANT: keys are the output of normDistrict(), i.e. AFTER the vowel folding
// above — so "Komaram Bheem" is keyed KOMARAMBHIM (EE already folded to I), not
// KOMARAMBHEEM. Getting this wrong silently disables the alias.
//
// Both sides are covered because the boundary file and the tenant's own list
// come from different vintages: the file still carries the 2016 names
// (Warangal Rural / Warangal Urban) while Telangana renamed those to
// Warangal / Hanumakonda in 2021.
const ALIASES = {
  RANGAREDDI: 'RANGAREDDY',
  MAHBUBNAGAR: 'MAHABUBNAGAR',
  JAGTIAL: 'JAGITIAL',
  JANGAON: 'JANGOAN',
  WARANGALRURAL: 'WARANGAL',
  WARANGALURBAN: 'HANUMAKONDA',
  KOMARAMBHIM: 'KUMURAMBHIMASIFABAD',
  KOMARAMBHIMASIFABAD: 'KUMURAMBHIMASIFABAD',
  KUMARAMBHIMASIFABAD: 'KUMURAMBHIMASIFABAD',
  ASIFABAD: 'KUMURAMBHIMASIFABAD',
  SIRICILLA: 'RAJANNASIRCILLA',
  SIRSILLA: 'RAJANNASIRCILLA',
  YADADRI: 'YADADRIBHUVANAGIRI',
  BHUVANAGIRI: 'YADADRIBHUVANAGIRI',
  MEDCHAL: 'MEDCHALMALKAJGIRI'
};
const canon = (s) => {
  const n = normDistrict(s);
  return ALIASES[n] || n;
};

// Round coordinates to ~11 m. Far finer than a dashboard map can show, and it
// cuts payload roughly in half.
const PRECISION = 4;
const roundRing = (ring) => ring.map(([x, y]) => [
  Math.round(x * 10 ** PRECISION) / 10 ** PRECISION,
  Math.round(y * 10 ** PRECISION) / 10 ** PRECISION
]);

// Drop points that barely move the outline. Perpendicular-distance decimation:
// cheap, order-preserving, and safe for rendering (it is not used for any
// spatial computation, only for drawing).
const simplifyRing = (ring, tolerance) => {
  if (ring.length <= 5) return ring;
  const out = [ring[0]];
  let [ax, ay] = ring[0];
  for (let i = 1; i < ring.length - 1; i += 1) {
    const [x, y] = ring[i];
    if (Math.abs(x - ax) > tolerance || Math.abs(y - ay) > tolerance) {
      out.push(ring[i]);
      ax = x; ay = y;
    }
  }
  out.push(ring[ring.length - 1]);
  return out.length >= 4 ? out : ring;
};

const polygonsOf = (geometry) => {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
};

const ringArea = (ring) => {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    a += (ring[j][0] * ring[i][1]) - (ring[i][0] * ring[j][1]);
  }
  return Math.abs(a / 2);
};

/**
 * Load a state's districts as draw-ready polygon groups.
 * Returns { state, districts: [{ name, key, polygons, bbox }], bbox }
 * where each `polygons` entry is an array of outer rings (holes are dropped —
 * they are not meaningful at this scale and complicate the SVG path).
 */
const loadState = (stateName) => {
  const slug = slugify(stateName);
  if (!slug) return null;
  if (cache.has(slug)) return cache.get(slug);

  const file = path.join(MAPS_DIR, `${slug}.geojson`);
  if (!fs.existsSync(file)) {
    cache.set(slug, null);
    return null;
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    cache.set(slug, null);
    return null;
  }

  // Group AC-level features up to their district.
  const byDistrict = new Map();
  for (const f of raw.features || []) {
    const name = f.properties?.DIST_NAME || f.properties?.district || f.properties?.DISTRICT;
    if (!name) continue;
    const key = canon(name);
    if (!byDistrict.has(key)) byDistrict.set(key, { name, key, polygons: [] });
    for (const poly of polygonsOf(f.geometry)) {
      // poly[0] is the outer ring; ignore interior rings.
      const outer = poly[0];
      if (!outer || outer.length < 4) continue;
      byDistrict.get(key).polygons.push(outer);
    }
  }

  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  const districts = [];

  for (const d of byDistrict.values()) {
    // Keep only meaningful pieces: the largest ring plus anything at least 5%
    // of it, so real islands/exclaves survive but slivers don't bloat payload.
    const withArea = d.polygons.map((r) => ({ r, a: ringArea(r) })).sort((p, q) => q.a - p.a);
    const biggest = withArea[0]?.a || 0;
    const kept = withArea.filter((p) => p.a >= biggest * 0.05).slice(0, 12);

    const polygons = kept.map(({ r }) => simplifyRing(roundRing(r), 0.004)).filter((r) => r.length >= 4);
    if (!polygons.length) continue;

    let dMinX = Infinity; let dMinY = Infinity; let dMaxX = -Infinity; let dMaxY = -Infinity;
    for (const ring of polygons) {
      for (const [x, y] of ring) {
        if (x < dMinX) dMinX = x; if (x > dMaxX) dMaxX = x;
        if (y < dMinY) dMinY = y; if (y > dMaxY) dMaxY = y;
      }
    }
    if (dMinX < minX) minX = dMinX; if (dMaxX > maxX) maxX = dMaxX;
    if (dMinY < minY) minY = dMinY; if (dMaxY > maxY) maxY = dMaxY;

    districts.push({ name: d.name, key: d.key, polygons, bbox: [dMinX, dMinY, dMaxX, dMaxY] });
  }

  const result = districts.length
    ? { state: stateName, slug, districts, bbox: [minX, minY, maxX, maxY] }
    : null;
  cache.set(slug, result);
  return result;
};

/**
 * Map a tenant's district list onto the loaded geometry.
 * `matched`  — tenant districts we can draw, with the geometry key to use.
 * `unmapped` — tenant districts with no geometry in the source file.
 * `extra`    — geometry present in the file but not in the tenant's list.
 */
const matchDistricts = (geo, tenantDistricts = []) => {
  if (!geo) return { matched: [], unmapped: tenantDistricts, extra: [] };
  const byKey = new Map(geo.districts.map((d) => [d.key, d]));
  const used = new Set();
  const matched = [];
  const unmapped = [];

  for (const name of tenantDistricts) {
    const key = canon(name);
    if (byKey.has(key)) {
      matched.push({ district: name, key });
      used.add(key);
    } else {
      unmapped.push(name);
    }
  }
  const extra = geo.districts.filter((d) => !used.has(d.key)).map((d) => d.name);
  return { matched, unmapped, extra };
};

const listAvailableStates = () => {
  try {
    return fs.readdirSync(MAPS_DIR).filter((f) => f.endsWith('.geojson')).map((f) => f.replace('.geojson', ''));
  } catch (_) {
    return [];
  }
};

module.exports = { loadState, matchDistricts, canon, slugify, listAvailableStates, MAPS_DIR };
