const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const tenantModel = require('./tenantModel');
const dailyIntelligenceReportSchema = new mongoose.Schema({
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
    report_date: {
        type: Date,
        required: true,
        index: true
    },
    date_key: {
        type: String,
        required: true
        // uniqueness is tenant-scoped via the compound index below
    },
    generated_at: {
        type: Date,
        default: Date.now
    },
    
    dial100_calls: {
        total_received: { type: Number, default: 0 },
        by_category: [{
            category: String,
            count: Number
        }],
        by_jurisdiction: [{
            jurisdiction: String,
            count: Number
        }],
        response_time_avg: { type: Number, default: 0 },
        critical_incidents: { type: Number, default: 0 }
    },
    
    grievances: {
        total_generated: { type: Number, default: 0 },
        by_type: {
            criticism: { type: Number, default: 0 },
            suggestion: { type: Number, default: 0 },
            grievance: { type: Number, default: 0 }
        },
        by_platform: [{
            platform: String,
            count: Number
        }],
        by_status: [{
            status: String,
            count: Number
        }],
        top_tagged_accounts: [{
            account: String,
            count: Number
        }]
    },
    
    events: {
        total_fetched: { type: Number, default: 0 },
        relevant_count: { type: Number, default: 0 },
        by_platform: [{
            platform: String,
            fetched: Number,
            relevant: Number
        }],
        top_events: [{
            event_id: String,
            event_name: String,
            content_count: Number,
            platforms: [String]
        }]
    },
    
    alerts: {
        total_active: { type: Number, default: 0 },
        by_priority: {
            high: { type: Number, default: 0 },
            medium: { type: Number, default: 0 },
            low: { type: Number, default: 0 }
        },
        by_category: [{
            category: String,
            count: Number
        }],
        by_platform: [{
            platform: String,
            count: Number
        }],
        escalated_count: { type: Number, default: 0 },
        top_50_alerts: [{
            alert_id: String,
            title: String,
            priority: String,
            category: String,
            platform: String,
            author: String,
            risk_score: Number,
            created_at: Date
        }]
    },
    
    top_concepts: [{
        concept: String,
        count: Number,
        sentiment: String,
        risk_level: String
    }],
    
    profiles: {
        total_monitoring: { type: Number, default: 0 },
        deleted_last_24h: { type: Number, default: 0 },
        by_platform: [{
            platform: String,
            active: Number,
            deleted: Number
        }],
        by_category: [{
            category: String,
            count: Number
        }],
        high_risk_profiles: [{
            poi_id: String,
            name: String,
            platform: String,
            handle: String,
            alert_count: Number
        }]
    },
    
    top_keywords: [{
        keyword: String,
        count: Number,
        trend: String,
        platforms: [String]
    }],
    
    summary_statistics: {
        total_content_processed: { type: Number, default: 0 },
        threat_rate_percentage: { type: Number, default: 0 },
        sentiment_breakdown: {
            positive: { type: Number, default: 0 },
            negative: { type: Number, default: 0 },
            neutral: { type: Number, default: 0 }
        },
        viral_posts_count: { type: Number, default: 0 }
    },
    
    detailed_sections: {
        executive_summary: { type: String, default: '' },
        dial100_analysis: { type: String, default: '' },
        grievance_analysis: { type: String, default: '' },
        events_analysis: { type: String, default: '' },
        alerts_analysis: { type: String, default: '' },
        threat_intelligence: { type: String, default: '' },
        recommendations: { type: String, default: '' }
    },
    
    pdf_url: {
        type: String,
        default: ''
    },
    
    status: {
        type: String,
        enum: ['generating', 'completed', 'failed'],
        default: 'generating'
    }
}, {
    timestamps: true
});

dailyIntelligenceReportSchema.index({ report_date: -1 });
dailyIntelligenceReportSchema.index({ tenant_id: 1, date_key: 1 }, { unique: true });
dailyIntelligenceReportSchema.index({ status: 1, report_date: -1 });
dailyIntelligenceReportSchema.index({ generated_at: -1 });

module.exports = tenantModel('DailyIntelligenceReport', dailyIntelligenceReportSchema);