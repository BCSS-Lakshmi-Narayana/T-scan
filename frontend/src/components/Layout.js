import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useNotification } from '../context/NotificationContext';
import { useRbac } from '../contexts/RbacContext';
import { useTenant } from '../context/TenantContext';
import AccessDenied from './AccessDenied';
import DistrictFilterSelect from './DistrictFilterSelect';
import { DISTRICT_FILTER_KEY } from '../lib/api';
import { DISTRICT_FILTER_EVENT } from '../hooks/useDistrictFilter';

// Pages that react to the global district filter on their own and refetch in
// place. They are excluded from the <Outlet> remount below so switching
// district doesn't tear them down mid-interaction.
const DISTRICT_SELF_SCOPED = new Set(['/dashboard']);
import {
  Shield, LayoutDashboard, Rss, AlertTriangle, BarChart3,
  Settings, FileText, LogOut, Menu, X, Moon, Sun, ChevronRight, HelpCircle, Youtube, Twitter, Facebook, Instagram, Globe, CalendarDays, BellOff, MessageSquare, PhoneCall, Monitor, UserSearch, Search, Wrench, Bot, TrendingUp, History, ChevronDown, ChevronUp
} from 'lucide-react';
import { Button } from './ui/button';
import { toast } from 'sonner';

// role value -> display label (matches AccessManagement.js's mapping).
const ROLE_LABELS = { admin: 'Admin', 'level-1': 'Officer' };
const roleLabel = (role) => ROLE_LABELS[role] || role;

/**
 * Branding for this deployment, fixed in the build.
 *
 * The multi-tenant build reads these from the tenant record so one build can
 * serve several departments. This is a single-department installation, and
 * taking the name and badge from the database made them depend on a record
 * being present and correct before the header could render — a blank title on
 * a fresh database, or a generic shield where the badge belongs. Neither is
 * acceptable on the screen an officer logs in to, so they are constants here.
 */
const BRAND = {
    name: 'T-SCAN',
    tagline: 'Telangana Socialmedia, Cyber Analytics & Network Intelligence',
    logo: '/tscan_logo.png',
};

const Layout = () => {
  const { user, logout } = useAuth();
  const { hasAccess, normalizeRoutePath, loading: rbacLoading } = useRbac();
  const { unreadCount, markAllRead } = useNotification();
  // Branding comes from BRAND above, not from the tenant record. Everything
  // else here still does — districts and colours remain tenant data.
  const { tenant, loading: tenantLoading, departmentName, state, primaryColor, districts: tenantDistricts } = useTenant();
  const location = useLocation();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [darkMode, setDarkMode] = useState(true);
  const [isMobile, setIsMobile] = useState(false);

  // ── Global district filter (State Admin only) ───────────────────────────
  // Persisted so it survives reloads; the axios interceptor reads the same key
  // and sends it as X-District-Filter on every request. Changing it bumps the
  // <Outlet> key below, which remounts the active page so EVERY module refetches
  // with the new district — no per-page wiring, so no module can be missed.
  const isAdmin = user?.role === 'admin';
  const [districtFilter, setDistrictFilter] = useState(
    () => localStorage.getItem(DISTRICT_FILTER_KEY) || 'all'
  );

  const handleDistrictFilterChange = (next) => {
    const value = next || 'all';
    if (value === 'all') {
      localStorage.removeItem(DISTRICT_FILTER_KEY);
    } else {
      localStorage.setItem(DISTRICT_FILTER_KEY, value);
    }
    setDistrictFilter(value);
    // Notify state that lives ABOVE the routed page (e.g. DashboardProvider),
    // which the <Outlet key> remount below cannot reach. Without this, such
    // caches keep serving the previous district's data.
    window.dispatchEvent(new Event(DISTRICT_FILTER_EVENT));
  };

  // The filter can also be set from inside a page — selecting a district on the
  // Command Centre map, for example. Listen for the broadcast so the navbar
  // selector and the <Outlet key> below stay in step with it.
  useEffect(() => {
    const sync = () => setDistrictFilter(localStorage.getItem(DISTRICT_FILTER_KEY) || 'all');
    window.addEventListener(DISTRICT_FILTER_EVENT, sync);
    return () => window.removeEventListener(DISTRICT_FILTER_EVENT, sync);
  }, []);

  // A non-admin must never carry a stale district filter (e.g. an admin and an
  // officer using the same browser). Clear it as soon as a non-admin is active.
  useEffect(() => {
    if (user && !isAdmin && localStorage.getItem(DISTRICT_FILTER_KEY)) {
      localStorage.removeItem(DISTRICT_FILTER_KEY);
      setDistrictFilter('all');
      window.dispatchEvent(new Event(DISTRICT_FILTER_EVENT));
    }
  }, [user, isAdmin]);
  // The icon-only nav can overflow on smaller screens once enough items are
  // visible for a tenant. Rather than a plain (easy-to-miss) scrollbar, a single
  // button at the bottom of the rail scrolls the list down; once fully scrolled
  // it flips to an up-arrow that scrolls back to the top — same button, toggled
  // by scroll position.
  const navRef = useRef(null);
  const [navScroll, setNavScroll] = useState({ atTop: true, atBottom: true });
  const updateNavScroll = useCallback(() => {
    const el = navRef.current;
    if (!el) return;
    setNavScroll({
      atTop: el.scrollTop <= 1,
      atBottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 1,
    });
  }, []);
  const scrollNav = useCallback(() => {
    const el = navRef.current;
    if (!el) return;
    el.scrollTo({ top: navScroll.atBottom ? 0 : el.scrollHeight, behavior: 'smooth' });
  }, [navScroll.atBottom]);

  // Generate thick gradient from primary color
  const getGradientStyle = (color) => {
    return {
      background: `linear-gradient(to right, ${color}, ${color}, ${color})`,
      transition: 'background 0.3s ease'
    };
  };

  const getSidebarGradientStyle = (color) => {
    return {
      background: `linear-gradient(to bottom, ${color}, ${color}, ${color})`,
      transition: 'background 0.3s ease'
    };
  };

  // Handle responsive breakpoints
  useEffect(() => {
    const checkMobile = () => {
      const mobile = window.innerWidth < 1024;
      setIsMobile(mobile);
      // On desktop, sidebar should be open by default
      if (!mobile) {
        setSidebarOpen(true);
      }
    };

    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // Close sidebar on route change (mobile only)
  useEffect(() => {
    if (isMobile) {
      setSidebarOpen(false);
    }
  }, [location.pathname, isMobile]);

  // Prevent body scroll when mobile menu is open
  useEffect(() => {
    if (isMobile && sidebarOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isMobile, sidebarOpen]);

  // Track whether the nav rail can scroll further, and re-measure whenever its
  // content changes size (e.g. once the tenant/permissions load and add/remove
  // items) or the window resizes — not just once at mount.
  useEffect(() => {
    const el = navRef.current;
    if (!el) return;
    updateNavScroll();
    el.addEventListener('scroll', updateNavScroll, { passive: true });
    const ro = new ResizeObserver(updateNavScroll);
    ro.observe(el);
    window.addEventListener('resize', updateNavScroll);
    return () => {
      el.removeEventListener('scroll', updateNavScroll);
      ro.disconnect();
      window.removeEventListener('resize', updateNavScroll);
    };
  }, [updateNavScroll]);

  const toggleDarkMode = () => {
    setDarkMode(!darkMode);
    document.documentElement.classList.toggle('dark');
  };

  const handleLogout = () => {
    // Never let a district selection carry over to the next user on this browser.
    localStorage.removeItem(DISTRICT_FILTER_KEY);
    window.dispatchEvent(new Event(DISTRICT_FILTER_EVENT));
    logout();
    navigate('/login');
  };

  const allNavigation = [
    { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
    { name: 'Alerts', href: '/alerts', icon: AlertTriangle },
    //{ name: 'Reports', href: '/reports', icon: FileText },
    // { name: 'Sources', href: '/sources', icon: Rss },
    // { name: 'Reports', href: '/reports', icon: FileText },
    //{ name: 'SM Handles', href: '/monitors', icon: Monitor },
    //{ name: 'YouTube Monitor', href: '/youtube-monitor', icon: Youtube },
    //{ name: 'X Monitor', href: '/x-monitor', icon: Twitter },
    //{ name: 'Facebook Monitor', href: '/facebook-monitor', icon: Facebook },
    //{ name: 'Instagram Monitor', href: '/instagram-monitor', icon: Instagram },
    { name: 'Grievances', href: '/grievances', icon: MessageSquare },
    { name: 'Events', href: '/events', icon: CalendarDays },
        //{ name: 'Global Search', href: '/global-search', icon: Globe },
    
    { name: 'Profile', href: '/person-of-interest', icon: UserSearch },
    //{ name: 'Policy Manager', href: '/policies', icon: Shield },
    { name: 'Analysis Tools', href: '/analysis-tools', icon: Wrench },
    { name: 'Reports', href: '/intelligence-dashboard', icon: BarChart3 },
    { name: 'AI Assistant', href: '/ai-assistant', icon: Bot },
    //{ name: 'Access Management', href: '/access-management', icon: Shield, roles: ['superadmin'] },
    //{ name: 'Search Analytics', href: '/search-analytics', icon: TrendingUp },
    //{ name: 'RSS News', href: '/police-rss-news', icon: Rss },
    { name: 'Settings', href: '/settings', icon: Settings },
    { name: 'History Log', href: '/history-log', icon: History },
    //{ name: 'Help Guide', href: '/help', icon: HelpCircle },

  ];

  const roleFilteredNavigation = user?.role === 'dial100'
    ? allNavigation.filter((item) => item.href === '/dial-100-incident-reporting')
    : allNavigation.filter((item) => !item.roles || item.roles.includes(user?.role));
  const navigation = roleFilteredNavigation.filter((item) => hasAccess(item.href));

  const normalizedPath = normalizeRoutePath(location.pathname);
  const isRouteAllowed = location.pathname === '/' || hasAccess(normalizedPath);
  const showAccessDenied = !rbacLoading && !isRouteAllowed;
  const isFullWidthPage = (location.pathname.includes('/person-of-interest/') && location.pathname.split('/').length > 2) ||
    location.pathname.startsWith('/reports/generate/') ||
    location.pathname === '/sources' ||
    // The command centre paints its own background and spacing edge-to-edge.
    location.pathname === '/dashboard' ||
    // The assistant is a workspace, not a document: it owns the whole area,
    // scrolls its own conversation, and docks its composer to the bottom.
    // Framing it in the usual page padding drew a second page inside this one.
    location.pathname === '/ai-assistant' ||
    location.pathname === '/settings';

  return (
    <div className="h-screen w-full flex flex-col bg-background overflow-hidden relative print:h-auto print:overflow-visible">
      {/* Mobile Overlay Backdrop */}
      {isMobile && sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 transition-opacity duration-300"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Top Bar - Dynamic themed with branding color */}
      <header
        className="fixed top-0 left-0 right-0 h-16 lg:h-20 z-50 shadow-lg select-none"
        style={getGradientStyle(primaryColor)}
      >
        <div className="flex items-center justify-between h-full px-4 lg:px-6 relative">

          {/* Left: Menu + Logo + Title */}
          <div className="flex items-center gap-3 lg:gap-4 relative z-10">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSidebarOpen(!sidebarOpen)}
              data-testid="sidebar-toggle-btn"
              className="text-white hover:bg-white/10 h-10 w-10 lg:h-11 lg:w-11"
              aria-label={sidebarOpen ? 'Close menu' : 'Open menu'}
            >
              <Menu className="h-5 w-5 lg:h-6 lg:w-6" />
            </Button>

            <div className="flex items-center gap-3 lg:gap-4">
              {/* object-contain, not cover: the badge is not square and
                  cropping it cuts the emblem off at the top. */}
              <div className="relative h-10 w-10 lg:h-14 lg:w-14 flex items-center justify-center shrink-0">
                <img
                  src={BRAND.logo}
                  alt="Telangana State Police"
                  className="h-full w-full object-contain"
                />
              </div>

              <div className="flex flex-col items-start justify-start text-left leading-tight">
                <div className="flex items-center gap-2">
                  <h1 className="text-base lg:text-3xl font-heading font-bold text-white tracking-[0.2em] uppercase drop-shadow-md">
                    {BRAND.name}
                  </h1>
                  <img
                    src="/EYE-01.png"
                    alt="EYE"
                    className="hidden lg:block h-35 w-20 object-contain"
                  />
                </div>
                {/* Hidden on phones: at that width it wraps to three lines and
                    pushes the menu button off the bar. */}
                <p className="hidden sm:block text-[10px] lg:text-xs font-medium uppercase tracking-wide text-white/80">
                  {BRAND.tagline}
                </p>
              </div>
            </div>
          </div>

          {/* Center: AI Search Bar removed */}

          {/* Right: Logo + Theme + User */}
          <div className="flex items-center gap-2 lg:gap-4">
            {isAdmin && (
              <DistrictFilterSelect
                value={districtFilter}
                onChange={handleDistrictFilterChange}
                districts={tenantDistricts || []}
              />
            )}

            <img src="/Logo.png" alt="BCSS Logo" className="h-8 lg:h-10 w-auto object-contain" />

            

            {unreadCount > 0 && (
              <Button
                variant="ghost"
                size="icon"
                onClick={async () => {
                  try {
                    await markAllRead();
                    toast.success('Notifications cleared');
                  } catch {
                    toast.error('Failed to clear notifications');
                  }
                }}
                data-testid="clear-all-notifications-btn"
                className="text-white hover:bg-white/10 h-9 w-9 lg:h-10 lg:w-10"
                aria-label="Clear all notifications"
              >
                <BellOff className="h-4 w-4 lg:h-5 lg:w-5" />
              </Button>
            )}
            {/* <Button
              variant="ghost"
              size="icon"
              onClick={toggleDarkMode}
              data-testid="theme-toggle-btn"
              className="text-white hover:bg-white/10 h-9 w-9 lg:h-10 lg:w-10"
              aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {darkMode ? <Sun className="h-4 w-4 lg:h-5 lg:w-5 text-[hsl(43,96%,70%)]" /> : <Moon className="h-4 w-4 lg:h-5 lg:w-5" />}
            </Button> */}

           

            <div className="flex items-center gap-2 lg:gap-3">
              <div className="text-right hidden sm:block">
                <div className="text-xs lg:text-sm font-semibold text-white truncate max-w-[120px] lg:max-w-none">{user?.full_name}</div>
                <div className="text-[10px] lg:text-xs text-blue-200 font-medium uppercase tracking-wide">{roleLabel(user?.role)}</div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleLogout}
                data-testid="logout-btn"
                className="text-white hover:bg-red-500/20 hover:text-red-200 h-9 w-9 lg:h-10 lg:w-10"
                aria-label="Logout"
              >
                <LogOut className="h-4 w-4 lg:h-5 lg:w-5" />
              </Button>
            </div>
          </div>
        </div>
      </header>

      {/* Sidebar - Narrow icon-based nav */}
      <aside
        className={`fixed top-16 lg:top-20 left-0 bottom-0 w-[82px] shadow-xl z-40 transform transition-transform duration-300 ease-in-out select-none flex flex-col ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        style={getSidebarGradientStyle(primaryColor)}
        data-testid="sidebar"
        role="navigation"
        aria-label="Main navigation"
      >
        {/* Scroll container fills the full rail height (no magic-number max-height,
            which used to clip items once enough of them were visible for a tenant). */}
        <div className="relative flex-1 min-h-0">
          <nav ref={navRef} className="h-full flex flex-col items-center gap-0.5 py-3 overflow-y-auto scrollbar-hide">
            {navigation.map((item) => {
              const Icon = item.icon;
              const isActive = location.pathname === item.href;
              return (
                <Link
                  key={item.name}
                  to={item.href}
                  data-testid={`nav-${item.name.toLowerCase().replace(' ', '-')}`}
                  className={`relative flex flex-col items-center justify-center w-[70px] py-2.5 rounded-xl text-center transition-all duration-200 group shrink-0 ${
                    isActive
                      ? 'bg-white/[0.08] text-white'
                      : 'text-white/50 hover:bg-white/[0.05] hover:text-white/80'
                  }`}
                >
                  <div className="relative">
                    <Icon className={`h-[22px] w-[22px] mb-1 ${isActive ? 'text-white' : 'text-white/50 group-hover:text-white/80'}`} />
                    {item.name === 'Alerts' && unreadCount > 0 && (
                      <span className="absolute -top-1.5 -right-2.5 bg-red-500 text-white text-[9px] font-bold min-w-[18px] h-[18px] flex items-center justify-center rounded-full shadow-lg shadow-red-500/30">
                        {unreadCount > 99 ? '99+' : unreadCount}
                      </span>
                    )}
                  </div>
                  <span className={`text-[10px] leading-tight font-medium ${isActive ? 'text-white' : 'text-white/40 group-hover:text-white/70'}`}>{item.name}</span>
                </Link>
              );
            })}
          </nav>

          {/* Scroll toggle — a plain scrollbar on an 82px icon rail is easy for a
              new user to miss, so a single clickable chevron scrolls the list to
              the bottom; once there, it flips to an up-arrow that scrolls back to
              the top (same button, direction toggles with scroll position). Only
              shown when the list actually overflows. */}
          {(!navScroll.atTop || !navScroll.atBottom) && (
            <div className="pointer-events-none absolute bottom-0 inset-x-0 h-10 bg-gradient-to-t from-black/30 to-transparent flex items-end justify-center pb-1">
              <button
                type="button"
                onClick={scrollNav}
                aria-label={navScroll.atBottom ? 'Scroll navigation up' : 'Scroll navigation down'}
                className="pointer-events-auto h-6 w-6 rounded-full bg-white/15 hover:bg-white/25 flex items-center justify-center transition-colors"
              >
                {navScroll.atBottom
                  ? <ChevronUp className="h-4 w-4 text-white/90" />
                  : <ChevronDown className="h-4 w-4 text-white/90" />}
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Main Content */}
      <div
        className={`flex-1 flex flex-col min-h-0 pt-16 lg:pt-20 transition-all duration-300 print:pt-0 print:pl-0 print:h-auto print:overflow-visible ${sidebarOpen && !isMobile ? 'lg:pl-[82px]' : 'pl-0'
          }`}
      >
        <main className={`flex-1 min-h-0 ${isFullWidthPage ? 'p-0' : 'p-4 lg:p-8'} overflow-auto scroll-smooth print:h-auto print:overflow-visible`}>
          {/* Keying on the district filter remounts the active page whenever the
              State Admin switches district, so every module refetches its data
              through the new scope automatically — no per-page wiring, so no
              module can be accidentally missed.

              DISTRICT_SELF_SCOPED pages opt out: they subscribe to the filter
              themselves and refetch in place, which keeps a district switch
              smooth instead of tearing the page down and replaying its loading
              state. Only add a page here once it actually handles the filter. */}
          {showAccessDenied
            ? <AccessDenied />
            : <Outlet key={DISTRICT_SELF_SCOPED.has(normalizedPath) ? 'self-scoped' : `district-${districtFilter}`} />}
        </main>
      </div>
    </div>
  );
};

export default Layout;
