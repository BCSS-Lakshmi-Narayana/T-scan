import React from 'react';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import './osint.css';

const BASE = '/analysis-tools/osint-tools';

const navItems = [
  { to: BASE, label: 'Main Dashboard', end: true },
  { to: `${BASE}/email`, label: 'Email Tools' },
  { to: `${BASE}/username`, label: 'Username Tools' },
  { to: `${BASE}/phone`, label: 'Phone Tools' },
  { to: `${BASE}/infrastructure`, label: 'Infrastructure Intel' },
  { to: `${BASE}/image`, label: 'Image Intel' },
  { to: `${BASE}/ai-assistant`, label: 'AI Assistant' },
  { to: `${BASE}/other-links`, label: 'Other Links' },
  { to: `${BASE}/ask-ai`, label: 'Ask AI' },
  { to: `${BASE}/master-prompt`, label: 'Master Prompt' },
];

const OSINTLayout = () => {
  const location = useLocation();

  return (
    <div className="osint-portal" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Gov Top Bar */}
      <div style={{ background: '#041d39', color: '#dce7fb', fontSize: '.85rem', padding: '.5rem 0' }}>
        <div className="container d-flex justify-content-between">
          <span>Official OSINT Utility Portal</span>
          <span>For authorized cyber investigation and verification use</span>
        </div>
      </div>

      {/* Header */}
      <header className="gov-header" style={{ padding: '1rem 0' }}>
        <div className="container">
          {/* Row 1: Title + Back link */}
          <div className="d-flex justify-content-between align-items-center flex-wrap gap-2 mb-2">
            <div className="brand-block">
              <div>
                <p className="header-title">Repo of OSINT/SOCMINT</p>
              </div>
            </div>
            <NavLink
              to="/analysis-tools"
              className="btn btn-sm btn-outline-light"
              style={{ fontSize: '.78rem' }}
            >
              &larr; Back to Analysis Tools
            </NavLink>
          </div>

          {/* Row 2: Navigation Pills */}
          <div className="d-flex align-items-center gap-2 flex-wrap">
            {navItems.map((item) => {
              const isActive = item.end
                ? location.pathname === item.to
                : location.pathname.startsWith(item.to);
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={`nav-pill ${isActive ? 'nav-pill-active' : ''}`}
                >
                  {item.label}
                </NavLink>
              );
            })}
          </div>
        </div>
      </header>

      {/* Notice Bar */}
      <div className="notice-bar">
        <div className="container">
          <strong>Advisory:</strong> Use only with lawful authorization. Unauthorized probing or data misuse is punishable.
        </div>
      </div>

      {/* Main Content */}
      <div style={{ flex: 1 }}>
        <Outlet />
      </div>

      {/* Footer */}
      <footer className="portal-footer">
        <div className="container">
          <p className="mb-0">Telangana Police - Cyber Intelligence Wing | Authorized Access Only</p>
        </div>
      </footer>
    </div>
  );
};

export default OSINTLayout;
