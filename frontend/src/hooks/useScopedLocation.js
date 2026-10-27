import { useAuth } from '../contexts/AuthContext';
import { useTenant } from '../context/TenantContext';

// Admins can tag records with any district in the tenant; officers (level-1) can
// only tag records with districts already assigned to their own profile.
export const useScopedLocation = () => {
  const { user } = useAuth();
  const { state: tenantState, districts: tenantDistricts } = useTenant();
  const isAdmin = user?.role === 'admin';

  return {
    state: isAdmin ? tenantState : (user?.state || tenantState),
    districtOptions: isAdmin ? tenantDistricts : (user?.districts || []),
    isAdmin,
  };
};
