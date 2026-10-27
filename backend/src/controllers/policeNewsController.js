const PoliceNewsArticle = require('../models/PoliceNewsArticle');
const PoliceRssKeyword  = require('../models/PoliceRssKeyword');
const { withTenant } = require('../utils/tenantFilter');
const { validateScopedDistricts, scopedDistrictQuery, districtErrorMessage } = require('../utils/scopedDistricts');
const { logHistory } = require('../services/historyLogService');

const CONFIG_KEYWORDS = [
  'hyderabad police','cyberabad police','rachakonda police','telangana police',
  'murder','robbery','theft','rape','sexual assault','kidnapping','drug trafficking',
  'narcotics','ganja','fraud','cyber crime','extortion','gang','gangster',
  'arrested','arrest','fir','chargesheet','encounter','raid','crackdown',
  'hyderabad','secunderabad','cyberabad','rachakonda','old city',
  'karimnagar','warangal','nizamabad','khammam','nalgonda','rangareddy',
  'pocso','pocso act','child abuse',
  'accident','road accident','hit and run',
  'protest','lathi charge','curfew','communal','riot',
  'హైదరాబాద్','తెలంగాణ','పోలీసు','అరెస్టు','హత్య','నేరం',
  'हैदराबाद','तेलंगाना','पुलिस','गिरफ्तार','हत्या','अपराध',
];

const ADMIN_EMAILS = ['sreenu@gmail.com'];

function canDelete(user) {
  if (!user) return false;
  if (ADMIN_EMAILS.includes(user.email)) return true;
  if (['superadmin', 'super_admin'].includes(user.role)) return true;
  return false;
}

// ── GET /api/police-news ──────────────────────────────────────────────────────
exports.getArticles = async (req, res) => {
  try {
    const { page = 1, limit = 20, search, district, category, source_type, language } = req.query;
    const filter = { ...withTenant(req) };

    if (search) {
      const rx = new RegExp(search, 'i');
      filter.$or = [
        { title: rx }, { title_english: rx }, { summary: rx },
        { summary_english: rx }, { source_name: rx }, { keywords_matched: rx },
      ];
    }
    if (district && district !== 'all')       filter['detected_location.district'] = district;
    if (category && category !== 'all')       filter.category = category;
    if (source_type && source_type !== 'all') filter.source_type = source_type;
    if (language && language !== 'all')       filter.language = language;

    const pageNum  = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10)));
    const skip     = (pageNum - 1) * limitNum;

    const [articles, total] = await Promise.all([
      PoliceNewsArticle.find(filter).sort({ published_date: -1 }).skip(skip).limit(limitNum).lean(),
      PoliceNewsArticle.countDocuments(filter),
    ]);

    res.json({
      articles,
      pagination: { page: pageNum, pages: Math.ceil(total / limitNum), total, limit: limitNum },
      can_delete: canDelete(req.user),
    });
  } catch (err) {
    console.error('[PoliceNews] getArticles error:', err);
    res.status(500).json({ message: 'Failed to fetch police news articles' });
  }
};

// ── DELETE /api/police-news/clear-all ─────────────────────────────────────────
exports.clearAll = async (req, res) => {
  if (!canDelete(req.user)) return res.status(403).json({ message: 'Not authorized' });
  try {
    // Scoped to this tenant only — never wipe other tenants' news.
    const result = await PoliceNewsArticle.deleteMany(withTenant(req));
    res.json({ message: `Deleted ${result.deletedCount} articles`, count: result.deletedCount });
  } catch (err) {
    res.status(500).json({ message: 'Failed to clear articles' });
  }
};

// ── DELETE /api/police-news/:id ───────────────────────────────────────────────
exports.deleteArticle = async (req, res) => {
  if (!canDelete(req.user)) return res.status(403).json({ message: 'Not authorized' });
  try {
    const article = await PoliceNewsArticle.findOneAndDelete(withTenant(req, { _id: req.params.id }));
    if (!article) return res.status(404).json({ message: 'Article not found' });
    res.json({ message: 'Article deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete article' });
  }
};

// ── GET /api/police-news/keywords ─────────────────────────────────────────────
exports.getKeywords = async (req, res) => {
  try {
    // Seed any config keywords not yet in DB — for THIS tenant.
    const existing = await PoliceRssKeyword.find(withTenant(req), { keyword: 1 }).lean();
    const existingSet = new Set(existing.map(k => k.keyword));
    const toInsert = CONFIG_KEYWORDS
      .filter(kw => !existingSet.has(kw))
      .map(kw => ({ tenant_id: req.tenantId, keyword: kw, is_active: true, source: 'config' }));
    if (toInsert.length > 0) {
      await PoliceRssKeyword.insertMany(toInsert, { ordered: false }).catch(() => {});
    }
    // Config (built-in default) keywords apply tenant-wide regardless of district;
    // only user-added keywords are scoped to the officer's own districts.
    const districtFilter = scopedDistrictQuery(req);
    const query = withTenant(req);
    if (districtFilter.districts) {
      query.$or = [{ source: 'config' }, { districts: districtFilter.districts }];
    }
    const keywords = await PoliceRssKeyword.find(query).sort({ source: 1, keyword: 1 }).lean();
    res.json(keywords);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch keywords' });
  }
};

// ── POST /api/police-news/keywords ────────────────────────────────────────────
exports.addKeyword = async (req, res) => {
  const { keyword, state, districts } = req.body;
  if (!keyword?.trim()) return res.status(400).json({ message: 'Keyword is required' });
  const districtCheck = validateScopedDistricts(req, districts);
  if (!districtCheck.ok) {
    return res.status(400).json({ message: districtErrorMessage(districtCheck) });
  }
  try {
    const kw = await PoliceRssKeyword.create({
      tenant_id: req.tenantId,
      keyword: keyword.trim().toLowerCase(),
      is_active: true,
      source: 'user',
      added_by: req.user?.email || '',
      state: state || '',
      districts: districtCheck.districts,
    });
    logHistory(req, { module: 'rss_keywords', action: 'create', recordId: kw._id, recordLabel: kw.keyword, state: kw.state, districts: kw.districts, changes: { keyword: kw.keyword, districts: kw.districts } });
    res.status(201).json(kw);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'Keyword already exists' });
    res.status(500).json({ message: 'Failed to add keyword' });
  }
};

// ── PATCH /api/police-news/keywords/:id ──────────────────────────────────────
exports.toggleKeyword = async (req, res) => {
  try {
    const kw = await PoliceRssKeyword.findOne(withTenant(req, { _id: req.params.id, ...scopedDistrictQuery(req) }));
    if (!kw) return res.status(404).json({ message: 'Keyword not found' });
    kw.is_active = !kw.is_active;
    kw.updated_by = req.user?.email || req.user?.id || '';
    kw.updated_at = new Date();
    await kw.save();
    logHistory(req, { module: 'rss_keywords', action: 'update', recordId: kw._id, recordLabel: kw.keyword, state: kw.state, districts: kw.districts, changes: { is_active: kw.is_active } });
    res.json(kw);
  } catch (err) {
    res.status(500).json({ message: 'Failed to toggle keyword' });
  }
};

// ── DELETE /api/police-news/keywords/:id ─────────────────────────────────────
exports.deleteKeyword = async (req, res) => {
  try {
    const kw = await PoliceRssKeyword.findOneAndDelete(withTenant(req, { _id: req.params.id, ...scopedDistrictQuery(req) }));
    if (!kw) return res.status(404).json({ message: 'Keyword not found' });
    logHistory(req, { module: 'rss_keywords', action: 'delete', recordId: kw._id, recordLabel: kw.keyword, state: kw.state, districts: kw.districts, changes: { keyword: kw.keyword } });
    res.json({ message: 'Keyword deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete keyword' });
  }
};
