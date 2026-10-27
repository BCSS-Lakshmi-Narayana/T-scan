const mongoose = require('mongoose');

const tenantModel = require('./tenantModel');
const legalSectionSchema = new mongoose.Schema({
  tenant_id: {
    type: String,
    required: true,
    index: true
  },
    act: {
        type: String,
        required: true,
        default: 'BNS 2023'
    },
    section: {
        type: String,
        required: true,
        unique: true
    },
    description: {
        type: String,
        required: true
    },
    keywords: {
        type: [String],
        default: []
    },
    mapped_intent: {
        type: String,
        enum: [
            'News_Report',
            'Political_Statement',
            'Political_Criticism',
            'Opinion_Rant',
            'Threat_Incitement',
            'Harassment_Abuse',
            'Sexual_Harassment',
            'Hate_Speech',
            'Communal_Violence'
        ],
        required: true
    },
    is_active: {
        type: Boolean,
        default: true
    },
    created_at: {
        type: Date,
        default: Date.now
    }
});

module.exports = tenantModel('LegalSection', legalSectionSchema);