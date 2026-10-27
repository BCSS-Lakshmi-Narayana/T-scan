// ── Global district filter ────────────────────────────────────────────────
// The State Admin can pick one district in the navbar to view the whole app
// through that district's lens. The frontend sends it on EVERY request as the
// `X-District-Filter` header, so each helper below picks it up automatically —
// no per-controller wiring, which means no module can be accidentally missed.
//
// Safety: this can only ever NARROW a result set.
//   * Tenant isolation is unaffected — every query still goes through
//     withTenant(), so a district filter can never reach another tenant's data.
//     An unknown/garbage district therefore just yields zero rows (fail-closed),
//     which is why no DB validation round-trip is needed here.
//   * Officers cannot widen: a requested district outside their assigned set
//     resolves to '__none__' (see the clamping in each helper below).
//
// An explicit per-endpoint value (e.g. a page's own ?district= dropdown) always
// takes precedence over the global header.
const GLOBAL_DISTRICT_HEADER = 'x-district-filter';

const requestedDistrictFrom = (req, explicit) => {
  const raw = (explicit !== undefined && explicit !== null && explicit !== '')
    ? explicit
    : (req?.headers?.[GLOBAL_DISTRICT_HEADER] ?? req?.query?.district);
  const value = String(raw || '').trim();
  if (!value || value.toLowerCase() === 'all') return null;
  return value;
};

// Officers (role !== 'admin') may only tag records with districts already
// assigned to their own profile (req.user.districts). Admins may use any
// district — this mirrors the read side (useScopedLocation on the frontend).
// District selection is mandatory for everyone.
const validateScopedDistricts = (req, districts) => {
  const submitted = Array.isArray(districts) ? districts.filter(Boolean) : [];
  if (!submitted.length) {
    return { ok: false, districts: submitted, invalid: [], empty: true };
  }

  if (req.user?.role === 'admin') return { ok: true, districts: submitted };

  const allowed = req.user?.districts || [];
  const invalid = submitted.filter((d) => !allowed.includes(d));
  if (invalid.length) {
    return { ok: false, districts: submitted, invalid };
  }
  return { ok: true, districts: submitted };
};

// For list/GET endpoints: admins see everything in the tenant; officers only
// see records tagged with one of their own assigned districts. An officer with
// NO districts assigned must see NOTHING (fail-closed) — never silently fall
// back to unrestricted tenant-wide access.
const scopedDistrictQuery = (req) => {
  const requested = requestedDistrictFrom(req);

  if (req.user?.role === 'admin') {
    // Admin: whole tenant, narrowed to the globally-selected district if set.
    return requested ? { districts: requested } : {};
  }

  const districts = req.user?.districts || [];
  if (!districts.length) return { districts: '__none__' };
  if (requested) {
    // An officer can never widen past their own assigned districts.
    return { districts: districts.includes(requested) ? requested : '__none__' };
  }
  return { districts: { $in: districts } };
};

// Alert (and anything else linked by `source_id`) has no `districts` field of
// its own — it's scoped via its linked Source's district. Shared version of
// the pattern alertController.js uses locally, for any other controller/service
// that needs to gate access to an Alert by district (report escalation, status
// updates, etc). Returns null when unrestricted (admin, no filter selected);
// an array (possibly empty) of visible source ids otherwise.
const resolveScopedSourceIds = async (req, SourceModel, withTenant, requestedDistrict) => {
  const districtMatch = scopedDistrictMatch(req, requestedDistrict);
  if (!districtMatch) return null;
  return SourceModel.find(withTenant(req, districtMatch)).distinct('id');
};

const districtErrorMessage = (districtCheck) => {
  if (districtCheck.empty) return 'Please select at least one district';
  return `District(s) not assigned to you: ${districtCheck.invalid.join(', ')}`;
};

// For report models that don't carry `districts` themselves but link to a parent
// record that does (e.g. GrievanceWorkflowReport/CriticismReport/SuggestionReport
// -> Grievance via grievance_id). Resolves the set of parent ids visible to this
// request (officer scope + an optional explicit ?district= filter) so callers can
// add `{ grievance_id: { $in: ids } }` to their query. Returns null ONLY when no
// scoping applies at all (admin with no explicit district filter selected) — an
// officer with zero districts assigned must resolve to an empty id list (fail
// closed), never to null/"no filter".
const scopedGrievanceIdsForDistrict = async (req, GrievanceModel, requestedDistrict, withTenant) => {
  const isAdmin = req?.user?.role === 'admin';
  const officerDistricts = isAdmin ? [] : (req?.user?.districts || []);
  const explicitDistrict = requestedDistrictFrom(req, requestedDistrict);

  if (isAdmin && !explicitDistrict) return null;
  if (!isAdmin && !officerDistricts.length) return [];

  let match;
  if (isAdmin) {
    match = { districts: explicitDistrict };
  } else if (explicitDistrict) {
    // Officer requesting one of their own districts — an officer can never widen
    // their view by passing a district outside officerDistricts.
    match = { districts: officerDistricts.includes(explicitDistrict) ? explicitDistrict : '__none__' };
  } else {
    match = { districts: { $in: officerDistricts } };
  }

  return GrievanceModel.find(withTenant(req, match)).distinct('id');
};

// Like scopedDistrictQuery, but also honors an explicit ?district= filter (used
// by dashboards/reports that let admins/officers narrow to one district). Returns
// null ONLY when no scoping applies at all (admin, no explicit filter selected).
// An officer with zero districts assigned must get a guaranteed-no-match filter
// (fail closed), never null — callers merge the result into their query whenever
// it's non-null/truthy.
const scopedDistrictMatch = (req, requestedDistrict) => {
  const isAdmin = req?.user?.role === 'admin';
  const officerDistricts = isAdmin ? [] : (req?.user?.districts || []);
  const explicitDistrict = requestedDistrictFrom(req, requestedDistrict);

  if (isAdmin && !explicitDistrict) return null;
  if (!isAdmin && !officerDistricts.length) return { districts: '__none__' };

  if (isAdmin) return { districts: explicitDistrict };
  if (explicitDistrict) {
    // An officer can never widen their view by passing a district outside their own set.
    return { districts: officerDistricts.includes(explicitDistrict) ? explicitDistrict : '__none__' };
  }
  return { districts: { $in: officerDistricts } };
};

// A stable per-request signature of the caller's district scope, for use in
// shared cache keys. Without it, a per-tenant cache can serve an officer a
// cached payload computed for the admin (or another district) — a cross-district
// leak through the cache. Admins share one signature; each officer's key is
// bound to their exact assigned-district set (+ any explicit ?district=).
const districtScopeSignature = (req, requestedDistrict) => {
  // Must include the globally-selected district: otherwise an admin who switches
  // from "All" to Hyderabad would be served the previously-cached all-district
  // payload under the same key (a cross-district leak through the cache).
  const resolved = requestedDistrictFrom(req, requestedDistrict);
  const explicit = resolved ? `:req=${resolved}` : '';
  if (req?.user?.role === 'admin') return `admin${explicit}`;
  return `officer:${(req?.user?.districts || []).slice().sort().join(',')}${explicit}`;
};

module.exports = {
  validateScopedDistricts,
  scopedDistrictQuery,
  districtErrorMessage,
  scopedGrievanceIdsForDistrict,
  scopedDistrictMatch,
  districtScopeSignature,
  requestedDistrictFrom,
  resolveScopedSourceIds,
  GLOBAL_DISTRICT_HEADER
};
