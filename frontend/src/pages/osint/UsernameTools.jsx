import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  streamSherlock,
  streamMaigret,
  streamUsernameFootprint,
  streamUserScanner,
} from './osintApi';

const TOOLS = [
  { id: 'footprint', label: 'Username Footprint (11 Platforms)' },
  { id: 'user_scanner', label: 'User-Scanner (195+ Platforms)' },
  { id: 'sherlock', label: 'Sherlock Deep Scan (~300)' },
  { id: 'maigret', label: 'Maigret Deep Scan (~500)' },
  { id: 'userdeep', label: 'Combined Deep Scan (Sherlock + Maigret)' },
];

const UsernameTools = () => {
  const [searchParams] = useSearchParams();
  const [username, setUsername] = useState(searchParams.get('username') || '');
  const [selected, setSelected] = useState(new Set());
  const [error, setError] = useState('');

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
  const [scannerResults, setScannerResults] = useState({});
  const [scannerStatus, setScannerStatus] = useState(null);
  const [scannerCounts, setScannerCounts] = useState({ found: 0, checked: 0 });
  const closersRef = useRef([]);

  useEffect(() => () => closersRef.current.forEach(fn => fn()), []);

  const toggleAll = (chk) => setSelected(chk ? new Set(TOOLS.map(t => t.id)) : new Set());

  const reset = () => {
    closersRef.current.forEach(fn => fn()); closersRef.current = [];
    setFootprintResults([]); setFootprintStatus(null);
    setSherlockResults([]); setSherlockStatus(null); setSherlockCounts({ found: 0, checked: 0 });
    setMaigretResults([]); setMaigretStatus(null); setMaigretCounts({ found: 0, checked: 0 });
    setCombinedResults([]); setCombinedStatus(null);
    setScannerResults({}); setScannerStatus(null); setScannerCounts({ found: 0, checked: 0 });
    setError('');
  };

  const handleScan = useCallback((e) => {
    e.preventDefault();
    if (!username) { setError('Enter a username.'); return; }
    if (selected.size === 0) { setError('Select at least one tool.'); return; }
    reset();

    if (selected.has('footprint')) {
      setFootprintStatus('scanning');
      const c = streamUsernameFootprint(username, (ev) => {
        if (ev.type === 'result') setFootprintResults(p => [...p, ev]);
        if (ev.type === 'complete') setFootprintStatus('done');
        if (ev.type === 'error') setFootprintStatus('error');
      });
      closersRef.current.push(c);
    }
    if (selected.has('user_scanner')) {
      setScannerStatus('scanning');
      const c = streamUserScanner('username', username, (ev) => {
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
    if (selected.has('userdeep')) {
      setCombinedStatus('scanning');
      const seen = new Set();
      const add = (ev, src) => {
        if (ev.type === 'result') {
          const key = (ev.site || ev.name || '').toLowerCase();
          if (!seen.has(key)) { seen.add(key); setCombinedResults(p => [...p, { ...ev, source: src }]); }
        }
        if (ev.type === 'complete') setCombinedStatus(p => p === 'one_done' ? 'done' : 'one_done');
      };
      const c1 = streamSherlock(username, ev => add(ev, 'Sherlock'));
      const c2 = streamMaigret(username, ev => add(ev, 'Maigret'));
      closersRef.current.push(c1, c2);
    } else {
      if (selected.has('sherlock')) {
        setSherlockStatus('scanning');
        const c = streamSherlock(username, (ev) => {
          if (ev.type === 'result') { setSherlockResults(p => [...p, ev]); setSherlockCounts(p => ({ ...p, found: p.found + 1, checked: p.checked + 1 })); }
          if (ev.type === 'checking') setSherlockCounts(p => ({ ...p, checked: p.checked + 1 }));
          if (ev.type === 'complete') setSherlockStatus('done');
          if (ev.type === 'error') setSherlockStatus('error');
        });
        closersRef.current.push(c);
      }
      if (selected.has('maigret')) {
        setMaigretStatus('scanning');
        const c = streamMaigret(username, (ev) => {
          if (ev.type === 'result') { setMaigretResults(p => [...p, ev]); setMaigretCounts(p => ({ ...p, found: p.found + 1, checked: p.checked + 1 })); }
          if (ev.type === 'checking') setMaigretCounts(p => ({ ...p, checked: p.checked + 1 }));
          if (ev.type === 'complete') setMaigretStatus('done');
          if (ev.type === 'error') setMaigretStatus('error');
        });
        closersRef.current.push(c);
      }
    }
  }, [username, selected]);

  const hasResults = footprintStatus || sherlockStatus || maigretStatus || combinedStatus || scannerStatus;

  return (
    <main className="container my-4">
      <div className="portal-card">
        <div className="section-head">Username Intelligence — OSINT Tools</div>
        <div className="p-3" style={{ padding: '1.25rem' }}>
          {error && <div className="alert alert-danger mb-3">{error}</div>}

          <form onSubmit={handleScan}>
            <div className="row g-2 mb-3">
              <div className="col-md-8">
                <input className="input-control" type="text" placeholder="Enter username" value={username} onChange={e => setUsername(e.target.value)} />
              </div>
              <div className="col-md-4 d-grid">
                <button type="submit" className="btn-intel input-control">Run Scan</button>
              </div>
            </div>

            <div className="tool-picker mb-3">
              <div className="d-flex justify-content-between align-items-center mb-2">
                <div className="fw-semibold" style={{ fontSize: '.9rem' }}>Select Username OSINT Tools</div>
                <label className="select-all-wrap">
                  <input type="checkbox" checked={selected.size === TOOLS.length} onChange={e => toggleAll(e.target.checked)} />
                  Select All
                </label>
              </div>
              <div className="row g-2">
                {TOOLS.map(t => (
                  <div key={t.id} className="col-md-4">
                    <div className="form-check">
                      <input className="form-check-input" type="checkbox" checked={selected.has(t.id)}
                        onChange={() => { const n = new Set(selected); n.has(t.id) ? n.delete(t.id) : n.add(t.id); setSelected(n); }} />
                      <label className="form-check-label">{t.label}</label>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </form>

          {hasResults && (
            <div className="mt-4">
              {footprintStatus && <StreamTable title="Username Footprint (11 Platforms)" status={footprintStatus} results={footprintResults} />}
              {scannerStatus && <ScannerSection status={scannerStatus} counts={scannerCounts} results={scannerResults} />}
              {sherlockStatus && !selected.has('userdeep') && <StreamTable title="Sherlock Deep Scan" status={sherlockStatus} results={sherlockResults} counts={sherlockCounts} />}
              {maigretStatus && !selected.has('userdeep') && <StreamTable title="Maigret Deep Scan" status={maigretStatus} results={maigretResults} counts={maigretCounts} />}
              {combinedStatus && <CombinedTable status={combinedStatus} results={combinedResults} />}
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
    {(status === 'done') && <span className="badge bg-success">Complete</span>}
    {status === 'error' && <span className="badge bg-danger">Error</span>}
  </span>
);

const Spinner = () => (
  <div className="d-flex align-items-center gap-2 py-3" style={{ color: '#6c757d' }}>
    <span className="spinner-border" /><span style={{ fontSize: '.88rem' }}>Scanning...</span>
  </div>
);

const StreamTable = ({ title, status, results, counts }) => (
  <div className="portal-card mb-3">
    <div className="section-head"><span>{title}</span><StatusBadge status={status} /></div>
    <div className="p-3">
      {counts && <div className="d-flex gap-3 mb-2" style={{ fontSize: '.82rem' }}><span><strong>Found:</strong> {counts.found}</span><span><strong>Checked:</strong> {counts.checked}</span></div>}
      {results.length > 0 ? (
        <div className="table-responsive" style={{ maxHeight: 350, overflowY: 'auto' }}>
          <table className="table table-hover table-sm">
            <thead><tr><th>#</th><th>Site</th><th>Status</th><th>URL</th></tr></thead>
            <tbody>{results.map((r, i) => (
              <tr key={i}><td>{i+1}</td><td style={{ fontWeight: 600 }}>{r.site || r.name}</td>
                <td><span className={`badge ${r.found !== false ? 'bg-success' : 'bg-secondary'}`}>{r.found !== false ? 'Found' : 'Not Found'}</span></td>
                <td>{r.url ? <a href={r.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: '.82rem' }}>{r.url}</a> : '—'}</td></tr>
            ))}</tbody>
          </table>
        </div>
      ) : status === 'scanning' ? <Spinner /> : <p className="text-muted">No results.</p>}
    </div>
  </div>
);

const CombinedTable = ({ status, results }) => (
  <div className="portal-card mb-3">
    <div className="section-head"><span>Combined Deep Scan (Sherlock + Maigret)</span><StatusBadge status={status === 'one_done' ? 'scanning' : status} /></div>
    <div className="p-3">
      {results.length > 0 ? (
        <div className="table-responsive" style={{ maxHeight: 400, overflowY: 'auto' }}>
          <table className="table table-hover table-sm">
            <thead><tr><th>#</th><th>Site</th><th>Source</th><th>URL</th></tr></thead>
            <tbody>{results.map((r, i) => (
              <tr key={i}><td>{i+1}</td><td style={{ fontWeight: 600 }}>{r.site || r.name}</td>
                <td><span className={`badge ${r.source === 'Sherlock' ? 'bg-primary' : 'bg-info'}`}>{r.source}</span></td>
                <td><a href={r.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: '.82rem' }}>{r.url}</a></td></tr>
            ))}</tbody>
          </table>
        </div>
      ) : (status === 'scanning' || status === 'one_done') ? <Spinner /> : null}
    </div>
  </div>
);

const ScannerSection = ({ status, counts, results }) => (
  <div className="portal-card mb-3">
    <div className="section-head"><span>User-Scanner Live Results</span><StatusBadge status={status} /></div>
    <div className="p-3">
      <div className="d-flex gap-3 mb-2" style={{ fontSize: '.82rem' }}>
        <span><strong>Found:</strong> {counts.found}</span>
        <span><strong>Checked:</strong> {counts.checked}</span>
      </div>
      {Object.keys(results).length > 0 ? Object.entries(results).map(([cat, items]) => (
        <div key={cat} className="cat-scan-card mb-2">
          <div className="cat-scan-header"><span>{cat}</span><span className="badge bg-light" style={{ color: '#212529', fontSize: '.72rem' }}>{items.length}</span></div>
          <div style={{ padding: '.5rem .75rem', fontSize: '.85rem' }}>
            {items.map((r, i) => (
              <div key={i} className="d-flex justify-content-between align-items-center py-1" style={{ borderBottom: '1px solid #f0f0f0' }}>
                <span style={{ fontWeight: 600 }}>{r.site || r.name}</span>
                {r.url && <a href={r.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: '.78rem', color: '#0d6efd' }}>Visit</a>}
              </div>
            ))}
          </div>
        </div>
      )) : status === 'scanning' ? <Spinner /> : null}
    </div>
  </div>
);

export default UsernameTools;
