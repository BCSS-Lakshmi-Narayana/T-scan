const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const tenantModel = require('./tenantModel');
const ongoingEventSchema = new mongoose.Schema({
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
    title: {
        type: String,
        required: true,
        trim: true
    },
    type: {
        type: String,
        enum: ['POLITICAL', 'GOVT', 'TECH', 'OTHER'],
        default: 'OTHER'
    },
    bucket: {
        type: String,
        enum: ['ONGOING', 'DAILY_100_FEED', 'SB_INPUTS'],
        default: 'ONGOING'
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

ongoingEventSchema.index({ bucket: 1, createdAt: -1 });

module.exports = tenantModel('OngoingEvent', ongoingEventSchema);