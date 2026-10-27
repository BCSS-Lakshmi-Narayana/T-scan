import React, { useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { fetchPhoneIntelligence } from './osintApi';

const PhoneTools = () => {
  const [searchParams] = useSearchParams();
  const [phone, setPhone] = useState(searchParams.get('phone') || '');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  const handleScan = useCallback(async (e) => {
    e.preventDefault();
    if (!phone) { setError('Enter a phone number.'); return; }
    setIsLoading(true); setError(''); setResult(null);
    try {
      const data = await fetchPhoneIntelligence(phone);
      setResult(data);
    } catch (err) { setError(err.message); }
    finally { setIsLoading(false); }
  }, [phone]);

  return (
    <main className="container my-4">
      <div className="portal-card">
        <div className="section-head">Phone Intelligence — OSINT Tools</div>
        <div className="p-3" style={{ padding: '1.25rem' }}>
          {error && <div className="alert alert-danger mb-3">{error}</div>}

          <p className="text-muted mb-3" style={{ fontSize: '.9rem' }}>
            Enter a phone number with country code to extract metadata, carrier, timezone, and search pivots.
          </p>

          <form onSubmit={handleScan}>
            <div className="row g-2 mb-3">
              <div className="col-md-8">
                <input className="input-control" type="text" placeholder="+1XXXXXXXXXX or +91 98765 43210" value={phone} onChange={e => setPhone(e.target.value)} />
              </div>
              <div className="col-md-4 d-grid">
                <button type="submit" className="btn-intel" disabled={isLoading}>
                  {isLoading ? <><span className="spinner-border me-2" />Scanning...</> : 'Run Scan'}
                </button>
              </div>
            </div>
          </form>

          <div className="row g-3 mb-4">
            <div className="col-md-4"><div className="service-tile"><strong>INT-01:</strong> Number validation & formatting</div></div>
            <div className="col-md-4"><div className="service-tile"><strong>INT-02:</strong> Carrier & geolocation lookup</div></div>
            <div className="col-md-4"><div className="service-tile"><strong>INT-03:</strong> Public search pivot links</div></div>
          </div>

          {/* Results */}
          {result && (
            <div className="mt-4">
              <div className="portal-card mb-3">
                <div className="section-head">
                  <span>Phone Analysis Results</span>
                  <span className="badge bg-success">Complete</span>
                </div>
                <div className="p-3">
                  {result.valid || result.is_valid ? (
                    <>
                      <span className="tag-hit mb-3" style={{ display: 'inline-block' }}>Valid Number Format</span>

                      <div className="row g-3 mt-2">
                        {/* Number Details */}
                        <div className="col-md-6">
                          <div className="intel-box">
                            <h6 style={{ color: '#062952', fontWeight: 700, fontSize: '.92rem', marginBottom: '.75rem' }}>Number Details</h6>
                            <div className="intel-kv"><strong>E.164:</strong> <span style={{ fontFamily: 'monospace' }}>{result.e164}</span></div>
                            <div className="intel-kv"><strong>International:</strong> <span>{result.international}</span></div>
                            <div className="intel-kv"><strong>National:</strong> <span>{result.national}</span></div>
                            <div className="intel-kv"><strong>Valid:</strong> <span className="badge bg-success">Yes</span></div>
                            <div className="intel-kv"><strong>Possible:</strong> <span>{result.possible ? 'Yes' : 'No'}</span></div>
                          </div>
                        </div>

                        {/* Carrier & Location */}
                        <div className="col-md-6">
                          <div className="intel-box">
                            <h6 style={{ color: '#062952', fontWeight: 700, fontSize: '.92rem', marginBottom: '.75rem' }}>Carrier & Location</h6>
                            <div className="intel-kv"><strong>Carrier:</strong> <span>{result.carrier || '—'}</span></div>
                            <div className="intel-kv"><strong>Type:</strong> <span className="badge bg-info">{result.number_type || '—'}</span></div>
                            <div className="intel-kv"><strong>Region:</strong> <span>{result.region || result.location || '—'}</span></div>
                            <div className="intel-kv"><strong>Country:</strong> <span>{result.country || '—'}</span></div>
                            <div className="intel-kv"><strong>Country Code:</strong> <span>{result.country_code || '—'}</span></div>
                            {result.timezones && <div className="intel-kv"><strong>Timezones:</strong> <span>{result.timezones.join(', ')}</span></div>}
                          </div>
                        </div>
                      </div>

                      {/* Search Pivots */}
                      {result.search_links && result.search_links.length > 0 && (
                        <div className="portal-card mt-3">
                          <div className="section-head"><span>Public Search Pivots</span></div>
                          <div className="p-3">
                            <div className="row g-2">
                              {result.search_links.map((link, i) => (
                                <div key={i} className="col-md-4">
                                  <a href={link.url} target="_blank" rel="noopener noreferrer"
                                    style={{ display: 'block', padding: '.6rem .9rem', background: '#f8fbff', border: '1px solid #d3deef', borderRadius: '8px', fontSize: '.85rem', fontWeight: 600, color: '#062952', textDecoration: 'none' }}>
                                    {link.name} &rarr;
                                  </a>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="alert alert-danger">
                      {result.error || 'Invalid phone number format. Please include country code (e.g. +91).'}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </main>
  );
};

export default PhoneTools;
