const HistoryLog = require('../models/HistoryLog');

// Fire-and-forget history logging — never blocks or fails the calling request.
// Separate from AuditLog: this is the dedicated create/update/delete trail
// shown in the admin History Log panel.
const logHistory = async (req, { module, action, recordId, recordLabel, changes, state, districts } = {}) => {
  try {
    const user = req.user || {};
    await HistoryLog.create({
      tenant_id: req.tenantId || user.tenant_id,
      module,
      action,
      record_id: recordId || null,
      record_label: recordLabel || '',
      state: state || '',
      districts: Array.isArray(districts) ? districts : [],
      performed_by_id: user.id,
      performed_by_name: user.full_name || user.name || user.email,
      performed_by_email: user.email,
      performed_by_role: user.role,
      changes: changes || {}
    });
  } catch (error) {
    console.error(`Failed to write history log: ${error.message}`);
  }
};

module.exports = { logHistory };
