const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const tenantModel = require('./tenantModel');
const masterCalendarEventSchema = new mongoose.Schema({
  id: { type: String, default: uuidv4, unique: true },
  tenant_id: {
    type: String,
    required: true,
    index: true
  },
  slNo: { type: Number, required: true },
  occasion: { type: String, required: true, trim: true },
  date: { type: String, required: true, trim: true },          // e.g. "26 January" (day-month for recurring)
  monitoringRange: { type: String, default: '', trim: true },   // e.g. "24 Jan â€“ 28 Jan"
  keywords: { type: String, default: '', trim: true },          // comma-separated keywords
  remarks: { type: String, default: '', trim: true },
  isRecurring: { type: Boolean, default: true },
  createdBy: { type: String, default: 'system' },
  updatedBy: { type: String, default: '' },
  state: { type: String, default: '' },
  districts: { type: [String], default: [] },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

masterCalendarEventSchema.index({ isRecurring: 1, slNo: 1 });
// District-scoped officer list: { tenant_id, districts: { $in } } sorted by slNo asc
masterCalendarEventSchema.index({ tenant_id: 1, districts: 1, slNo: 1 });

masterCalendarEventSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = tenantModel('MasterCalendarEvent', masterCalendarEventSchema);