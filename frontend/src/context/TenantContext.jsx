import React, { createContext, useContext, useState, useEffect } from 'react';
// Single source of truth for the backend origin. This used to duplicate the
// resolution logic, which meant a non-default backend port had to be fixed in
// two places — and this copy also lacked the https mixed-content guard.
import { BACKEND_URL, AUTH_FLAG_KEY } from '../lib/api';

const TenantContext = createContext();

export const TenantProvider = ({ children }) => {
  const [tenant, setTenant] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchTenantConfig = async (isRefetch = false, allowSlugFallback = true) => {
    if (!isRefetch) setLoading(true);
    try {
      // The auth cookie is unreadable from JS, so the session flag decides which
      // endpoint to call; the cookie itself travels via credentials: 'include'.
      const token = localStorage.getItem(AUTH_FLAG_KEY) === '1';
      const tenantSlug = localStorage.getItem('tenantSlug');

      // Use public endpoint if no token (login page), protected endpoint if authenticated
      const endpoint = token
        ? `${BACKEND_URL}/api/tenant/config`
        : `${BACKEND_URL}/api/tenant/public-config`;

      const headers = {};

      // For public endpoint on localhost, send tenant slug header if available
      if (!token && tenantSlug) {
        headers['X-Tenant-Slug'] = tenantSlug;
      }

      const response = await fetch(endpoint, { headers, credentials: 'include' });

      if (!response.ok) {
        // Stale tenant slug: the cached slug points to a tenant that no longer
        // exists (e.g. deleted from super admin). Clear it and retry once so the
        // backend resolves the DEFAULT_TENANT_SLUG instead of staying broken.
        if (response.status === 403 && tenantSlug && allowSlugFallback) {
          localStorage.removeItem('tenantSlug');
          return fetchTenantConfig(isRefetch, false);
        }
        throw new Error(`Failed to fetch tenant config: ${response.statusText}`);
      }

      const data = await response.json();
      setTenant(data);

      // Store tenant slug for API requests
      if (data.slug) {
        localStorage.setItem('tenantSlug', data.slug);
      }

      // Colours still come from the tenant record. The title and favicon do
      // not: this deployment's name and badge are fixed in index.html, and
      // letting the record overwrite them meant the tab briefly showed the
      // right name and then changed to whatever the database happened to
      // hold. See BRAND in Layout.js.
      if (data.branding) {
        applyCSSVariables(data.branding);
      }
    } catch (err) {
      console.error('Error fetching tenant config:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Fetch tenant config on mount
    fetchTenantConfig();

    // Refetch when token changes (login/logout) - custom event
    const handleTokenChange = () => {
      console.log('[TenantContext] Token changed event fired, clearing old data and refetching...');
      // Clear old tenant data immediately to prevent showing stale branding
      setTenant(null);
      setLoading(true);
      setError(null);
      // Now fetch fresh data
      fetchTenantConfig();
    };

    // Listen for custom token change event
    window.addEventListener('tokenChanged', handleTokenChange);

    // Also listen for storage changes (cross-tab)
    const handleStorageChange = (e) => {
      if (e.key === AUTH_FLAG_KEY) {
        console.log('[TenantContext] Storage token changed (cross-tab), refetching...');
        fetchTenantConfig();
      }
    };
    window.addEventListener('storage', handleStorageChange);

    return () => {
      window.removeEventListener('tokenChanged', handleTokenChange);
      window.removeEventListener('storage', handleStorageChange);
    };
  }, []);

  const applyCSSVariables = (branding) => {
    const root = document.documentElement;
    if (branding.primary_color) root.style.setProperty('--primary-color', branding.primary_color);
    if (branding.secondary_color) root.style.setProperty('--secondary-color', branding.secondary_color);
    if (branding.accent_color) root.style.setProperty('--accent-color', branding.accent_color);
    if (branding.logo_url) root.style.setProperty('--logo-url', `url(${branding.logo_url})`);
  };

  const updateDocumentTitle = (appName) => {
    if (appName) {
      document.title = appName;
    }
  };

  const updateFavicon = (faviconUrl) => {
    if (faviconUrl) {
      let link = document.querySelector("link[rel='icon']");
      if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
      }
      link.href = faviconUrl;
    }
  };

  const value = {
    tenant,
    loading,
    error,
    refetchConfig: () => fetchTenantConfig(true),
    // Convenience getters for police saga
    get departmentName() {
      return tenant?.police_config?.department_name || 'Department';
    },
    get state() {
      return tenant?.police_config?.state || 'State';
    },
    get districts() {
      return tenant?.police_config?.districts || [];
    },
    get appName() {
      return tenant?.branding?.app_name || 'Watch';
    },
    // The line under the name. Stored per tenant like the name itself, so a
    // deployment is rebranded from its own record rather than from a build.
    get tagline() {
      return tenant?.branding?.tagline || '';
    },
    get slug() {
      return tenant?.slug || 'default';
    },
    get primaryColor() {
      return tenant?.branding?.primary_color || '#1E40AF';
    },
    get secondaryColor() {
      return tenant?.branding?.secondary_color || '#475569';
    },
    get accentColor() {
      return tenant?.branding?.accent_color || '#3B82F6';
    },
    get logoUrl() {
      return tenant?.branding?.logo_url || '';
    },
    get politicianPhotoUrl() {
      return tenant?.branding?.politician_photo_url || '';
    },
    get faviconUrl() {
      return tenant?.branding?.favicon_url || '';
    }
  };

  return (
    <TenantContext.Provider value={value}>
      {children}
    </TenantContext.Provider>
  );
};

export const useTenant = () => {
  const context = useContext(TenantContext);
  if (!context) {
    throw new Error('useTenant must be used within TenantProvider');
  }
  return context;
};
