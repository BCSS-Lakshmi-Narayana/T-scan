/**
 * tenantModel(name, schema) — a model that follows the tenant in scope.
 *
 * Model files export one of these instead of `mongoose.model(...)`. What comes
 * back looks and behaves like a Mongoose model (`Alert.find()`, `new Alert()`,
 * `Alert.schema`, `Alert.aggregate()`), but every property access is resolved
 * against the connection for the tenant currently in AsyncLocalStorage. That is
 * what lets ~230 existing call sites in this backend keep working untouched
 * while the data underneath them moves to a database per tenant.
 *
 * In shared mode the resolution always lands on the default connection, so
 * requiring this changes nothing until TENANT_DB_MODE is flipped.
 */
const mongoose = require('mongoose');
const tenantSchemas = require('../config/tenantSchemas');
const { isPerTenant } = require('../config/tenantConnections');
const { getConnection } = require('../config/tenantContext');

const resolveModel = (name, schema) => {
  const connection = getConnection();

  if (!connection) {
    // Per-tenant mode with no tenant in scope means work that forgot to declare
    // which tenant it is for. Falling back to the default connection would read
    // and — worse — write the wrong database, so refuse instead.
    if (isPerTenant()) {
      throw new Error(
        `[tenantModel] "${name}" was used outside a tenant context. ` +
        'Wrap the work in runWithTenant({ tenant, tenantId, connection }, fn) — ' +
        'see config/tenantContext.js.'
      );
    }
    return mongoose.models[name] || mongoose.model(name, schema);
  }

  return connection.models[name] || connection.model(name, schema);
};

const tenantModel = (name, schema) => {
  tenantSchemas.register(name, schema);

  // A function target so `new Alert(...)` and `Alert(...)` both stay possible.
  return new Proxy(function tenantModelProxy() {}, {
    get(_target, prop, receiver) {
      if (prop === '__isTenantModel') return true;
      if (prop === '__modelName') return name;
      if (prop === 'schema') return schema; // available without a tenant in scope
      const model = resolveModel(name, schema);
      const value = Reflect.get(model, prop, receiver);
      // Statics and query builders read `this`, so keep them bound to the model
      // they came from rather than the proxy.
      return typeof value === 'function' ? value.bind(model) : value;
    },
    set(_target, prop, value) {
      resolveModel(name, schema)[prop] = value;
      return true;
    },
    has(_target, prop) {
      return prop in resolveModel(name, schema);
    },
    ownKeys() {
      return Reflect.ownKeys(resolveModel(name, schema));
    },
    getOwnPropertyDescriptor(_target, prop) {
      const d = Reflect.getOwnPropertyDescriptor(resolveModel(name, schema), prop);
      return d ? { ...d, configurable: true } : undefined;
    },
    getPrototypeOf() {
      return Object.getPrototypeOf(resolveModel(name, schema));
    },
    construct(_target, args) {
      const Model = resolveModel(name, schema);
      return new Model(...args);
    },
    apply(_target, _thisArg, args) {
      const Model = resolveModel(name, schema);
      return new Model(...args);
    },
  });
};

module.exports = tenantModel;
module.exports.tenantModel = tenantModel;
