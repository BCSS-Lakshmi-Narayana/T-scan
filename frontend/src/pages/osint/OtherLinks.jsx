import React, { useState, useEffect, useCallback } from 'react';

const CATEGORIES = [
  'All', 'Email OSINT', 'Username OSINT', 'Phone OSINT', 'Social Media',
  'Image & Video', 'Domain & IP', 'Dark Web', 'People Search', 'General OSINT',
];

const DEFAULT_LINKS = [
  { title: 'Have I Been Pwned', url: 'https://haveibeenpwned.com', description: 'Check if your email has been in a data breach.', category: 'Email OSINT', cost: 'Free' },
  { title: 'Hunter.io', url: 'https://hunter.io', description: 'Find email addresses associated with a domain.', category: 'Email OSINT', cost: 'Freemium' },
  { title: 'Namechk', url: 'https://namechk.com', description: 'Check username availability across many platforms.', category: 'Username OSINT', cost: 'Free' },
  { title: 'WhatsMyName', url: 'https://whatsmyname.app', description: 'Web-based username enumeration tool.', category: 'Username OSINT', cost: 'Free' },
  { title: 'PhoneInfoga', url: 'https://github.com/sundowndev/phoneinfoga', description: 'Advanced phone number intelligence gathering.', category: 'Phone OSINT', cost: 'Free' },
  { title: 'Shodan', url: 'https://www.shodan.io', description: 'Search engine for Internet-connected devices.', category: 'Domain & IP', cost: 'Freemium' },
  { title: 'Censys', url: 'https://censys.io', description: 'Internet-wide scanning and certificate search.', category: 'Domain & IP', cost: 'Freemium' },
  { title: 'TinEye', url: 'https://tineye.com', description: 'Reverse image search engine.', category: 'Image & Video', cost: 'Free' },
  { title: 'PimEyes', url: 'https://pimeyes.com', description: 'Face recognition search engine.', category: 'Image & Video', cost: 'Paid' },
  { title: 'Maltego', url: 'https://www.maltego.com', description: 'Visual link analysis for investigations.', category: 'General OSINT', cost: 'Freemium' },
  { title: 'SpiderFoot', url: 'https://www.spiderfoot.net', description: 'Automated OSINT collection and analysis.', category: 'General OSINT', cost: 'Free' },
  { title: 'Pipl', url: 'https://pipl.com', description: 'People search engine for identity resolution.', category: 'People Search', cost: 'Paid' },
  { title: 'Social Searcher', url: 'https://www.social-searcher.com', description: 'Free social media search engine.', category: 'Social Media', cost: 'Free' },
  { title: 'IntelX', url: 'https://intelx.io', description: 'Search engine for breaches, dark web, and more.', category: 'Dark Web', cost: 'Freemium' },
];

const OtherLinks = () => {
  const [links, setLinks] = useState(DEFAULT_LINKS);
  const [activeCategory, setActiveCategory] = useState('All');
  const [search, setSearch] = useState('');

  const filtered = links.filter(l => {
    const catMatch = activeCategory === 'All' || l.category === activeCategory;
    const searchMatch = !search || l.title.toLowerCase().includes(search.toLowerCase()) || l.description.toLowerCase().includes(search.toLowerCase());
    return catMatch && searchMatch;
  });

  const costBadge = (cost) => {
    if (cost === 'Free') return 'bg-success';
    if (cost === 'Paid') return 'bg-danger';
    return 'bg-warning';
  };

  return (
    <main className="container my-4">
      <div className="portal-card">
        <div className="section-head">OSINT & Cybersecurity Resource Directory</div>
        <div className="p-3" style={{ padding: '1.25rem' }}>

          <p className="text-muted mb-3" style={{ fontSize: '.9rem' }}>
            Curated collection of external OSINT tools, platforms, and resources for cyber investigations.
          </p>

          {/* Search & Filter */}
          <div className="row g-2 mb-3">
            <div className="col-md-6">
              <input className="input-control" placeholder="Search tools..." value={search} onChange={e => setSearch(e.target.value)} />
            </div>
          </div>

          {/* Category Pills */}
          <div className="d-flex flex-wrap gap-2 mb-4">
            {CATEGORIES.map(cat => (
              <button
                key={cat}
                className={`category-pill ${activeCategory === cat ? 'active' : ''}`}
                onClick={() => setActiveCategory(cat)}
              >
                {cat}
              </button>
            ))}
          </div>

          {/* Links Grid */}
          <div className="row g-3">
            {filtered.length > 0 ? filtered.map((link, i) => (
              <div key={i} className="col-md-6 col-lg-4">
                <div className="link-card">
                  <div className="d-flex justify-content-between align-items-start mb-2">
                    <h6 style={{ fontWeight: 700, color: '#062952', fontSize: '.92rem', margin: 0 }}>{link.title}</h6>
                    <span className={`badge ${costBadge(link.cost)}`} style={{ fontSize: '.68rem' }}>{link.cost}</span>
                  </div>
                  <p className="text-muted" style={{ fontSize: '.83rem', marginBottom: '.6rem' }}>{link.description}</p>
                  <div className="d-flex justify-content-between align-items-center">
                    <span style={{ fontSize: '.75rem', color: '#6c757d' }}>{link.category}</span>
                    <a href={link.url} target="_blank" rel="noopener noreferrer"
                      style={{ fontSize: '.82rem', fontWeight: 600, color: '#0b3d6e', textDecoration: 'none' }}>
                      Visit &rarr;
                    </a>
                  </div>
                </div>
              </div>
            )) : (
              <div className="col-12 text-center py-4">
                <p className="text-muted">No tools found matching your criteria.</p>
              </div>
            )}
          </div>

        </div>
      </div>
    </main>
  );
};

export default OtherLinks;
