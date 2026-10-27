const mongoose = require('mongoose');
const tenantModel = require('./tenantModel');

const counterSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    unique: true
  },
  seq: {
    type: Number,
    default: 0
  },
  updated_at: {
    type: Date,
    default: Date.now
  }
});

counterSchema.pre('save', function preSave(next) {
  this.updated_at = new Date();
  next();
});

// The sequences behind complaint / criticism / workflow codes belong to ONE tenant's
// data, so they live in that tenant's database. Held on the shared control-plane
// connection they were a single global sequence: every tenant of every product drew
// from the same numbers, so one tenant's activity moved another tenant's codes and
// leaked its volume through the gaps.
module.exports = tenantModel('Counter', counterSchema);
