const HistoryLog = require('../models/HistoryLog');
const { withTenant } = require('../utils/tenantFilter');
const { scopedDistrictMatch } = require('../utils/scopedDistricts');

// @desc    Get history logs (paginated)
// @route   GET /api/history-logs
// @access  Private (admin/superadmin by default, officers if granted)
const getHistoryLogs = async (req, res) => {
  try {
    const { page = 1, limit = 25, module: moduleFilter, action, user_id, state, district, start_date, end_date, search } = req.query;

    // District scoping: officers only ever see their own assigned district(s)'
    // history, even if they pass a different ?district= value — an officer can
    // never widen their view outside their own districts. Admins may filter to
    // any single district or see the whole tenant when no district is picked.
    const districtMatch = scopedDistrictMatch(req, district);
    const query = withTenant(req, districtMatch || {});

    if (moduleFilter && moduleFilter !== 'all') query.module = moduleFilter;
    if (action && action !== 'all') query.action = action;
    if (user_id) query.performed_by_id = user_id;
    if (state && state !== 'all') query.state = state;

    if (start_date || end_date) {
      query.created_at = {};
      if (start_date) query.created_at.$gte = new Date(start_date);
      if (end_date) {
        const end = new Date(end_date);
        end.setHours(23, 59, 59, 999);
        query.created_at.$lte = end;
      }
    }

    if (search && search.trim()) {
      const escaped = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [
        { record_label: { $regex: escaped, $options: 'i' } },
        { performed_by_name: { $regex: escaped, $options: 'i' } },
        { performed_by_email: { $regex: escaped, $options: 'i' } }
      ];
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 200);
    const skip = (pageNum - 1) * limitNum;

    const [data, total] = await Promise.all([
      HistoryLog.find(query).sort({ created_at: -1 }).skip(skip).limit(limitNum).lean(),
      HistoryLog.countDocuments(query)
    ]);

    res.status(200).json({
      data,
      total,
      page: pageNum,
      pages: Math.max(Math.ceil(total / limitNum), 1)
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { getHistoryLogs };
