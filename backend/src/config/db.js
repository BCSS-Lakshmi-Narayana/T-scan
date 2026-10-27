const mongoose = require('mongoose');

// The control-plane connection: the tenant registry and the handful of
// collections that belong to no single tenant. Tenant DATA is not read through
// this connection — config/tenantConnections opens a database per tenant off
// the same pool.
//
// DB_NAME is honoured explicitly because MONGODB_URI carries no database path.
// Without it the driver falls back to its own default, which is how this app
// ended up storing the tenant registry in a database literally named "test" —
// the same default the Super Admin used, so its tenant rows landed in the same
// collection (see scripts/clean-tenant-registry.js).
const connectDB = async () => {
  try {
    const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/blura_hub';
    const dbName = process.env.DB_NAME ? String(process.env.DB_NAME).trim() : undefined;
    const conn = await mongoose.connect(uri, dbName ? { dbName } : undefined);
    console.log(`MongoDB Connected: control plane → ${conn.connection.name}`);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;
