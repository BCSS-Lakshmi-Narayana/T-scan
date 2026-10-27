const AuditLog = require('../models/AuditLog');
const { withTenant } = require('../utils/tenantFilter');

// @desc    Get audit logs
// @route   GET /api/audit
// @access  Private
const getAuditLogs = async (req, res) => {
  try {
    const { limit = 100, resource_type, action, user_id, start_date, end_date } = req.query;
    const query = withTenant(req);

    if (resource_type && resource_type !== 'all') query.resource_type = resource_type;
    if (action && action !== 'all') query.action = action;
    if (user_id) query.user_id = user_id;

    if (start_date || end_date) {
      query.timestamp = {};
      if (start_date) {
        query.timestamp.$gte = new Date(start_date);
      }
      if (end_date) {
        const end = new Date(end_date);
        end.setHours(23, 59, 59, 999);
        query.timestamp.$lte = end;
      }
    }


    const logs = await AuditLog.find(query)
      .sort({ timestamp: -1 })
      .limit(parseInt(limit));

    res.status(200).json(logs);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getAuditLogs
};
