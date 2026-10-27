import React, { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from './components/ui/sonner';
import { TooltipProvider } from "./components/ui/tooltip";
import { AuthProvider } from './contexts/AuthContext';
import { DashboardProvider } from './contexts/DashboardContext';
import ProtectedRoute from './components/ProtectedRoute';
import ErrorBoundary from './components/ErrorBoundary';
import Layout from './components/Layout';
import Login from './pages/Login';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';

// Lazy load heavy pages
// Analytical command centre — role-aware (State Admin sees the whole tenant and
// the district comparison; a District Officer sees only their own districts).
// The previous dashboard remains at pages/DashboardNew.js if this needs reverting.
const Dashboard = lazy(() => import('./pages/CommandCenter'));
const Sources = lazy(() => import('./pages/Sources'));
const ContentFeed = lazy(() => import('./pages/ContentFeed'));
const YouTubeMonitor = lazy(() => import('./pages/YouTubeMonitor'));
const XMonitor = lazy(() => import('./pages/XMonitor'));
const FacebookMonitor = lazy(() => import('./pages/FacebookMonitor'));
const InstagramMonitor = lazy(() => import('./pages/InstagramMonitor'));
const InstagramProfile = lazy(() => import('./pages/InstagramProfile'));
const Grievances = lazy(() => import('./pages/Grievances'));
const Alerts = lazy(() => import('./pages/Alerts'));
const Analytics = lazy(() => import('./pages/Analytics'));
const Settings = lazy(() => import('./pages/Settings'));
const ActiveThreats = lazy(() => import('./pages/ActiveThreats'));
const Surveillance = lazy(() => import('./pages/Surveillance'));
const IntelProcessed = lazy(() => import('./pages/IntelProcessed'));
const CaseReports = lazy(() => import('./pages/CaseReports'));
const AuditLogs = lazy(() => import('./pages/AuditLogs'));
const HistoryLog = lazy(() => import('./pages/HistoryLog'));
const HelpGuide = lazy(() => import('./pages/HelpGuide'));
const PoliceRssNews = lazy(() => import('./pages/PoliceRssNews'));
const GlobalSearch = lazy(() => import('./pages/GlobalSearch'));
const Events = lazy(() => import('./pages/Events'));
const Announcements = lazy(() => import('./pages/Announcements'));
const Reports = lazy(() => import('./pages/Reports'));
const GenerateReport = lazy(() => import('./pages/GenerateReport'));
const Dial100IncidentReporting = lazy(() => import('./pages/Dial100IncidentReporting'));
const UnifiedMonitors = lazy(() => import('./pages/UnifiedMonitors'));
const UnifiedReports = lazy(() => import('./pages/UnifiedReports'));
const IntelligenceDashboard = lazy(() => import('./pages/IntelligenceDashboard'));
const PolicyManager = lazy(() => import('./components/PolicyManager'));
const PersonOfInterest = lazy(() => import('./pages/POI/PersonOfInterest'));
const POIDetail = lazy(() => import('./pages/POI/POIDetail'));
const AccessManagement = lazy(() => import('./pages/AccessManagement'));
const ModulePermissions = lazy(() => import('./pages/ModulePermissions'));
const LoginHistory = lazy(() => import('./pages/LoginHistory'));
const AnalysisTools = lazy(() => import('./pages/AnalysisTools'));
const OSINTLayout = lazy(() => import('./pages/osint/OSINTLayout'));
const OSINTDashboard = lazy(() => import('./pages/osint/OSINTDashboard'));
const EmailTools = lazy(() => import('./pages/osint/EmailTools'));
const UsernameTools = lazy(() => import('./pages/osint/UsernameTools'));
const PhoneToolsPage = lazy(() => import('./pages/osint/PhoneTools'));
const ImageIntel = lazy(() => import('./pages/osint/ImageIntel'));
const InfrastructureIntel = lazy(() => import('./pages/osint/InfrastructureIntel'));
const AIAssistantPage = lazy(() => import('./pages/osint/AIAssistant'));
const AskAIPage = lazy(() => import('./pages/osint/AskAI'));
const MasterPromptPage = lazy(() => import('./pages/osint/MasterPrompt'));
const OtherLinksPage = lazy(() => import('./pages/osint/OtherLinks'));
const EventsReport = lazy(() => import('./pages/EventsReport'));
const MaigretSearch = lazy(() => import('./pages/MaigretSearch'));
const WhatsMyNameSearch = lazy(() => import('./pages/WhatsMyNameSearch'));
const AiAssistant = lazy(() => import('./pages/AiAssistant'));
const PostLocationLookup = lazy(() => import('./pages/PostLocationLookup'));
const SearchAnalytics = lazy(() => import('./pages/SearchAnalytics'));

// Loading fallback
const PageLoader = () => (
  <div className="flex items-center justify-center min-h-[400px]">
    <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent"></div>
  </div>
);

import { NotificationProvider } from './context/NotificationContext';
import { InstagramCacheProvider } from './contexts/InstagramCacheContext';
import { RbacProvider } from './contexts/RbacContext';
import { TenantProvider } from './context/TenantContext';
import './App.css';

function App() {
  return (
    <TenantProvider>
      <AuthProvider>
        <DashboardProvider>
          <NotificationProvider>
            <BrowserRouter>
              <RbacProvider>
              <InstagramCacheProvider>
              <Toaster position="top-right" expand={true} richColors />
              <Suspense fallback={<PageLoader />}>
                <Routes>
                  <Route path="/login" element={<Login />} />
                  <Route path="/forgot-password" element={<ForgotPassword />} />
                  <Route path="/reset-password/:token" element={<ResetPassword />} />
                  <Route
                    path="/"
                    element={
                      <ProtectedRoute>
                        <Layout />
                      </ProtectedRoute>
                    }
                  >
                    <Route index element={<Navigate to="/dashboard" replace />} />
                    <Route path="dashboard" element={<Dashboard />} />
                    <Route path="sources" element={<Sources />} />
                    <Route path="content" element={<ContentFeed />} />
                    <Route path="youtube-monitor" element={<YouTubeMonitor />} />
                    <Route path="x-monitor" element={<XMonitor />} />
                    <Route path="facebook-monitor" element={<FacebookMonitor />} />
                    <Route path="instagram-monitor" element={<InstagramMonitor />} />
                    <Route path="instagram-monitor/:sourceId" element={<InstagramProfile />} />
                    <Route path="monitors" element={<UnifiedMonitors />} />
                    <Route path="grievances" element={<Grievances />} />
                    <Route path="alerts" element={<Alerts />} />
                    <Route path="analytics" element={<Analytics />} />
                    <Route path="global-search" element={<GlobalSearch />} />
                    <Route path="events" element={<ErrorBoundary label="Events page"><Events /></ErrorBoundary>} />
                    <Route path="announcements" element={<Announcements />} />
                    <Route path="unified-reports" element={<UnifiedReports />} />
                    <Route path="settings" element={<Settings />} />
                    <Route path="intelligence-dashboard" element={<IntelligenceDashboard />} />
                    <Route path="policies" element={<PolicyManager />} />
                    <Route path="active-threats" element={<ActiveThreats />} />
                    <Route path="surveillance" element={<Surveillance />} />
                    <Route path="intel-processed" element={<IntelProcessed />} />
                    <Route path="case-reports" element={<CaseReports />} />
                    <Route path="reports" element={<Reports />} />
                    <Route path="reports/generate/:id" element={<GenerateReport />} />
                    <Route path="dial-100-incident-reporting" element={<Dial100IncidentReporting />} />
                    <Route path="audit-logs" element={<AuditLogs />} />
                    <Route path="history-log" element={<HistoryLog />} />
                    <Route path="access-management" element={<AccessManagement />} />
                    <Route path="access-management/permissions/:userId" element={<ModulePermissions />} />
                    <Route path="access-management/login-history" element={<LoginHistory />} />
                    <Route path="access-management/login-history/:userId" element={<LoginHistory />} />
                    <Route path="person-of-interest" element={<PersonOfInterest />} />
                    <Route path="person-of-interest/:id" element={<POIDetail />} />
                    <Route path="analysis-tools" element={<AnalysisTools />} />
                    <Route path="analysis-tools/osint-tools" element={<OSINTLayout />}>
                      <Route index element={<OSINTDashboard />} />
                      <Route path="email" element={<EmailTools />} />
                      <Route path="username" element={<UsernameTools />} />
                      <Route path="phone" element={<PhoneToolsPage />} />
                      <Route path="image" element={<ImageIntel />} />
                      <Route path="infrastructure" element={<InfrastructureIntel />} />
                      <Route path="ai-assistant" element={<AIAssistantPage />} />
                      <Route path="ask-ai" element={<AskAIPage />} />
                      <Route path="master-prompt" element={<MasterPromptPage />} />
                      <Route path="other-links" element={<OtherLinksPage />} />
                    </Route>
                    <Route path="maigret-search" element={<MaigretSearch />} />
                    <Route path="whatsmyname-search" element={<WhatsMyNameSearch />} />
                    <Route path="events-report" element={<EventsReport />} />
                    <Route path="help" element={<HelpGuide />} />
                    <Route path="ai-assistant" element={<AiAssistant />} />
                    <Route path="post-location-lookup" element={<PostLocationLookup />} />
                    <Route path="search-analytics" element={<SearchAnalytics />} />
                    <Route path="police-rss-news" element={<PoliceRssNews />} />
                  </Route>
                </Routes>
              </Suspense>
            </InstagramCacheProvider>
            </RbacProvider>
          </BrowserRouter>
        </NotificationProvider>
      </DashboardProvider>
    </AuthProvider>
    </TenantProvider>
  );
}

export default App;
