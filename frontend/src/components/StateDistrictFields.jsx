import React from 'react';
import DistrictField from './DistrictField';
import { useScopedLocation } from '../hooks/useScopedLocation';

// Reusable State (read-only, auto-filled) + Districts (mandatory, scoped to the
// logged-in user's role) fields — drop into any "add" form that needs to record
// which state/districts a record applies to.
const StateDistrictFields = ({ districts, onDistrictsChange, disabled, labelClassName, wrapperClassName }) => {
  const { state } = useScopedLocation();
  const defaultLabelClass = labelClassName || 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1';
  const defaultWrapperClass = wrapperClassName || '';

  return (
    <>
      <div className={defaultWrapperClass}>
        <label className={defaultLabelClass}>State</label>
        <input
          disabled
          value={state || 'No state assigned'}
          className="w-full px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg text-sm bg-gray-50 dark:bg-slate-800 text-gray-500 dark:text-gray-400"
        />
      </div>
      <div className={defaultWrapperClass}>
        <label className={defaultLabelClass}>Districts *</label>
        <DistrictField
          value={districts}
          onChange={onDistrictsChange}
          disabled={disabled}
        />
      </div>
    </>
  );
};

export default StateDistrictFields;
