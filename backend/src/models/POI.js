const mongoose = require('mongoose');

const tenantModel = require('./tenantModel');
const poiSchema = new mongoose.Schema({
  tenant_id: {
    type: String,
    required: true,
    index: true
  },
    name: {
        type: String,
        required: [true, 'Name is required'],
        trim: true
    },
    realName: {
        type: String,
        trim: true,
        default: ''
    },
    aliasNames: [String],
    mobileNumbers: [String],
    emailIds: [String],
    lastUsedIp: {
        type: String,
        trim: true,
        default: ''
    },
    softwareHardwareIdentifiers: {
        type: String,
        trim: true,
        default: ''
    },
    currentAddress: {
        type: String,
        trim: true,
        default: ''
    },
    psLimits: {
        type: String,
        trim: true,
        default: ''
    },
    districtCommisionerate: {
        type: String,
        trim: true,
        default: ''
    },
    state: {
        type: String,
        default: ''
    },
    districts: {
        type: [String],
        default: []
    },
    firDetails: [{
        firNo: { type: String, default: '' },
        psLimits: { type: String, default: '' },
        districtCommisionerate: { type: String, default: '' }
    }],
    linkedIncidents: {
        type: String,
        trim: true,
        default: ''
    },
    whatsappNumbers: [{
        type: String,
        trim: true
    }],
    firNo: {
        type: String,
        trim: true,
        default: ''
    },
    previouslyDeletedProfiles: {
        x: { type: [String], default: [] },
        facebook: { type: [String], default: [] },
        instagram: { type: [String], default: [] },
        youtube: { type: [String], default: [] },
        whatsapp: { type: [String], default: [] }
    },
    briefSummary: {
        type: String,
        trim: true,
        default: ''
    },
    escalatedToIntermediariesCount: {
        type: Number,
        default: 0
    },
    profileImage: {
        type: String,
        default: ''
    },
    customFields: [{
        label: { type: String, required: true },
        value: { type: String, default: '' }
    }],
    socialMedia: [{
        platform: {
            type: String,
            enum: ['x', 'facebook', 'instagram', 'youtube', 'whatsapp'],
            required: true
        },
        sourceId: {
            type: String,
            default: null   // optional â€” null for manually added entries
        },
        platformUserId: {
            type: String,
            default: ''
        },
        handle: String,
        previousHandles: {
            type: [String],
            default: []
        },
        profileImage: String,
        displayName: String,
        displayNameNormalized: { type: String, default: '' },
        followerCount: { type: String, default: '' },   // editable followers/subscriber count
        createdDate: { type: String, default: '' },     // editable account creation date
        category: { type: String, default: 'others' },
        priority: { type: String, enum: ['low', 'medium', 'high', 'critical'], default: 'medium' },
        is_active: { type: Boolean, default: true },
        linkedAt: { type: Date, default: Date.now }
    }],
    status: {
        type: String,
        enum: ['active', 'archived'],
        default: 'active'
    },
    createdBy: {
        type: String,
        default: 'system'
    },
    s3ReportUrl: {
        type: String,
        default: ''
    }
}, {
    timestamps: true
});

poiSchema.index({ 'socialMedia.handle': 1 });
poiSchema.index({ 'socialMedia.displayName': 1 });
poiSchema.index({ 'socialMedia.displayNameNormalized': 1 });
poiSchema.index({ 'socialMedia.sourceId': 1 }); // Used by /poi/by-source/:sourceId lookup
poiSchema.index({ 'socialMedia.platform': 1, 'socialMedia.handle': 1 }); // Compound for platform+handle fallback
poiSchema.index({ 'socialMedia.category': 1 }); // Category filter on social media entries

// Search indexes for all POI detail fields (used by profile search)
poiSchema.index({ name: 1 });
poiSchema.index({ realName: 1 });
poiSchema.index({ aliasNames: 1 });
poiSchema.index({ mobileNumbers: 1 });
poiSchema.index({ emailIds: 1 });
poiSchema.index({ whatsappNumbers: 1 });
poiSchema.index({ currentAddress: 1 });
poiSchema.index({ psLimits: 1 });
poiSchema.index({ districtCommisionerate: 1 });
poiSchema.index({ firNo: 1 });
poiSchema.index({ 'firDetails.firNo': 1 });
poiSchema.index({ linkedIncidents: 1 });
poiSchema.index({ lastUsedIp: 1 });
poiSchema.index({ softwareHardwareIdentifiers: 1 });
poiSchema.index({ escalatedToIntermediariesCount: 1 });

// Auto-normalize displayName before save
poiSchema.pre('save', function (next) {
    if (this.isModified('socialMedia')) {
        this.socialMedia.forEach(sm => {
            if (sm.displayName) {
                sm.displayNameNormalized = sm.displayName
                    .normalize('NFKD')
                    .replace(/[\u0300-\u036f]/g, '')
                    .toLowerCase();
            }
        });
    }
    next();
});
poiSchema.index({ name: 'text', firNo: 'text', briefSummary: 'text' });
poiSchema.index({ status: 1 });
poiSchema.index({ createdAt: -1 });
// Tenant-leading indexes for fast tenant-scoped lookups (link-by-handle + listing)
poiSchema.index({ tenant_id: 1, 'socialMedia.handle': 1, 'socialMedia.platform': 1 });
poiSchema.index({ tenant_id: 1, 'socialMedia.sourceId': 1 });
poiSchema.index({ tenant_id: 1, createdAt: -1 });
poiSchema.index({ tenant_id: 1, districts: 1 });

module.exports = tenantModel('POI', poiSchema);