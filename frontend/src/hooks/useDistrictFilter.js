import { useState, useEffect } from 'react';
import { DISTRICT_FILTER_KEY } from '../lib/api';

// Event fired by Layout whenever the State Admin's global district filter
// changes. localStorage writes do NOT notify the same tab, so anything that must
// react to a district switch (caches, dashboards) listens for this instead.
export const DISTRICT_FILTER_EVENT = 'districtFilterChanged';

/**
 * Reactive read of the global district filter ('all' when none selected).
 *
 * Why this exists: the filter is stored in localStorage and attached to requests
 * by the axios interceptor, but a localStorage write doesn't re-render React.
 * State that lives ABOVE the routed page (e.g. DashboardProvider, which is not
 * remounted by the Layout's <Outlet key>) would otherwise keep serving the
 * previous district's data. Keying caches on this value makes that impossible.
 */
export const useDistrictFilter = () => {
  const [district, setDistrict] = useState(
    () => localStorage.getItem(DISTRICT_FILTER_KEY) || 'all'
  );

  useEffect(() => {
    const sync = () => setDistrict(localStorage.getItem(DISTRICT_FILTER_KEY) || 'all');
    // Same tab (our own dispatch) + other tabs (native storage event).
    window.addEventListener(DISTRICT_FILTER_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(DISTRICT_FILTER_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  return district;
};

export default useDistrictFilter;
