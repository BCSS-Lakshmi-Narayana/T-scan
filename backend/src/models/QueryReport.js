const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const tenantModel = require('./tenantModel');
/**
 * QueryReport Model
 * Stores "Q" (Query) workflow classification data
 * Status lifecycle: PENDING â†’ CLOSED (no escalation)
 */
const queryReportSchema = new mongoose.Schema({
  id: { type: String, default: uuidv4, unique: true },
  tenant_id: {
    type: String,
    required: true,
    index: true
  },
  unique_code: { type: String, unique: true, sparse: true },

  /* â”€â”€ Link back to original grievance â”€â”€ */
  grievance_id: { type: String, required: true, ref: 'Grievance' },

  /* â”€â”€ Post metadata â”€â”€ */
  platform: { type: String, enum: ['x', 'facebook', 'whatsapp'], default: 'x' },
  profile_id: { type: String },
  profile_link: { type: String },
  post_link: { type: String },
  post_date: { type: Date },
  post_description: { type: String },

  /* â”€â”€ Author â”€â”€ */
  posted_by: {
    handle: { type: String },
    display_name: { type: String },
    profile_image_url: { type: String }
  },

  /* â”€â”€ Engagement â”€â”€ */
  engagement: {
    views: { type: Number, default: 0 },
    reposts: { type: Number, default: 0 },
    likes: { type: Number, default: 0 },
    replies: { type: Number, default: 0 }
  },

  /* â”€â”€ Complaint phone â”€â”€ */
  complaint_phone: { type: String, default: '' },

  /* â”€â”€ Category (police-relevant) â”€â”€ */
  category: {
    type: String,
    enum: [
      'Cyber crimes', 'E-Challan', 'L&O', 'Others', 'She Team', 'Task force', 'Traffic'
    ],
    default: 'Others'
  },

  /* â”€â”€ Media â”€â”€ */
  media_urls: [{ type: String }],
  media_s3_urls: [{ type: String }],

  /* â”€â”€ Operator remarks / full message â”€â”€ */
  remarks: { type: String },
  message: { type: String },

  /* â”€â”€ Contact who it was shared to â”€â”€ */
  informed_to: {
    name: { type: String },
    phone: { type: String },
    department: { type: String }
  },

  /* â”€â”€ Status lifecycle (PENDING â†’ CLOSED only) â”€â”€ */
  status: {
    type: String,
    enum: ['PENDING', 'CLOSED'],
    default: 'PENDING'
  },

  /* â”€â”€ Operator reply to user â”€â”€ */
  operator_reply: { type: String, default: '' },
  final_reply_to_user: { type: String, default: '' },

  /* â”€â”€ Closing â”€â”€ */
  closing_remarks: { type: String, default: '' },
  closing_media_urls: [{ type: String }],
  closing_media_s3_urls: [{ type: String }],

  /* â”€â”€ Tracking timestamps â”€â”€ */
  action_taken_at: { type: Date },
  closed_at: { type: Date },
  shared_at: { type: Date },
  shared_via: { type: String, enum: ['whatsapp', 'manual', null], default: null },
  report_pdf_url: { type: String, default: null },
  report_pdf_generated_at: { type: Date, default: null },

  /* â”€â”€ Audit trail â”€â”€ */
  status_history: [{
    from_status: { type: String },
    to_status: { type: String },
    changed_by: {
      user_id: { type: String },
      email: { type: String },
      name: { type: String }
    },
    note: { type: String },
    timestamp: { type: Date, default: Date.now }
  }],

  /* â”€â”€ Who created â”€â”€ */
  created_by: {
    user_id: { type: String },
    email: { type: String },
    name: { type: String }
  }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'query_reports'
});

queryReportSchema.index({ grievance_id: 1 });
queryReportSchema.index({ status: 1, created_at: -1 });
queryReportSchema.index({ platform: 1, created_at: -1 });

module.exports = tenantModel('QueryReport', queryReportSchema);