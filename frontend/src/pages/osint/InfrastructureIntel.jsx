import React, { useState, useCallback } from 'react';
import { runInfrastructureIntel } from './osintApi';

const InfrastructureIntel = () => {
  const [query, setQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  const handleScan = useCallback(async (e) => {
    e.preventDefault();
    if (!query.trim()) return;
    setIsLoading(true); setError(''); setResult(null);
    try {
      const data = await runInfrastructureIntel(query.trim());
      if (data.error) throw new Error(data.error);
      setResult(data);
    } catch (err) { setError(err.message); }
    finally { setIsLoading(false); }
  }, [query]);

  const host = result?.host || result || {};
  const ports = result?.services || result?.ports || host?.ports || [];
  const vulns = result?.vulns || host?.vulns || [];
  const techs = result?.technologies || host?.data?.flatMap(d => d.opts?.vulns ? [] : []) || [];

  return (
    <main className="container my-4">
      {/* Hero */}
      <div className="scan-hero">
        <h1>Infrastructure Intelligence</h1>
        <p>Shodan-powered IP/domain reconnaissance with open port and service discovery.</p>
        <form onSubmit={handleScan}>
          <div className="d-flex gap-2 flex-wrap" style={{ maxWidth: 620 }}>
            <input className="infra-input flex-grow-1" placeholder="Enter domain, IP address, or URL" value={query} onChange={e => setQuery(e.target.value)} />
            <button type="submit" className="btn-infra-scan" disabled={isLoading || !query.trim()}>
              {isLoading ? <><span className="spinner-border me-2" style={{ borderColor: '#062952', borderRightColor: 'transparent' }} />Scanning...</> : 'Scan Target'}
            </button>
          </div>
        </form>
      </div>

      {error && <div className="alert alert-danger">{error}</div>}

      {result && (
        <>
          {/* Host Info */}
          <div className="infra-card">
            <div className="infra-card-header"><h3>Host Information</h3><span className="result-meta">Query: {host.query || query}</span></div>
            <div className="infra-card-body">
              <div className="row g-2">
                <div className="col-md-6">
                  <div className="intel-kv"><strong>IP Address:</strong> <span style={{ fontFamily: 'monospace' }}>{host.ip || host.ip_str || '—'}</span></div>
                  <div className="intel-kv"><strong>Organization:</strong> <span>{host.org || '—'}</span></div>
                  <div className="intel-kv"><strong>ISP:</strong> <span>{host.isp || '—'}</span></div>
                  <div className="intel-kv"><strong>ASN:</strong> <span style={{ fontFamily: 'monospace' }}>{host.asn || '—'}</span></div>
                </div>
                <div className="col-md-6">
                  <div className="intel-kv"><strong>Country:</strong> <span>{host.country_name || host.country || '—'}</span></div>
                  <div className="intel-kv"><strong>City:</strong> <span>{host.city || '—'}</span></div>
                  <div className="intel-kv"><strong>Last Update:</strong> <span>{host.last_update || '—'}</span></div>
                  <div className="intel-kv"><strong>OS:</strong> <span>{host.os || '—'}</span></div>
                </div>
              </div>

              {host.hostnames && host.hostnames.length > 0 && (
                <div className="mt-2">
                  <strong style={{ fontSize: '.8rem', color: '#062952' }}>Hostnames:</strong>
                  <div className="d-flex flex-wrap gap-1 mt-1">
                    {host.hostnames.map((h, i) => <span key={i} className="tech-chip">{h}</span>)}
                  </div>
                </div>
              )}
              {host.tags && host.tags.length > 0 && (
                <div className="mt-2">
                  <strong style={{ fontSize: '.8rem', color: '#062952' }}>Tags:</strong>
                  <div className="d-flex flex-wrap gap-1 mt-1">
                    {host.tags.map((t, i) => <span key={i} className="tag-chip">{t}</span>)}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Open Ports */}
          {ports.length > 0 && (
            <div className="infra-card">
              <div className="infra-card-header"><h3>Open Ports & Services</h3><span className="badge bg-warning" style={{ fontSize: '.72rem' }}>{ports.length} ports</span></div>
              <div className="infra-card-body">
                <div className="d-flex flex-wrap gap-1 mb-3">
                  {ports.map((p, i) => <span key={i} className="port-chip">{typeof p === 'object' ? p.port : p}</span>)}
                </div>
                {ports.some(p => typeof p === 'object') && (
                  <div className="table-responsive">
                    <table className="table table-hover table-sm">
                      <thead><tr><th>Port</th><th>Service</th><th>Product</th><th>Banner</th></tr></thead>
                      <tbody>
                        {ports.filter(p => typeof p === 'object').map((s, i) => (
                          <tr key={i}>
                            <td style={{ fontFamily: 'monospace', fontWeight: 700 }}>{s.port}</td>
                            <td>{s.name || s.transport || '—'}</td>
                            <td>{s.product || '—'}</td>
                            <td style={{ fontSize: '.8rem', color: '#6c757d', maxWidth: 250, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.banner || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Technologies */}
          {techs.length > 0 && (
            <div className="infra-card">
              <div className="infra-card-header"><h3>Detected Technologies</h3></div>
              <div className="infra-card-body d-flex flex-wrap gap-1">
                {techs.map((t, i) => <span key={i} className="tech-chip">{typeof t === 'string' ? t : t.name || t}</span>)}
              </div>
            </div>
          )}

          {/* Vulnerabilities */}
          {vulns.length > 0 && (
            <div className="infra-card">
              <div className="infra-card-header"><h3>Known Vulnerabilities</h3><span className="badge bg-danger" style={{ fontSize: '.72rem' }}>{vulns.length}</span></div>
              <div className="infra-card-body">
                <div className="table-responsive">
                  <table className="table table-hover table-sm">
                    <thead><tr><th>CVE</th><th>Severity</th><th>Score</th></tr></thead>
                    <tbody>
                      {vulns.map((v, i) => {
                        const id = typeof v === 'string' ? v : v.id || v.cve;
                        const sev = typeof v === 'object' ? (v.severity || '') : '';
                        const score = typeof v === 'object' ? v.cvss : '';
                        return (
                          <tr key={i}>
                            <td style={{ fontFamily: 'monospace', fontWeight: 600 }}>{id}</td>
                            <td>{sev && <span className={`badge badge-${sev.toLowerCase()}`}>{sev}</span>}</td>
                            <td>{score || '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* SSL */}
          {result.ssl && (
            <div className="infra-card">
              <div className="infra-card-header"><h3>SSL/TLS Certificate</h3></div>
              <div className="infra-card-body">
                {Object.entries(result.ssl).map(([key, val]) => (
                  <div key={key} className="intel-kv">
                    <strong style={{ textTransform: 'capitalize' }}>{key.replace(/_/g, ' ')}:</strong>
                    <span>{typeof val === 'object' ? JSON.stringify(val) : (val || '—')}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </main>
  );
};

export default InfrastructureIntel;
