const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const superAdminSchema = new mongoose.Schema(
  {
    id: { type: String, default: uuidv4, unique: true, required: true, index: true },
    email: { type: String, unique: true, required: true, index: true },
    password: { type: String, required: true },
    full_name: String,
    is_active: { type: Boolean, default: true },
    last_login: Date,
    created_at: { type: Date, default: Date.now }
  },
  { collection: 'superadmins' }
);

module.exports = mongoose.model('SuperAdmin', superAdminSchema);
