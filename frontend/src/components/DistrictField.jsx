import React, { useEffect } from 'react';
import DistrictMultiSelect from './DistrictMultiSelect';
import { useScopedLocation } from '../hooks/useScopedLocation';

// District is mandatory everywhere it appears. If the logged-in user (officer)
// only has one district assigned, there's nothing to choose — auto-select it
// and show it as a plain read-only value instead of a picker.
const DistrictField = ({ value, onChange, disabled, single = false }) => {
  const { districtOptions } = useScopedLocation();
  const current = value || [];

  useEffect(() => {
    if (districtOptions.length === 1 && (current.length !== 1 || current[0] !== districtOptions[0])) {
      onChange([districtOptions[0]]);
    }
    // Re-run whenever the form value is reset (e.g. modal reopened for a new
    // entry) so the auto-selected district is restored, not just on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [districtOptions.join('|'), current.join('|')]);

  if (districtOptions.length === 1) {
    return (
      <div className="w-full px-3 py-2 border border-gray-200 dark:border-slate-700 rounded-lg text-sm bg-gray-50 dark:bg-slate-800 text-gray-600 dark:text-gray-300">
        {districtOptions[0]}
      </div>
    );
  }

  if (single) {
    return (
      <select
        value={current[0] || ''}
        onChange={(e) => onChange(e.target.value ? [e.target.value] : [])}
        disabled={disabled}
        className="w-full px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg text-sm dark:bg-slate-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <option value="">Select district…</option>
        {districtOptions.map((d) => (
          <option key={d} value={d}>{d}</option>
        ))}
      </select>
    );
  }

  return <DistrictMultiSelect options={districtOptions} value={current} onChange={onChange} disabled={disabled} />;
};

// Shared validation: at least one district must be selected before submit.
export const hasValidDistrictSelection = (districts) => Array.isArray(districts) && districts.length > 0;

export default DistrictField;
