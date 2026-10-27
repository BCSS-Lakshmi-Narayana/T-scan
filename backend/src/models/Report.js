const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const tenantModel = require('./tenantModel');
const reportSchema = new mongoose.Schema({
    id: {
        type: String,
        default: uuidv4,
        unique: true
    },
  tenant_id: {
    type: String,
    required: true,
    index: true
  },
    serial_number: {
        type: String,
        required: true,
        unique: true
    },
    alert_id: {
        type: String,
        ref: 'Alert',
        required: true
    },
    // Inherited from the report's content/source district at creation, for
    // per-district officer scoping of report analytics.
    districts: {
        type: [String],
        default: []
    },
    title: {
        type: String,
        default: 'NOTICE: U/Sec:69(A) & 79(3) Information Technology Amendment Act 2008 and 94 BNSS'
    },
    target_user_details: {
        name: String,
        handle: String,
        profile_url: String,
        avatar_url: String,
        is_verified: Boolean
    },
    content_summary: {
        type: String
    },
    media_links: [{
        type: String
    }],
    legal_sections: [{
        act: String,
        section: String,
        description: String
    }],
    violated_policies: [{
        platform: String,
        policy_id: String,
        policy_name: String
    }],
    platform: {
        type: String,
        enum: ['x', 'youtube', 'facebook', 'instagram'],
        required: true
    },
    pdf_url: {
        type: String
    },
    status: {
        type: String,
        enum: ['generated', 'printed', 'sent', 'sent_to_intermediary', 'awaiting_reply', 'closed'],
        default: 'sent_to_intermediary'
    },
    generated_at: {
        type: Date,
        default: Date.now
    },
    edited_content: {
        type: Map,
        of: String,
        default: {}
    },
    closing_remarks: {
        type: String,
        default: ''
    }
});


reportSchema.index({ alert_id: 1 });
reportSchema.index({ tenant_id: 1, districts: 1, generated_at: -1 }); // district-scoped report analytics
reportSchema.index({ generated_at: -1, id: -1 });
reportSchema.index({ status: 1, generated_at: -1, id: -1 });
reportSchema.index({ platform: 1, status: 1, generated_at: -1, id: -1 });
reportSchema.index({ 'target_user_details.handle': 1, generated_at: -1, id: -1 });
reportSchema.index(
    {
        serial_number: 'text',
        'target_user_details.name': 'text',
        'target_user_details.handle': 'text'
    },
    {
        name: 'report_search_text_idx',
        weights: {
            serial_number: 10,
            'target_user_details.handle': 8,
            'target_user_details.name': 5
        }
    }
);

module.exports = tenantModel('Report', reportSchema);