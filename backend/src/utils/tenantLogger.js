/**
 * tenantLogger — structured, tenant-tagged logging for the multi-tenant pipelines.
 *
 * Every line carries: pipeline, tenant slug/id, stage. Plus a per-run summary helper.
 * Keeps logs greppable, e.g.:  [monitor] tenant=vamsi stage=fetch fetched=37
 *
 * Usage:
 *   const { createPipelineLogger } = require('../../utils/tenantLogger');
 *   const log = createPipelineLogger('monitor', { slug: 'vamsi', id: 'vamsi-id' });
 *   log.stage('fetch', { sources: 4, fetched: 37 });
 *   log.error('fetch failed', err);
 *   log.summary({ fetched: 37, ingested: 12, analyzed: 12, alerts: 3, errors: 0, ms: 4120 });
 */

const fmtKV = (obj = {}) =>
  Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(' ');

/**
 * @param {string} pipeline - e.g. 'monitor' | 'grievance' | 'analysis'
 * @param {{slug?:string,id?:string}} tenant - tenant identity (slug preferred for readability)
 */
const createPipelineLogger = (pipeline, tenant = {}) => {
  const tag = tenant.slug || tenant.id || 'global';
  const prefix = `[${pipeline}] tenant=${tag}`;

  return {
    info: (msg, fields) => console.log(`${prefix} ${msg}${fields ? ' ' + fmtKV(fields) : ''}`),
    stage: (stage, fields) => console.log(`${prefix} stage=${stage}${fields ? ' ' + fmtKV(fields) : ''}`),
    warn: (msg, fields) => console.warn(`${prefix} WARN ${msg}${fields ? ' ' + fmtKV(fields) : ''}`),
    error: (msg, err) => console.error(`${prefix} ERROR ${msg}${err ? ' :: ' + (err.stack || err.message || err) : ''}`),
    summary: (fields) => console.log(`${prefix} SUMMARY ${fmtKV(fields)}`),
    child: (extraTenant) => createPipelineLogger(pipeline, { ...tenant, ...extraTenant }),
  };
};

module.exports = { createPipelineLogger, fmtKV };
