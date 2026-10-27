const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const tenantModel = require('./tenantModel');
const mediaSchema = new mongoose.Schema({
  url: { type: String },
  public_id: { type: String },
  resource_type: { type: String },
  format: { type: String },
  bytes: { type: Number },
  original_filename: { type: String }
}, { _id: false });

const dial100IncidentSchema = new mongoose.Schema({
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
  date: {
    type: Date,
    required: true
  },
  category: {
    type: String,
    required: true
  },
  slNo: {
    type: Number,
    default: 0
  },
  incidentDetails: {
    type: String,
    default: ''
  },
  incidentCategory: {
    type: String,
    default: ''
  },
  location: {
    type: String,
    default: ''
  },
  dateTime: {
    type: Date
  },
  psJurisdiction: {
    type: String,
    default: ''
  },
  zoneJurisdiction: {
    type: String,
    default: ''
  },
  callerName: {
    type: String,
    default: ''
  },
  psTypeOfVehicle: {
    type: String,
    default: ''
  },
  pcBc: {
    type: String,
    default: ''
  },
  assignedTime: {
    type: Date
  },
  receivedTime: {
    type: Date
  },
  acceptedTime: {
    type: Date
  },
  responseTimeForAcceptingCall: {
    type: Number,
    default: 0
  },
  reachedTime: {
    type: Date
  },
  responseTimeForAcceptanceToVehicleReachedMins: {
    type: Number,
    default: 0
  },
  responseTimeForAssignedToVehicleReached: {
    type: Number,
    default: 0
  },
  pcRemarks: {
    type: String,
    default: ''
  },
  shoRemarks: {
    type: String,
    default: ''
  },
  remarks: {
    type: String,
    default: ''
  },
  mediaFiles: {
    type: [mediaSchema],
    default: []
  },
  status: {
    type: String,
    default: 'Pending'
  },
  priority: {
    type: String,
    default: 'Normal'
  },
  callerNumber: {
    type: String,
    default: ''
  },
  assignedTo: {
    type: String,
    default: ''
  },
  createdBy: {
    type: String,
    default: 'system'
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

dial100IncidentSchema.index({ date: 1, category: 1, slNo: 1 });

module.exports = tenantModel('Dial100Incident', dial100IncidentSchema);