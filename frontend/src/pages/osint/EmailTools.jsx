import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  streamHolehe,
  streamUserScanner,
  fetchDisposableCheck,
  fetchEmailPivots,
} from './osintApi';

const TOOLS = [
  { id: 'holehe', label: 'Holehe Email Footprint' },
  { id: 'disposable', label: 'Disposable Email Check' },
  { id: 'emailpivots', label: 'Email Breach & Intel Pivots' },
  { id: 'user_scanner', label: 'User-Scanner (195+ Platforms)' },
];

function getCategoryIcon(cat) {
  const m = { 'Social Media':'🌐','Developer':'💻','Music':'🎵','Photography':'📷','Business':'💼','Gaming':'🎮','Video':'🎬' };
  return m[cat] || '🔍';
}

const EmailTools = () => {
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState(searchParams.get('email') || '');
  const [selected, setSelected] = useState(new Set());
  const [error, setError] = useState('');

  const [holeheResults, setHoleheResults] = useState([]);
  const [holeheStatus, setHoleheStatus] = useState(null);
  const [disposableResult, setDisposableResult] = useState(null);
  const [pivotsResult, setPivotsResult] = useState(null);
  const [scannerResults, setScannerResults] = useState({});
  const [scannerStatus, setScannerStatus] = useState(null);
  const [scannerCounts, setScannerCounts] = useState({ found: 0, checked: 0 });
  const closersRef = useRef([]);

  useEffect(() => () => closersRef.current.forEach(fn => fn()), []);

  const toggleAll = (chk) => {
    setSelected(chk ? new Set(TOOLS.map(t => t.id)) : new Set());
  };

  const handleScan = useCallback((e) => {
    e.preventDefault();
    if (!email) { setError('Enter an email address.'); return; }
    if (selected.size === 0) { setError('Select at least one tool.'); return; }
    closersRef.current.forEach(fn => fn()); closersRef.current = [];
    setHoleheResults([]); setHoleheStatus(null);
    setDisposableResult(null); setPivotsResult(null);
    setScannerResults({}); setScannerStatus(null); setScannerCounts({ found: 0, checked: 0 });
    setError('');

    if (selected.has('holehe')) {
      setHoleheStatus('scanning');
      const c = streamHolehe(email, (ev) => {
        if (ev.type === 'result') setHoleheResults(p => [...p, ev]);
        if (ev.type === 'complete') setHoleheStatus('done');
        if (ev.type === 'error') setHoleheStatus('error');
      });
      closersRef.current.push(c);
    }
    if (selected.has('disposable')) {
      fetchDisposableCheck(email).then(setDisposableResult).catch(() => setDisposableResult({ error: true }));
    }
    if (selected.has('emailpivots')) {
      fetchEmailPivots(email).then(setPivotsResult).catch(() => setPivotsResult({ error: true }));
    }
    if (selected.has('user_scanner')) {
      setScannerStatus('scanning');
      const c = streamUserScanner('email', email, (ev) => {
        if (ev.type === 'result') {
          const cat = ev.category || 'Other';
          setScannerResults(p => ({ ...p, [cat]: [...(p[cat] || []), ev] }));
          setScannerCounts(p => ({ ...p, found: p.found + 1, checked: p.checked + 1 }));
        }
        if (ev.type === 'checking') setScannerCounts(p => ({ ...p, checked: p.checked + 1 }));
        if (ev.type === 'complete') setScannerStatus('done');
        if (ev.type === 'error') setScannerStatus('error');
      });
      closersRef.current.push(c);
    }
  }, [email, selected]);

  const hasResults = holeheStatus || disposableResult || pivotsResult || scannerStatus;

  return (
    <main className="container my-4">
      <div className="portal-card">
        <div className="section-head">Email Intelligence — OSINT Tools</div>
        <div className="p-3" style={{ padding: '1.25rem' }}>
          {error && <div className="alert alert-danger mb-3">{error}</div>}

          <p className="text-muted mb-3" style={{ fontSize: '.9rem' }}>Run email-based OSINT checks for footprint analysis and breach detection.</p>

          <form onSubmit={handleScan}>
            <div className="row g-2 mb-3">
              <div className="col-md-8">
                <input className="input-control" type="email" placeholder="Enter email address" value={email} onChange={e => setEmail(e.target.value)} />
              </div>
              <div className="col-md-4 d-grid">
                <button type="submit" className="btn-intel input-control">Run Scan</button>
              </div>
            </div>

            <div className="tool-picker mb-3">
              <div className="d-flex justify-content-between align-items-center mb-2">
                <div className="fw-semibold" style={{ fontSize: '.9rem' }}>Select Email OSINT Tools</div>
                <label className="select-all-wrap">
                  <input type="checkbox" checked={selected.size === TOOLS.length} onChange={e => toggleAll(e.target.checked)} />
                  Select All
                </label>
              </div>
              <div className="row g-2">
                {TOOLS.map(t => (
                  <div key={t.id} className="col-md-3">
                    <div className="form-check">
                      <input className="form-check-input" type="checkbox" checked={selected.has(t.id)}
                        onChange={() => { const n = new Set(selected); n.has(t.id) ? n.delete(t.id) : n.add(t.id); setSelected(n); }} />
                      <label className="form-check-label">{t.label}</label>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="row g-3 mb-4">
              <div className="col-md-4"><div className="service-tile"><strong>INT-01:</strong> Email footprint discovery</div></div>
              <div className="col-md-4"><div className="service-tile"><strong>INT-02:</strong> Breach data pivots</div></div>
              <div className="col-md-4"><div className="service-tile"><strong>INT-03:</strong> Domain security posture</div></div>
            </div>
          </form>

          {/* Results */}
          {hasResults && (
            <div className="mt-4">
              {/* Holehe */}
              {holeheStatus && (
                <div className="portal-card mb-3">
                  <div className="section-head"><span>Holehe Email Footprint</span><StatusBadge status={holeheStatus} /></div>
                  <div className="p-3">
                    {holeheResults.length > 0 ? (
                      <div className="table-responsive" style={{ maxHeight: 350, overflowY: 'auto' }}>
                        <table className="table table-hover table-sm">
                          <thead><tr><th>#</th><th>Site</th><th>Status</th><th>Details</th></tr></thead>
                          <tbody>{holeheResults.map((r, i) => (
                            <tr key={i}><td>{i+1}</td><td style={{ fontWeight: 600 }}>{r.site || r.name}</td>
                              <td><span className={`badge ${r.exists ? 'bg-success' : 'bg-secondary'}`}>{r.exists ? 'Registered' : 'Not Found'}</span></td>
                              <td style={{ fontSize: '.82rem', color: '#6c757d' }}>{r.rateLimit ? 'Rate limited' : r.details || '—'}</td></tr>
                          ))}</tbody>
                        </table>
                      </div>
                    ) : holeheStatus === 'scanning' ? <Spinner /> : <p className="text-muted">No results.</p>}
                  </div>
                </div>
              )}

              {/* Disposable */}
              {disposableResult && (
                <div className="portal-card mb-3">
                  <div className="section-head"><span>Disposable Email Check</span><StatusBadge status="done" /></div>
                  <div className="p-3">
                    {disposableResult.error ? <p className="text-muted">Error checking.</p> : (
                      <div className="intel-box">
                        <p style={{ fontSize: '.9rem' }}><strong>Disposable:</strong>{' '}
                          <span className={`badge ${disposableResult.disposable ? 'bg-danger' : 'bg-success'}`}>
                            {disposableResult.disposable ? 'Yes — Disposable' : 'No — Legitimate'}
                          </span></p>
                        {disposableResult.domain && <p style={{ fontSize: '.85rem' }}><strong>Domain:</strong> {disposableResult.domain}</p>}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Email Pivots */}
              {pivotsResult && (
                <div className="portal-card mb-3">
                  <div className="section-head"><span>Email Breach & Intel Pivots</span><StatusBadge status="done" /></div>
                  <div className="p-3">
                    {pivotsResult.error ? <p className="text-muted">Error fetching pivots.</p> : (
                      <div className="intel-box">
                        {pivotsResult.breaches && pivotsResult.breaches.length > 0 ? pivotsResult.breaches.map((b, i) => (
                          <div key={i} className="mb-2" style={{ fontSize: '.88rem' }}>
                            <span className="badge bg-warning me-1">{b.Name || b.name}</span>
                            <span className="text-muted" style={{ fontSize: '.8rem' }}>{b.BreachDate || b.date || ''}</span>
                          </div>
                        )) : <p className="text-muted" style={{ fontSize: '.88rem' }}>No known breaches.</p>}
                        {pivotsResult.pivots && pivotsResult.pivots.length > 0 && (
                          <div className="mt-2">{pivotsResult.pivots.map((p, i) => (
                            <p key={i} style={{ fontSize: '.85rem' }} className="mb-1"><a href={p.url} target="_blank" rel="noopener noreferrer">{p.name}</a></p>
                          ))}</div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* User Scanner */}
              {scannerStatus && (
                <div className="portal-card mb-3">
                  <div className="section-head"><span>User-Scanner Live Results</span><StatusBadge status={scannerStatus} /></div>
                  <div className="p-3">
                    <div className="d-flex gap-3 mb-2" style={{ fontSize: '.82rem' }}>
                      <span><strong>Found:</strong> {scannerCounts.found}</span>
                      <span><strong>Checked:</strong> {scannerCounts.checked}</span>
                    </div>
                    {Object.keys(scannerResults).length > 0 ? Object.entries(scannerResults).map(([cat, items]) => (
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
                    )) : scannerStatus === 'scanning' ? <Spinner /> : null}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </main>
  );
};

const StatusBadge = ({ status }) => (
  <span>
    {status === 'scanning' && <span className="badge bg-info">Scanning...</span>}
    {status === 'done' && <span className="badge bg-success">Complete</span>}
    {status === 'error' && <span className="badge bg-danger">Error</span>}
  </span>
);

const Spinner = () => (
  <div className="d-flex align-items-center gap-2 py-3" style={{ color: '#6c757d' }}>
    <span className="spinner-border" /><span style={{ fontSize: '.88rem' }}>Scanning...</span>
  </div>
);

export default EmailTools;
