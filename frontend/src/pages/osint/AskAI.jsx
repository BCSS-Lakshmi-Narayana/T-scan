import React, { useState, useCallback } from 'react';
import { askAI } from './osintApi';

const QUICK_PROMPTS = [
  'I have a suspicious email address, what tools should I use?',
  'How do I investigate a phone number from India?',
  'What is the best way to map someone\'s digital footprint?',
  'How can I check if an image has been manipulated?',
  'Recommend tools for domain reconnaissance.',
];

const AskAI = () => {
  const [query, setQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  const handleSubmit = useCallback(async (e) => {
    e.preventDefault();
    if (!query.trim()) { setError('Describe your investigation.'); return; }
    setIsLoading(true); setError(''); setResult(null);
    try {
      const data = await askAI(query.trim());
      setResult(data);
    } catch (err) { setError(err.message); }
    finally { setIsLoading(false); }
  }, [query]);

  const applyPrompt = (p) => { setQuery(p); setResult(null); setError(''); };

  return (
    <main className="container my-4">
      <div className="portal-card">
        <div className="section-head">Cyber Investigation Copilot</div>
        <div className="p-3" style={{ padding: '1.25rem' }}>

          <p className="text-muted mb-3" style={{ fontSize: '.9rem' }}>
            Describe your investigation scenario and the AI will recommend the best OSINT tools,
            investigation flow, and analysis approach.
          </p>

          {/* Quick Prompts */}
          <div className="d-flex flex-wrap gap-2 mb-3">
            {QUICK_PROMPTS.map((p, i) => (
              <button key={i} className="prompt-chip" onClick={() => applyPrompt(p)}>{p}</button>
            ))}
          </div>

          <form onSubmit={handleSubmit}>
            <textarea
              className="input-control mb-3"
              rows={4}
              placeholder="Describe your investigation scenario..."
              value={query}
              onChange={e => setQuery(e.target.value)}
              style={{ resize: 'vertical' }}
            />
            <button type="submit" className="btn-intel" disabled={isLoading}>
              {isLoading ? <><span className="spinner-border me-2" />Analyzing...</> : 'Ask AI'}
            </button>
          </form>

          {error && <div className="alert alert-danger mt-3">{error}</div>}

          {/* Results */}
          {result && (
            <div className="mt-4">
              {/* Summary */}
              {result.summary && (
                <div className="portal-card mb-3">
                  <div className="section-head">Summary</div>
                  <div className="p-3" style={{ fontSize: '.9rem' }}>{result.summary}</div>
                </div>
              )}

              {/* Recommended Tools */}
              {result.tools && result.tools.length > 0 && (
                <div className="portal-card mb-3">
                  <div className="section-head">Recommended Tools</div>
                  <div className="p-3">
                    <div className="row g-2">
                      {result.tools.map((t, i) => (
                        <div key={i} className="col-md-6">
                          <div className="intel-box">
                            <div className="d-flex justify-content-between align-items-start mb-1">
                              <strong style={{ fontSize: '.9rem', color: '#062952' }}>{t.name}</strong>
                              {t.free_paid && <span className={`badge ${t.free_paid === 'Free' ? 'bg-success' : 'bg-warning'}`} style={{ fontSize: '.7rem' }}>{t.free_paid}</span>}
                            </div>
                            {t.category && <p style={{ fontSize: '.78rem', color: '#6c757d', margin: '0 0 .3rem' }}>{t.category}</p>}
                            {t.input && <p style={{ fontSize: '.82rem', margin: '0 0 .2rem' }}><strong>Input:</strong> {t.input}</p>}
                            {t.output && <p style={{ fontSize: '.82rem', margin: 0 }}><strong>Output:</strong> {t.output}</p>}
                            {t.url && <a href={t.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: '.8rem' }}>Open Tool &rarr;</a>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Investigation Flow */}
              {result.investigation_flow && result.investigation_flow.length > 0 && (
                <div className="portal-card mb-3">
                  <div className="section-head">Investigation Flow</div>
                  <div className="p-3">
                    <ol style={{ paddingLeft: '1.2rem', margin: 0 }}>
                      {result.investigation_flow.map((step, i) => (
                        <li key={i} style={{ fontSize: '.88rem', marginBottom: '.5rem', color: '#212529' }}>{step}</li>
                      ))}
                    </ol>
                  </div>
                </div>
              )}

              {/* Notes */}
              {result.notes && (
                <div className="notice-callout mt-3">
                  <strong>Notes:</strong> {result.notes}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </main>
  );
};

export default AskAI;
