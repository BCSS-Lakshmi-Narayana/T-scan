import React, { useState, useRef, useCallback } from 'react';
import {
  streamHolehe,
  streamSherlock,
  streamMaigret,
  streamUsernameFootprint,
  streamUserScanner,
  fetchDisposableCheck,
  fetchEmailPivots,
  fetchPhoneIntelligence,
} from './osintApi';

const EMAIL_TOOLS = [
  { id: 'holehe', label: 'Holehe Email Footprint', desc: 'Check 123+ platforms for email registration' },
  { id: 'user_scanner', label: 'User-Scanner (Email)', desc: 'Scan 195+ sites by email identifier' },
  { id: 'disposable', label: 'Disposable Email Check', desc: 'Check if domain is disposable' },
  { id: 'emailpivots', label: 'Email Breach & Intel Pivots', desc: 'OSINT pivots from email address' },
];

const USERNAME_TOOLS = [
  { id: 'username', label: 'Username Footprint', desc: '11-platform HTTP check' },
  { id: 'user_scanner_un', label: 'User-Scanner (Username)', desc: 'Scan 195+ sites by username' },
  { id: 'sherlock', label: 'Sherlock Deep Scan', desc: '~300 sites deep scan' },
  { id: 'maigret', label: 'Maigret Deep Scan', desc: '~500 sites deep scan' },
  { id: 'userdeep', label: 'Combined Deep Scan', desc: 'Sherlock + Maigret deduped' },
];

const PHONE_TOOLS = [
  { id: 'phone', label: 'Phone Intelligence', desc: 'Metadata, carrier & search pivots' },
];

function getCategoryIcon(cat) {
  const icons = {
    'Social Media': '🌐', 'Developer': '💻', 'Music': '🎵',
    'Photography': '📷', 'Business': '💼', 'News': '📰',
    'Gaming': '🎮', 'Video': '🎬', 'Shopping': '🛒',
    'Education': '📚', 'Dating': '❤️', 'Forums': '💬',
  };
  return icons[cat] || '🔍';
}

const OSINTDashboard = () => {
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [phone, setPhone] = useState('');
  const [selectedTools, setSelectedTools] = useState(new Set());
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');

  // Results state
  const [holeheResults, setHoleheResults] = useState([]);
  const [holeheStatus, setHoleheStatus] = useState(null); // null | scanning | done | error
  const [disposableResult, setDisposableResult] = useState(null);
  const [emailPivotsResult, setEmailPivotsResult] = useState(null);
  const [userScannerResults, setUserScannerResults] = useState({});
  const [userScannerStatus, setUserScannerStatus] = useState(null);
  const [userScannerCounts, setUserScannerCounts] = useState({ found: 0, checked: 0 });
  const [footprintResults, setFootprintResults] = useState([]);
  const [footprintStatus, setFootprintStatus] = useState(null);
  const [sherlockResults, setSherlockResults] = useState([]);
  const [sherlockStatus, setSherlockStatus] = useState(null);
  const [sherlockCounts, setSherlockCounts] = useState({ found: 0, checked: 0 });
  const [maigretResults, setMaigretResults] = useState([]);
  const [maigretStatus, setMaigretStatus] = useState(null);
  const [maigretCounts, setMaigretCounts] = useState({ found: 0, checked: 0 });
  const [combinedResults, setCombinedResults] = useState([]);
  const [combinedStatus, setCombinedStatus] = useState(null);
  const [phoneResult, setPhoneResult] = useState(null);
  const [phoneStatus, setPhoneStatus] = useState(null);

  const closersRef = useRef([]);

  const toggleTool = (id) => {
    setSelectedTools(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleGroup = (tools, checked) => {
    setSelectedTools(prev => {
      const next = new Set(prev);
      tools.forEach(t => checked ? next.add(t.id) : next.delete(t.id));
      return next;
    });
  };

  const resetResults = () => {
    closersRef.current.forEach(fn => fn());
    closersRef.current = [];
    setHoleheResults([]); setHoleheStatus(null);
    setDisposableResult(null); setEmailPivotsResult(null);
    setUserScannerResults({}); setUserScannerStatus(null); setUserScannerCounts({ found: 0, checked: 0 });
    setFootprintResults([]); setFootprintStatus(null);
    setSherlockResults([]); setSherlockStatus(null); setSherlockCounts({ found: 0, checked: 0 });
    setMaigretResults([]); setMaigretStatus(null); setMaigretCounts({ found: 0, checked: 0 });
    setCombinedResults([]); setCombinedStatus(null);
    setPhoneResult(null); setPhoneStatus(null);
    setError('');
  };

  const handleScan = useCallback((e) => {
    e.preventDefault();
    if (selectedTools.size === 0) { setError('Select at least one tool.'); return; }
    if (!email && !username && !phone) { setError('Enter at least one identifier.'); return; }
    resetResults();
    setScanning(true);

    const sel = selectedTools;

    // ── Email tools ──
    if (email) {
      if (sel.has('holehe')) {
        setHoleheStatus('scanning');
        const close = streamHolehe(email, (ev) => {
          if (ev.type === 'result') setHoleheResults(prev => [...prev, ev]);
          if (ev.type === 'complete') setHoleheStatus('done');
          if (ev.type === 'error') setHoleheStatus('error');
        });
        closersRef.current.push(close);
      }
      if (sel.has('user_scanner')) {
        setUserScannerStatus('scanning');
        const close = streamUserScanner('email', email, (ev) => {
          if (ev.type === 'result') {
            const cat = ev.category || 'Other';
            setUserScannerResults(prev => ({ ...prev, [cat]: [...(prev[cat] || []), ev] }));
            setUserScannerCounts(prev => ({ ...prev, found: prev.found + 1, checked: prev.checked + 1 }));
          }
          if (ev.type === 'checking') setUserScannerCounts(prev => ({ ...prev, checked: prev.checked + 1 }));
          if (ev.type === 'complete') setUserScannerStatus('done');
          if (ev.type === 'error') setUserScannerStatus('error');
        });
        closersRef.current.push(close);
      }
      if (sel.has('disposable')) {
        fetchDisposableCheck(email).then(setDisposableResult).catch(() => setDisposableResult({ error: true }));
      }
      if (sel.has('emailpivots')) {
        fetchEmailPivots(email).then(setEmailPivotsResult).catch(() => setEmailPivotsResult({ error: true }));
      }
    }

    // ── Username tools ──
    if (username) {
      if (sel.has('username')) {
        setFootprintStatus('scanning');
        const close = streamUsernameFootprint(username, (ev) => {
          if (ev.type === 'result') setFootprintResults(prev => [...prev, ev]);
          if (ev.type === 'complete') setFootprintStatus('done');
          if (ev.type === 'error') setFootprintStatus('error');
        });
        closersRef.current.push(close);
      }
      if (sel.has('user_scanner_un')) {
        setUserScannerStatus('scanning');
        const close = streamUserScanner('username', username, (ev) => {
          if (ev.type === 'result') {
            const cat = ev.category || 'Other';
            setUserScannerResults(prev => ({ ...prev, [cat]: [...(prev[cat] || []), ev] }));
            setUserScannerCounts(prev => ({ ...prev, found: prev.found + 1, checked: prev.checked + 1 }));
          }
          if (ev.type === 'checking') setUserScannerCounts(prev => ({ ...prev, checked: prev.checked + 1 }));
          if (ev.type === 'complete') setUserScannerStatus('done');
          if (ev.type === 'error') setUserScannerStatus('error');
        });
        closersRef.current.push(close);
      }
      if (sel.has('userdeep')) {
        // Combined: run both sherlock + maigret, dedup
        setCombinedStatus('scanning');
        const seen = new Set();
        const addCombined = (ev, source) => {
          if (ev.type === 'result') {
            const key = (ev.site || ev.name || '').toLowerCase();
            if (!seen.has(key)) {
              seen.add(key);
              setCombinedResults(prev => [...prev, { ...ev, source }]);
            }
          }
          if (ev.type === 'complete') {
            // Only mark done when both finish
            setCombinedStatus(prev => prev === 'one_done' ? 'done' : 'one_done');
          }
        };
        const c1 = streamSherlock(username, (ev) => addCombined(ev, 'Sherlock'));
        const c2 = streamMaigret(username, (ev) => addCombined(ev, 'Maigret'));
        closersRef.current.push(c1, c2);
      } else {
        if (sel.has('sherlock')) {
          setSherlockStatus('scanning');
          const close = streamSherlock(username, (ev) => {
            if (ev.type === 'result') {
              setSherlockResults(prev => [...prev, ev]);
              setSherlockCounts(prev => ({ ...prev, found: prev.found + 1, checked: prev.checked + 1 }));
            }
            if (ev.type === 'checking') setSherlockCounts(prev => ({ ...prev, checked: prev.checked + 1 }));
            if (ev.type === 'complete') setSherlockStatus('done');
            if (ev.type === 'error') setSherlockStatus('error');
          });
          closersRef.current.push(close);
        }
        if (sel.has('maigret')) {
          setMaigretStatus('scanning');
          const close = streamMaigret(username, (ev) => {
            if (ev.type === 'result') {
              setMaigretResults(prev => [...prev, ev]);
              setMaigretCounts(prev => ({ ...prev, found: prev.found + 1, checked: prev.checked + 1 }));
            }
            if (ev.type === 'checking') setMaigretCounts(prev => ({ ...prev, checked: prev.checked + 1 }));
            if (ev.type === 'complete') setMaigretStatus('done');
            if (ev.type === 'error') setMaigretStatus('error');
          });
          closersRef.current.push(close);
        }
      }
    }

    // ── Phone tools ──
    if (phone && sel.has('phone')) {
      setPhoneStatus('scanning');
      fetchPhoneIntelligence(phone)
        .then(r => { setPhoneResult(r); setPhoneStatus('done'); })
        .catch(() => setPhoneStatus('error'));
    }
  }, [email, username, phone, selectedTools]);

  const hasAnyResults = holeheStatus || disposableResult || emailPivotsResult ||
    userScannerStatus || footprintStatus || sherlockStatus || maigretStatus ||
    combinedStatus || phoneStatus;

  return (
    <main className="container my-4">
      <div className="portal-card">
        <div className="section-head">
          <span>Intelligence Lookup — Main Dashboard</span>
        </div>
        <div className="p-3" style={{ padding: '1.25rem' }}>
          {error && <div className="alert alert-danger mb-3">{error}</div>}

          {/* Input Form */}
          <form onSubmit={handleScan}>
            <div className="row g-2 mb-3">
              <div className="col-md-4">
                <label style={{ fontSize: '.82rem', fontWeight: 600, color: '#4a5568', display: 'block', marginBottom: '.25rem' }}>Email Address</label>
                <input className="input-control" type="email" placeholder="user@example.com" value={email} onChange={e => setEmail(e.target.value)} />
              </div>
              <div className="col-md-4">
                <label style={{ fontSize: '.82rem', fontWeight: 600, color: '#4a5568', display: 'block', marginBottom: '.25rem' }}>Username</label>
                <input className="input-control" type="text" placeholder="johndoe" value={username} onChange={e => setUsername(e.target.value)} />
              </div>
              <div className="col-md-4">
                <label style={{ fontSize: '.82rem', fontWeight: 600, color: '#4a5568', display: 'block', marginBottom: '.25rem' }}>Phone Number</label>
                <input className="input-control" type="text" placeholder="+1XXXXXXXXXX" value={phone} onChange={e => setPhone(e.target.value)} />
              </div>
            </div>

            {/* Tool Selection */}
            <ToolGroup title="Email-Based Tools" tools={EMAIL_TOOLS} selected={selectedTools} onToggle={toggleTool} onToggleAll={(chk) => toggleGroup(EMAIL_TOOLS, chk)} />
            <ToolGroup title="Username-Based Tools" tools={USERNAME_TOOLS} selected={selectedTools} onToggle={toggleTool} onToggleAll={(chk) => toggleGroup(USERNAME_TOOLS, chk)} />
            <ToolGroup title="Phone Number Tools" tools={PHONE_TOOLS} selected={selectedTools} onToggle={toggleTool} onToggleAll={(chk) => toggleGroup(PHONE_TOOLS, chk)} />

            {/* Service tiles */}
            <div className="row g-3 mb-4 mt-3">
              <div className="col-md-4"><div className="service-tile"><strong>INT-01:</strong> Email footprint discovery</div></div>
              <div className="col-md-4"><div className="service-tile"><strong>INT-02:</strong> Username intelligence</div></div>
              <div className="col-md-4"><div className="service-tile"><strong>INT-03:</strong> Phone metadata extraction</div></div>
            </div>

            <button type="submit" className="btn-intel" disabled={scanning && !hasAnyResults}>
              {scanning ? <><span className="spinner-border me-2" /> Scanning...</> : 'Run Scan'}
            </button>
          </form>

          {/* ─── Results ─── */}
          {hasAnyResults && (
            <div className="mt-4">
              <h5 style={{ color: '#062952', fontWeight: 700, marginBottom: '1rem', borderBottom: '2px solid #d3deef', paddingBottom: '.5rem' }}>
                Scan Results
              </h5>

              {/* Holehe */}
              {holeheStatus && (
                <ResultSection title="Holehe Email Footprint" status={holeheStatus}>
                  {holeheResults.length > 0 ? (
                    <div className="table-responsive" style={{ maxHeight: 350, overflowY: 'auto' }}>
                      <table className="table table-hover table-sm">
                        <thead><tr><th>#</th><th>Site</th><th>Status</th><th>Details</th></tr></thead>
                        <tbody>
                          {holeheResults.map((r, i) => (
                            <tr key={i}>
                              <td>{i + 1}</td>
                              <td style={{ fontWeight: 600 }}>{r.site || r.name}</td>
                              <td><span className={`badge ${r.exists ? 'bg-success' : 'bg-secondary'}`}>{r.exists ? 'Registered' : 'Not Found'}</span></td>
                              <td style={{ fontSize: '.82rem', color: '#6c757d' }}>{r.rateLimit ? 'Rate limited' : r.details || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : holeheStatus === 'scanning' ? <ScanningPlaceholder /> : <p className="text-muted" style={{ fontSize: '.88rem' }}>No results found.</p>}
                </ResultSection>
              )}

              {/* Disposable */}
              {disposableResult && (
                <ResultSection title="Disposable Email Check" status="done">
                  {disposableResult.error ? (
                    <p className="text-muted">Error checking disposable status.</p>
                  ) : (
                    <div className="intel-box">
                      <p style={{ fontSize: '.9rem' }}>
                        <strong>Disposable:</strong>{' '}
                        <span className={`badge ${disposableResult.disposable ? 'bg-danger' : 'bg-success'}`}>
                          {disposableResult.disposable ? 'Yes — Disposable' : 'No — Legitimate'}
                        </span>
                      </p>
                      {disposableResult.domain && <p style={{ fontSize: '.85rem' }}><strong>Domain:</strong> {disposableResult.domain}</p>}
                    </div>
                  )}
                </ResultSection>
              )}

              {/* Email Pivots */}
              {emailPivotsResult && (
                <ResultSection title="Email Breach & Intel Pivots" status="done">
                  {emailPivotsResult.error ? (
                    <p className="text-muted">Error fetching pivots.</p>
                  ) : (
                    <div className="intel-box">
                      {emailPivotsResult.breaches && emailPivotsResult.breaches.length > 0 ? (
                        emailPivotsResult.breaches.map((b, i) => (
                          <div key={i} className="mb-2" style={{ fontSize: '.88rem' }}>
                            <span className="badge bg-warning me-1">{b.Name || b.name}</span>
                            <span className="text-muted" style={{ fontSize: '.8rem' }}>{b.BreachDate || b.date || ''}</span>
                          </div>
                        ))
                      ) : (
                        <p style={{ fontSize: '.88rem' }} className="text-muted">No known breaches for this email.</p>
                      )}
                    </div>
                  )}
                </ResultSection>
              )}

              {/* User Scanner */}
              {userScannerStatus && (
                <ResultSection title="User-Scanner Live Results" status={userScannerStatus}>
                  <div className="d-flex gap-3 mb-2" style={{ fontSize: '.82rem' }}>
                    <span><strong>Found:</strong> {userScannerCounts.found}</span>
                    <span><strong>Checked:</strong> {userScannerCounts.checked}</span>
                  </div>
                  {Object.keys(userScannerResults).length > 0 ? (
                    Object.entries(userScannerResults).map(([cat, items]) => (
                      <div key={cat} className="cat-scan-card mb-2">
                        <div className="cat-scan-header">
                          <span>{getCategoryIcon(cat)} {cat}</span>
                          <span className="badge bg-light" style={{ color: '#212529', fontSize: '.72rem' }}>{items.length}</span>
                        </div>
                        <div style={{ padding: '.5rem .75rem', fontSize: '.85rem' }}>
                          {items.map((r, i) => (
                            <div key={i} className="d-flex justify-content-between align-items-center py-1" style={{ borderBottom: '1px solid #f0f0f0' }}>
                              <span style={{ fontWeight: 600 }}>{r.site || r.name}</span>
                              {r.url && <a href={r.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: '.78rem', color: '#0d6efd' }}>Visit</a>}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))
                  ) : userScannerStatus === 'scanning' ? <ScanningPlaceholder /> : null}
                </ResultSection>
              )}

              {/* Username Footprint */}
              {footprintStatus && (
                <ResultSection title="Username Footprint (11 Platforms)" status={footprintStatus}>
                  {footprintResults.length > 0 ? (
                    <div className="table-responsive">
                      <table className="table table-hover table-sm">
                        <thead><tr><th>Platform</th><th>Status</th><th>URL</th></tr></thead>
                        <tbody>
                          {footprintResults.map((r, i) => (
                            <tr key={i}>
                              <td style={{ fontWeight: 600 }}>{r.site || r.name}</td>
                              <td><span className={`badge ${r.found ? 'bg-success' : 'bg-secondary'}`}>{r.found ? 'Found' : 'Not Found'}</span></td>
                              <td>{r.url ? <a href={r.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: '.82rem' }}>Profile</a> : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : footprintStatus === 'scanning' ? <ScanningPlaceholder /> : <p className="text-muted">No results.</p>}
                </ResultSection>
              )}

              {/* Sherlock */}
              {sherlockStatus && !selectedTools.has('userdeep') && (
                <ResultSection title="Sherlock Deep Scan (~300 sites)" status={sherlockStatus}>
                  <div className="d-flex gap-3 mb-2" style={{ fontSize: '.82rem' }}>
                    <span><strong>Found:</strong> {sherlockCounts.found}</span>
                    <span><strong>Checked:</strong> {sherlockCounts.checked}</span>
                  </div>
                  {sherlockResults.length > 0 ? (
                    <div className="table-responsive" style={{ maxHeight: 350, overflowY: 'auto' }}>
                      <table className="table table-hover table-sm">
                        <thead><tr><th>#</th><th>Site</th><th>URL</th></tr></thead>
                        <tbody>
                          {sherlockResults.map((r, i) => (
                            <tr key={i}>
                              <td>{i + 1}</td>
                              <td style={{ fontWeight: 600 }}>{r.site || r.name}</td>
                              <td><a href={r.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: '.82rem' }}>{r.url}</a></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : sherlockStatus === 'scanning' ? <ScanningPlaceholder /> : null}
                </ResultSection>
              )}

              {/* Maigret */}
              {maigretStatus && !selectedTools.has('userdeep') && (
                <ResultSection title="Maigret Deep Scan (~500 sites)" status={maigretStatus}>
                  <div className="d-flex gap-3 mb-2" style={{ fontSize: '.82rem' }}>
                    <span><strong>Found:</strong> {maigretCounts.found}</span>
                    <span><strong>Checked:</strong> {maigretCounts.checked}</span>
                  </div>
                  {maigretResults.length > 0 ? (
                    <div className="table-responsive" style={{ maxHeight: 350, overflowY: 'auto' }}>
                      <table className="table table-hover table-sm">
                        <thead><tr><th>#</th><th>Site</th><th>URL</th></tr></thead>
                        <tbody>
                          {maigretResults.map((r, i) => (
                            <tr key={i}>
                              <td>{i + 1}</td>
                              <td style={{ fontWeight: 600 }}>{r.site || r.name}</td>
                              <td><a href={r.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: '.82rem' }}>{r.url}</a></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : maigretStatus === 'scanning' ? <ScanningPlaceholder /> : null}
                </ResultSection>
              )}

              {/* Combined Deep Scan */}
              {combinedStatus && (
                <ResultSection title="Combined Deep Scan (Sherlock + Maigret)" status={combinedStatus === 'one_done' ? 'scanning' : combinedStatus}>
                  {combinedResults.length > 0 ? (
                    <div className="table-responsive" style={{ maxHeight: 400, overflowY: 'auto' }}>
                      <table className="table table-hover table-sm">
                        <thead><tr><th>#</th><th>Site</th><th>Source</th><th>URL</th></tr></thead>
                        <tbody>
                          {combinedResults.map((r, i) => (
                            <tr key={i}>
                              <td>{i + 1}</td>
                              <td style={{ fontWeight: 600 }}>{r.site || r.name}</td>
                              <td><span className={`badge ${r.source === 'Sherlock' ? 'bg-primary' : 'bg-info'}`}>{r.source}</span></td>
                              <td><a href={r.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: '.82rem' }}>{r.url}</a></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : combinedStatus === 'scanning' || combinedStatus === 'one_done' ? <ScanningPlaceholder /> : null}
                </ResultSection>
              )}

              {/* Phone */}
              {phoneStatus && (
                <ResultSection title="Phone Intelligence" status={phoneStatus}>
                  {phoneResult ? (
                    <div className="intel-box">
                      {phoneResult.valid ? (
                        <>
                          <span className="tag-hit">Valid Number Format</span>
                          <p style={{ fontSize: '.88rem' }} className="mb-1 mt-2"><strong>E.164:</strong> {phoneResult.e164}</p>
                          <p style={{ fontSize: '.88rem' }} className="mb-1"><strong>International:</strong> {phoneResult.international}</p>
                          <p style={{ fontSize: '.88rem' }} className="mb-1"><strong>National:</strong> {phoneResult.national}</p>
                          <p style={{ fontSize: '.88rem' }} className="mb-1"><strong>Region:</strong> {phoneResult.region}</p>
                          <p style={{ fontSize: '.88rem' }} className="mb-1"><strong>Carrier:</strong> {phoneResult.carrier}</p>
                          <p style={{ fontSize: '.88rem' }} className="mb-1"><strong>Type:</strong> {phoneResult.number_type}</p>
                          <p style={{ fontSize: '.88rem' }} className="mb-2"><strong>Possible:</strong> {phoneResult.possible ? 'Yes' : 'No'}</p>
                          {phoneResult.timezones && <p style={{ fontSize: '.88rem' }} className="mb-1"><strong>Timezones:</strong> {phoneResult.timezones.join(', ')}</p>}
                          {phoneResult.search_links && phoneResult.search_links.length > 0 && (
                            <>
                              <p style={{ fontSize: '.88rem' }} className="mb-1 mt-2"><strong>Public search pivots:</strong></p>
                              {phoneResult.search_links.map((link, i) => (
                                <p key={i} style={{ fontSize: '.85rem' }} className="mb-1">
                                  <a href={link.url} target="_blank" rel="noopener noreferrer">{link.name}</a>
                                </p>
                              ))}
                            </>
                          )}
                        </>
                      ) : (
                        <p style={{ fontSize: '.88rem' }}>{phoneResult.error || 'Invalid number'}</p>
                      )}
                    </div>
                  ) : phoneStatus === 'scanning' ? <ScanningPlaceholder /> : <p className="text-muted">Error fetching phone data.</p>}
                </ResultSection>
              )}
            </div>
          )}
        </div>
      </div>
    </main>
  );
};

/* ── Sub-components ── */
const ToolGroup = ({ title, tools, selected, onToggle, onToggleAll }) => {
  const allSelected = tools.every(t => selected.has(t.id));
  return (
    <div className="mb-3">
      <div className="tool-section-label">
        <span>{title}</span>
        <label className="select-all-wrap">
          <input type="checkbox" checked={allSelected} onChange={e => onToggleAll(e.target.checked)} />
          Select All
        </label>
      </div>
      <div className="row g-2">
        {tools.map(tool => (
          <div key={tool.id} className="col-md-3">
            <div
              className={`tc-tool-card ${selected.has(tool.id) ? 'selected' : ''}`}
              onClick={() => onToggle(tool.id)}
            >
              <div className="tc-title">{tool.label}</div>
              <div className="tc-desc">{tool.desc}</div>
              <div className="tc-footer">
                <span className="tc-select-btn">{selected.has(tool.id) ? 'Selected' : 'Select'}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const ResultSection = ({ title, status, children }) => (
  <div className="portal-card mb-3">
    <div className="section-head">
      <span>{title}</span>
      <span>
        {status === 'scanning' && <span className="badge bg-info">Scanning...</span>}
        {status === 'done' && <span className="badge bg-success">Complete</span>}
        {status === 'error' && <span className="badge bg-danger">Error</span>}
      </span>
    </div>
    <div className="p-3">{children}</div>
  </div>
);

const ScanningPlaceholder = () => (
  <div className="d-flex align-items-center gap-2 py-3" style={{ color: '#6c757d' }}>
    <span className="spinner-border" />
    <span style={{ fontSize: '.88rem' }}>Scanning in progress...</span>
  </div>
);

export default OSINTDashboard;
