import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import api from '../lib/api';
import { toast } from 'sonner';
import { useTenant } from '../context/TenantContext';
import { useDistrictFilter } from '../hooks/useDistrictFilter';

const DashboardContext = createContext(null);

const CACHE_DURATION = 30 * 1000; // 30 seconds
const CACHE_KEY = 'dashboardCache_v2';

export const DashboardProvider = ({ children }) => {
  const { tenant } = useTenant();
  // This provider lives ABOVE the routed page, so the Layout's <Outlet key>
  // remount does NOT reset it. The cache key must therefore include the active
  // district — otherwise switching district would re-serve the previous
  // district's counts (both from state and from localStorage) until a manual
  // reload. Keying on it makes the switch reset and refetch automatically.
  const districtFilter = useDistrictFilter();
  const [dashboardData, setDashboardData] = useState(null);
  const [lastFetchTime, setLastFetchTime] = useState(null);
  const [loading, setLoading] = useState(false);
  // Which tenant+district the data in state actually belongs to. Effects run
  // child-first, so the page can call fetchDashboardData() before this
  // provider's restore effect clears the previous district's data. Comparing
  // this against the current key makes serving the wrong district impossible,
  // independent of effect ordering.
  const [dataKey, setDataKey] = useState(null);

  const tenantCacheKey = `${CACHE_KEY}_${tenant?.id || 'none'}_${districtFilter}`;

  // Restore from localStorage on mount, and reset whenever the tenant OR the
  // selected district changes (the key changes → stale data is dropped).
  useEffect(() => {
    try {
      const cached = localStorage.getItem(tenantCacheKey);
      if (!cached) {
        setDashboardData(null);
        setLastFetchTime(null);
        setDataKey(tenantCacheKey);
        return;
      }
      const parsed = JSON.parse(cached);
      if (parsed?.data && parsed?.ts) {
        setDashboardData(parsed.data);
        setLastFetchTime(parsed.ts);
        setDataKey(tenantCacheKey);
      }
    } catch (error) {
      console.error('Failed to read dashboard cache:', error);
      setDashboardData(null);
      setLastFetchTime(null);
      setDataKey(tenantCacheKey);
    }
  }, [tenantCacheKey]);

  const fetchDashboardData = useCallback(async (forceRefresh = false) => {
    // Data belonging to a different tenant/district is never reusable — always
    // refetch, and never return it to the caller.
    const keyMatches = dataKey === tenantCacheKey;

    // Return cached data if it's for THIS tenant+district and not expired
    if (!forceRefresh && keyMatches && dashboardData && lastFetchTime) {
      const timeSinceLastFetch = Date.now() - lastFetchTime;
      if (timeSinceLastFetch < CACHE_DURATION) {
        return dashboardData;
      }
    }

    // Prevent multiple simultaneous fetches
    if (loading) return keyMatches ? dashboardData : null;

    // Switching district is a cold start too: there is nothing valid on screen
    // for the newly selected district, so show the loading state rather than
    // leaving the previous district's numbers visible.
    const isColdStart = !dashboardData || !keyMatches;
    if (isColdStart) setLoading(true);

    try {
      const optionalRequest = (promise) => promise.catch(() => null);
      const getGrievanceDashboardStats = async () => {
        try {
          return await api.get('/grievance-workflow/dashboard-stats');
        } catch (error) {
          if (error?.response?.status === 404) {
            return api.get('/grievances/dashboard-stats');
          }
          throw error;
        }
      };

      const [
        dashStatsRes,
        reportsStatsRes,
        grievancesStatsRes,
        poiStatsRes,
        eventsRes
      ] = await Promise.all([
        api.get('/alerts/dashboard-stats'),
        api.get('/reports/stats'),
        optionalRequest(getGrievanceDashboardStats()),
        optionalRequest(api.get('/poi/stats')),
        optionalRequest(api.get('/events'))
      ]);

      const { byPlatform, pendingByPlatform, viralByPlatform, severityByPlatform } = dashStatsRes.data;

      // Build alertData in the format the dashboard expects: { active: { all: N, twitter: N, ... }, ... }
      const statuses = ['active', 'acknowledged', 'escalated', 'false_positive'];
      const alertData = {};
      statuses.forEach(status => {
        alertData[status] = {};
        Object.keys(byPlatform).forEach(plat => {
          alertData[status][plat] = byPlatform[plat]?.[status] || 0;
        });
      });

      // Viral counts
      alertData.viral = viralByPlatform;

      // Severity breakdown (high/medium/low per platform)
      alertData.severity = severityByPlatform || {};

      // Pending report counts
      const alertPendingReportData = pendingByPlatform;

      // Reports from lightweight backend stats
      const reportData = reportsStatsRes.data?.byPlatform || {};

      // Grievances from lightweight backend stats
      const grievanceRaw = grievancesStatsRes?.data?.byPlatform || {};
      const grievanceData = Object.entries(grievanceRaw).reduce((acc, [platform, item]) => {
        const pending = Number(item?.pending) || 0;
        const escalated = Number(item?.escalated) || 0;
        const closed = Number(item?.closed ?? item?.resolved) || 0;
        const total = Number(item?.total) || (pending + escalated + closed);

        acc[platform] = {
          total,
          pending,
          escalated,
          closed
        };
        return acc;
      }, {});

      // Profiles (POI) summary
      const profilePlatforms = ['all', 'x', 'facebook', 'instagram', 'youtube', 'whatsapp'];
      const profileDataRaw = poiStatsRes?.data?.byPlatform || {};
      const profileData = profilePlatforms.reduce((acc, platform) => {
        const item = profileDataRaw?.[platform] || {};
        acc[platform] = {
          total: Number(item.total) || 0,
          active: Number(item.active) || 0,
          inactive: Number(item.inactive) || 0,
          today_added: Number(item.today_added) || 0,
          week_added: Number(item.week_added) || 0
        };
        return acc;
      }, {});

      // Events summary
      const eventsList = Array.isArray(eventsRes?.data) ? eventsRes.data : [];
      const eventTotals = eventsList.reduce(
        (acc, event) => {
          const status = String(event?.status || 'planned').toLowerCase();
          if (status === 'planned' || status === 'active' || status === 'paused' || status === 'archived') {
            acc[status] += 1;
          }
          acc.total += 1;
          return acc;
        },
        { total: 0, planned: 0, active: 0, paused: 0, archived: 0 }
      );

      const eventData = { 
        all: eventTotals,
        list: eventsList 
      };

      const newData = {
        alertData,
        alertPendingReportData,
        reportData,
        grievanceData,
        profileData,
        eventData
      };

      setDashboardData(newData);
      setLastFetchTime(Date.now());
      setDataKey(tenantCacheKey);
      try {
        localStorage.setItem(tenantCacheKey, JSON.stringify({ data: newData, ts: Date.now() }));
      } catch (error) {
        console.error('Failed to write dashboard cache:', error);
      }
      return newData;
    } catch (error) {
      toast.error('Failed to load dashboard data');
      console.error(error);
      // Only fall back to cached data if it belongs to the CURRENT
      // tenant+district — never show another district's numbers.
      return keyMatches ? dashboardData : null;
    } finally {
      if (isColdStart) setLoading(false);
    }
  }, [dashboardData, lastFetchTime, loading, tenantCacheKey, dataKey]);

  const refreshDashboard = useCallback(() => {
    return fetchDashboardData(true);
  }, [fetchDashboardData]);

  // Never expose data that belongs to a different tenant/district, even for the
  // brief window before the reset effect runs.
  const dataIsCurrent = dataKey === tenantCacheKey;

  return (
    <DashboardContext.Provider value={{
      dashboardData: dataIsCurrent ? dashboardData : null,
      loading,
      fetchDashboardData,
      refreshDashboard,
      hasCachedData: dataIsCurrent && !!dashboardData
    }}>
      {children}
    </DashboardContext.Provider>
  );
};

export const useDashboard = () => {
  const context = useContext(DashboardContext);
  if (!context) {
    throw new Error('useDashboard must be used within a DashboardProvider');
  }
  return context;
};

export default DashboardContext;
