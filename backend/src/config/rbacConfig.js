// Matches the live sidebar in police saga/frontend/src/components/Layout.js
// (allNavigation) — routes not in that list (e.g. /events-report, /unified-reports,
// /access-management as a standalone page) are dead/legacy and intentionally omitted.
// Access Management is reached via /settings?tab=access, so its permissions live
// under the /settings feature group "Access Management" below, not as its own page.
const ALL_PAGES = [
  { path: '/dashboard', name: 'Dashboard', icon: 'LayoutDashboard' },
  { path: '/alerts', name: 'Alerts', icon: 'AlertTriangle' },
  { path: '/grievances', name: 'Grievances', icon: 'MessageSquare' },
  { path: '/events', name: 'Events', icon: 'CalendarDays' },
  { path: '/analysis-tools', name: 'Analysis Tools', icon: 'Wrench' },
  { path: '/intelligence-dashboard', name: 'Reports', icon: 'BarChart3' },
  { path: '/person-of-interest', name: 'Profile', icon: 'BarChart3' },
  { path: '/ai-assistant', name: 'AI Assistant', icon: 'Bot' },
  { path: '/search-analytics', name: 'Search Analytics', icon: 'TrendingUp' },
  { path: '/police-rss-news', name: 'RSS News', icon: 'Rss' },
  { path: '/settings', name: 'Settings', icon: 'Settings' },
  { path: '/history-log', name: 'History Log', icon: 'History' },
  //  { path: '/global-search', name: 'Global Search', icon: 'Globe' },
];

// Each feature may carry a `group` — for /settings this clusters sub-permissions
// under their tab (Configuration / Profiles / Keywords / Report Templates /
// Access Management / Policy Manager) for display, matching Settings.js's own
// tabs (general/sources/keywords/templates/access/policies). Storage stays a
// flat feature-id list per page; `group` only drives grouped rendering in the
// Access Management UI.
const PAGE_FEATURES = {
  '/dashboard': [
    { id: 'events', label: 'Event' , group: 'Events Grid'},
    { id: 'view_all_events', label: 'View' , group: 'Events Grid'},
    { id: 'alerts_summary', label: 'Alerts Summary', group: 'Alerts Grid' },
    { id: 'view_alerts_summary', label: 'View' , group: 'Alerts Grid'},

    { id: 'periscope_events', label: 'Periscope Ongoing Events', group: 'Periscope Ongoing Events Grid' },
    { id: 'view_periscope_events', label: 'View' , group: 'Periscope Ongoing Events Grid'},


    { id: 'escalated_sm', label: 'Escalated to SM Intermediaries', group: 'Escalated to SM Intermediaries Grid' },
    { id: 'view_escalated_sm', label: 'View' , group: 'Escalated to SM Intermediaries Grid'},

    { id: 'grievances', label: 'Grievances', group: 'Grievances Grid' },

    { id: 'profiles', label: 'Profiles', group: 'Profiles Grid' },
    // { id: 'view_profiles', label: 'View' , group: 'Profiles Grid' },

    { id: 'workflow_kpi', label: 'Alert Workflow KPI', group: 'Alert Workflow KPI Grid' },
    // { id: 'view_workflow_kpi', label: 'View',group: 'Alert Workflow KPI Grid' },

  ],
  '/alerts': [
    { id: 'active', label: 'Active', group: 'Configuration' },
    { id: 'false_positive', label: 'False Positive', group: 'Configuration' },
    { id: 'acknowledged', label: 'Acknowledged', group: 'Configuration' },
    { id: 'escalated', label: 'Escalated', group: 'Configuration' },
    { id: 'reports', label: 'Reports', group: 'Configuration' },
    { id: 'top_50_category', label: 'Top 50 / Category 24h ', group: 'Buttons Configuration' },
    { id: 'frequent_engagers', label: 'Frequent Engagers', group: 'Buttons Configuration' },
    { id: 'total_profiles', label: 'Total Profiles', group: 'Buttons Configuration' },
    { id: 'add_profile', label: 'Add Profile', group: 'Buttons Configuration' }
  ],
  '/grievances': [
    { id: 'all', label: 'All' },
    { id: 'pending', label: 'Pending' },
    { id: 'closed', label: 'Closed' },
    { id: 'fir', label: 'FIR' },
    { id: 'reports', label: 'Reports' }
  ],
  '/events': [
    { id: 'hcp_recurring', label: 'HCP Recurring' },
    { id: 'hcp_non_recurring', label: 'HCP Non-Recurring' },
    { id: 'api_settings', label: 'API Settings' },
    { id: 'new_event', label: 'New Event' }
  ],
  '/analysis-tools': [
    { id: 'global_search', label: 'Global Search' },
    { id: 'osint_tools', label: 'OSINT Tools' },
    { id: 'hcp_cyber_crime_llm', label: 'HCP Cyber Crime LLM' }
  ],
  '/intelligence-dashboard': [
    { id: 'alerts_reports', label: 'Alerts Reports' },
    { id: 'grievances_reports', label: 'Grievances Reports' },
    { id: 'profiles_reports', label: 'Profiles Reports' },
    { id: 'events_report', label: 'Events Report' }
  ],
  '/person-of-interest': [
    { id: 'view_Profile', label: 'View Profile' }
  ],
  '/ai-assistant': [
    { id: 'ai_chat', label: 'AI Chat' },
    { id: 'soceye_daily_report', label: 'Soceye Daily Report' }
  ],
  '/police-rss-news': [
    { id: 'add_keywords', label: 'Add Keywords', group: 'Keywords' },
    { id: 'view_keywords', label: 'View Keywords', group: 'Keywords' },
    { id: 'delete_keywords', label: 'Delete Keywords', group: 'Keywords' }
  ],
  '/settings': [

     { id: 'configuration_tab_access', label: 'Configuration Tab', group: 'Tabs Settings' },
     { id: 'profile_tab_access', label: 'Profiles Tab', group: 'Tabs Settings' },
     { id: 'Keywords_tab_access', label: 'Keywords Tab', group: 'Tabs Settings' },
     { id: 'report_templates_tab_access', label: 'Report Templates Tab', group: 'Tabs Settings' },
     { id: 'access_management_tab_access', label: 'Access Management Tab', group: 'Tabs Settings' },
     { id: 'policy_manager_tab_access', label: 'Policy Manager Tab', group: 'Tabs Settings' },

    { id: 'profile_monitoring', label: 'Profile Monitoring', group: 'Configuration' },
    { id: 'risk_levels', label: 'Risk Levels', group: 'Configuration' },
    { id: 'viral_alerts', label: 'Viral Alerts', group: 'Configuration' },
    { id: 'events_monitoring', label: 'Events Monitoring', group: 'Configuration' },
    { id: 'grievance_monitoring', label: 'Grievance Monitoring', group: 'Configuration' },
    { id: 'add_profile', label: 'Add Profile', group: 'Profiles' },
    { id: 'export_profile', label: 'Export Profile', group: 'Profiles' },
    { id: 'add_keywords', label: 'Add Keywords', group: 'Keywords' },
    { id: 'upload_template', label: 'Upload Template', group: 'Report Templates' },
    { id: 'add_user', label: 'Add User', group: 'Access Management' },
    { id: 'edit_user', label: 'Edit User', group: 'Access Management' },
    { id: 'delete_user', label: 'Delete User', group: 'Access Management' },
    { id: 'assign_permissions', label: 'Assign Module Permissions', group: 'Access Management' },
    { id: 'add_policy', label: 'Add Policy', group: 'Policy Manager' }
  ]
};

const GRIEVANCE_FEATURE_ALIASES = {
  escalated: 'pending'
};

// Role-Based Access Control (for multi-tenant)
// SUPERADMIN = Platform owner (main dashboard, manage all tenants)
// ADMIN = Default admin created during tenant onboarding (full access to their tenant, can create users)
// LEVEL-1 = "Officer" — users created by admin (page-level permissions via Access Management)
const ROLES = {
  SUPERADMIN: 'superadmin',
  ADMIN: 'admin',
  LEVEL_1: 'level-1'
};

const ROLE_HIERARCHY = {
  [ROLES.SUPERADMIN]: 3,
  [ROLES.ADMIN]: 2,
  [ROLES.LEVEL_1]: 1
};

const PERMISSIONS = {
  [ROLES.SUPERADMIN]: [
    'manage:tenants',
    'manage:users',
    'manage:roles',
    'view:audit-logs',
    'manage:sources',
    'manage:alerts',
    'view:alerts',
    'view:content',
    'manage:content',
    'manage:settings',
    'manage:grievances',
    'view:grievances',
    'manage:events',
    'view:events',
    'export:data'
  ],
  [ROLES.ADMIN]: [
    'manage:users',
    'view:users',
    'manage:sources',
    'view:sources',
    'manage:alerts',
    'view:alerts',
    'view:content',
    'manage:content',
    'manage:settings',
    'view:settings',
    'manage:grievances',
    'view:grievances',
    'manage:events',
    'view:events',
    'export:data',
    'view:audit-logs'
  ],
  [ROLES.LEVEL_1]: [
    'view:sources',
    'view:alerts',
    'view:content',
    'view:grievances'
  ]
};

const ROUTE_PERMISSIONS = {
  'GET /api/sources': 'view:sources',
  'POST /api/sources': 'manage:sources',
  'PUT /api/sources/:id': 'manage:sources',
  'DELETE /api/sources/:id': 'manage:sources',
  'GET /api/alerts': 'view:alerts',
  'POST /api/alerts': 'manage:alerts',
  'PUT /api/alerts/:id': 'manage:alerts',
  'DELETE /api/alerts/:id': 'manage:alerts',
  'GET /api/content': 'view:content',
  'POST /api/content': 'manage:content',
  'PUT /api/content/:id': 'manage:content',
  'DELETE /api/content/:id': 'manage:content',
  'GET /api/settings': 'view:settings',
  'PUT /api/settings': 'manage:settings',
  'GET /api/grievances': 'view:grievances',
  'POST /api/grievances': 'manage:grievances',
  'PUT /api/grievances/:id': 'manage:grievances',
  'DELETE /api/grievances/:id': 'manage:grievances',
  'GET /api/events': 'view:events',
  'POST /api/events': 'manage:events',
  'PUT /api/events/:id': 'manage:events',
  'DELETE /api/events/:id': 'manage:events',
  'GET /api/users': 'view:users',
  'POST /api/users': 'manage:users',
  'PUT /api/users/:id': 'manage:users',
  'DELETE /api/users/:id': 'manage:users',
  
  
};

const hasPermission = (role, permission) => {
  const rolePermissions = PERMISSIONS[role] || [];
  return rolePermissions.includes(permission);
};

const hasRole = (userRole, requiredRole) => {
  const userLevel = ROLE_HIERARCHY[userRole] || 0;
  const requiredLevel = ROLE_HIERARCHY[requiredRole] || 0;
  return userLevel >= requiredLevel;
};

const getRoutePermission = (method, path) => {
  const routeKey = `${method} ${path}`;
  if (ROUTE_PERMISSIONS[routeKey]) {
    return ROUTE_PERMISSIONS[routeKey];
  }
  for (const [route, permission] of Object.entries(ROUTE_PERMISSIONS)) {
    const pattern = route.replace(/:\w+/g, '[^/]+');
    const regex = new RegExp(`^${pattern}$`);
    if (regex.test(routeKey)) {
      return permission;
    }
  }
  return null;
};

module.exports = {
  ALL_PAGES,
  PAGE_FEATURES,
  GRIEVANCE_FEATURE_ALIASES,
  ROLES,
  ROLE_HIERARCHY,
  PERMISSIONS,
  ROUTE_PERMISSIONS,
  hasPermission,
  hasRole,
  getRoutePermission
};
