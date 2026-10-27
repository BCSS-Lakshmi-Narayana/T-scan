import React from 'react';
import { MapPin } from 'lucide-react';

/**
 * Global district filter for the State Admin (navbar).
 *
 * Selecting a district makes the ENTIRE application show only that district's
 * data — the value is persisted to localStorage and attached to every API
 * request as `X-District-Filter` by the axios interceptor, so all modules are
 * filtered consistently without per-module wiring.
 *
 * Only rendered for admins. District officers are already restricted to their
 * own district(s) server-side, so they get no selector (and the backend clamps
 * the header anyway, so it can never be used to widen an officer's scope).
 */
const ALL = 'all';

const DistrictFilterSelect = ({ value, onChange, districts = [] }) => {
  if (!districts.length) return null;

  return (
    <div className="flex items-center gap-1.5">
      <MapPin className="h-4 w-4 text-blue-200 hidden sm:block" aria-hidden="true" />
      <select
        value={value || ALL}
        onChange={(e) => onChange(e.target.value)}
        data-testid="district-filter-select"
        aria-label="Filter all modules by district"
        title="Filter the whole application by district"
        className="bg-white/10 text-white text-xs lg:text-sm rounded-md border border-white/20 px-2 py-1.5
                   focus:outline-none focus:ring-2 focus:ring-white/40 cursor-pointer
                   max-w-[140px] lg:max-w-[200px] truncate"
      >
        <option value={ALL} className="text-gray-900">All Districts</option>
        {districts.map((d) => (
          <option key={d} value={d} className="text-gray-900">{d}</option>
        ))}
      </select>
    </div>
  );
};

export default DistrictFilterSelect;
