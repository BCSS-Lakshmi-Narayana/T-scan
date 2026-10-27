const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const tenantModel = require('./tenantModel');
/**
 * GrievanceWorkflowReport Model
 * Stores "G" (Grievance) workflow classification data
 * Status lifecycle: PENDING â†’ ESCALATED â†’ CLOSED
 */
const grievanceWorkflowReportSchema = new mongoose.Schema({
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

  /* â”€â”€ Category â”€â”€ */
  category: {
    type: String,
    enum: [
      'Cyber crimes', 'E-Challan', 'L&O', 'Others', 'Query', 'She Team', 'Task force', 'Traffic'
    ],
    default: 'Others'
  },

  /* â”€â”€ Media â”€â”€ */
  media_urls: [{ type: String }],
  media_s3_urls: [{ type: String }],

  /* â”€â”€ Operator remarks / full message â”€â”€ */
  remarks: { type: String },
  message: { type: String },
  escalation_message: { type: String, default: '' },

  /* â”€â”€ Contact who it was shared/escalated to â”€â”€ */
  informed_to: {
    name: { type: String },
    phone: { type: String },
    department: { type: String }
  },

  /* â”€â”€ Status lifecycle â”€â”€ */
  status: {
    type: String,
    enum: ['PENDING', 'ESCALATED', 'CLOSED'],
    default: 'PENDING'
  },

  /* â”€â”€ Operator reply to user â”€â”€ */
  operator_reply: { type: String, default: '' },
  final_reply_to_user: { type: String, default: '' },

  /* â”€â”€ Closing â”€â”€ */
  closing_remarks: { type: String, default: '' },
  closing_media_urls: [{ type: String }],
  closing_media_s3_urls: [{ type: String }],
  final_communication: { type: String, default: '' },

  /* â”€â”€ FIR â”€â”€ */
  fir_status: { type: String, default: '' }, // 'Yes' | 'No'
  fir_number: { type: String, default: '' },

  /* â”€â”€ Tracking timestamps â”€â”€ */
  action_taken_at: { type: Date },
  escalated_at: { type: Date },
  closed_at: { type: Date },
  shared_at: { type: Date },
  shared_via: { type: String, enum: ['whatsapp', 'manual', null], default: null },

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

  /* â”€â”€ Complainant conversation log â”€â”€ */
  complainant_logs: [{
    type: { type: String, enum: ['User', 'Operator', 'OperatorRemark'], required: true },
    mode: {
      type: String,
      enum: ['X POST', 'X DM', 'WHATSAPP CALL', 'WHATSAPP DM', 'FB POST', 'INTERNAL'],
      required: true
    },
    content: { type: String, required: true },
    operator: {
      user_id: { type: String },
      email: { type: String },
      name: { type: String }
    },
    timestamp: { type: Date, default: Date.now },
    locked: { type: Boolean, default: false }
  }],

  /* â”€â”€ Officer communication log â”€â”€ */
  officer_logs: [{
    type: { type: String, enum: ['Operator', 'Officer'], default: 'Operator' },
    mode: {
      type: String,
      enum: ['WHATSAPP CALL', 'WHATSAPP MSG', 'PHONE CALL', 'X POST', 'X DM', 'WHATSAPP DM', 'FB POST'],
      required: true
    },
    content: { type: String, required: true },
    is_escalation: { type: Boolean, default: false },
    operator: {
      user_id: { type: String },
      email: { type: String },
      name: { type: String }
    },
    recipient: {
      name: { type: String },
      phone: { type: String }
    },
    timestamp: { type: Date, default: Date.now }
  }],

  /* â”€â”€ Who created â”€â”€ */
  created_by: {
    user_id: { type: String },
    email: { type: String },
    name: { type: String }
  },

  /* â”€â”€ Generated PDF â”€â”€ */
  report_pdf_url: { type: String, default: null },
  report_pdf_generated_at: { type: Date, default: null }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'grievance_workflow_reports'
});

grievanceWorkflowReportSchema.index({ grievance_id: 1 });
grievanceWorkflowReportSchema.index({ status: 1, created_at: -1 });
grievanceWorkflowReportSchema.index({ platform: 1, created_at: -1 });

module.exports = tenantModel('GrievanceWorkflowReport', grievanceWorkflowReportSchema);