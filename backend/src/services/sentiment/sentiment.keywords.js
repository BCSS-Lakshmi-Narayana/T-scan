/**
 * Tenant keyword matching (soceye's matchKeywords), scoped to the post's districts.
 * Matches are shown as detected keywords and can raise an alert; they never change the score.
 */

const WEIGHT = 50;

const normalize = (value) => String(value || '').toLowerCase().trim();

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whole word/phrase match, case-insensitive, any script: 'mob' does not match
 * 'mobile', 'hate' does not match 'whatever'. Letters, digits and combining
 * marks (Indic vowel signs) count as part of a word.
 */
const containsTerm = (text, term) => {
  const needle = normalize(term);
  if (!needle) return false;
  return new RegExp(`(^|[^\\p{L}\\p{M}\\p{N}])${escapeRe(needle)}(?![\\p{L}\\p{M}\\p{N}])`, 'iu').test(String(text || ''));
};

/**
 * Keywords that apply to content in `districts`:
 *   keyword without districts  -> tenant-wide, always applies
 *   keyword with districts     -> only content from those districts
 *   content without districts  -> every keyword applies
 */
const applicableKeywords = (keywords, districts) => {
  const list = Array.isArray(keywords) ? keywords : [];
  const contentDistricts = Array.isArray(districts) ? districts.filter(Boolean) : [];
  if (contentDistricts.length === 0) return list;
  return list.filter((k) => {
    const kd = Array.isArray(k.districts) ? k.districts.filter(Boolean) : [];
    return kd.length === 0 || kd.some((d) => contentDistricts.includes(d));
  });
};

/**
 * @returns {Array<{keyword: string, weight: number, category: string}>} unique by keyword
 */
const matchKeywords = (text, keywords, districts = []) => {
  const hay = normalize(text);
  if (!hay) return [];
  const found = new Map();
  for (const k of applicableKeywords(keywords, districts)) {
    const needle = normalize(k.keyword);
    if (!needle || found.has(needle)) continue;
    if (containsTerm(hay, needle)) found.set(needle, { keyword: String(k.keyword), weight: WEIGHT, category: 'other' });
  }
  return [...found.values()];
};

module.exports = { matchKeywords, applicableKeywords, normalize, containsTerm };
