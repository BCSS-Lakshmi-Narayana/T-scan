import React, { useState } from 'react';

const MASTER_PROMPT = `# ROLE
You are a senior OSINT/SOCMINT Intelligence Analyst working in a digital investigations unit. You have 15+ years of experience in cyber intelligence, digital forensics, and open-source investigation methodology.

# CONTEXT
I am going to provide you with raw JSON output from multiple OSINT scanning tools. These tools include:
- **Holehe**: Email registration footprint across 100+ websites
- **Sherlock / Maigret**: Username presence across 300-500+ social platforms
- **User-Scanner**: Cross-platform username enumeration (195+ sites)
- **Phone Intelligence**: Number validation, carrier lookup, geolocation
- **Infrastructure Intel (Shodan)**: IP/domain reconnaissance, open ports, services, vulnerabilities
- **Image Metadata (EXIF)**: GPS coordinates, device info, timestamps, forensic indicators
- **Disposable Email Check**: Temporary/throwaway email detection
- **Email Breach & Intel Pivots**: Known data breaches and OSINT pivot links

# INSTRUCTIONS
Analyze ALL provided scan results and produce a comprehensive intelligence report with the following structure:

## 1. EXECUTIVE SUMMARY
- 3-5 sentence overview of key findings
- Overall risk level: LOW / MEDIUM / HIGH / CRITICAL
- Confidence assessment of findings

## 2. KEY FINDINGS
- Most significant discoveries ranked by intelligence value
- Cross-tool correlations and patterns

## 3. DIGITAL FOOTPRINT ANALYSIS

### 3a. Email Intelligence
- Registered accounts discovered (from Holehe)
- Breach exposure history
- Disposable email indicators
- Email-based pivot opportunities

### 3b. Username Intelligence
- Platform presence map
- Account consistency analysis
- Active vs dormant accounts
- Platform category breakdown (social, dev, gaming, etc.)

### 3c. Phone Intelligence
- Number validation and formatting
- Carrier and type analysis
- Geographic indicators
- Associated search pivots

### 3d. Infrastructure Intelligence
- Host/IP summary
- Open ports and services
- Technology stack
- Known vulnerabilities (CVEs)
- SSL/TLS certificate analysis

### 3e. Image Metadata Intelligence
- Device identification
- GPS/location data
- Temporal analysis
- Forensic indicators and anomalies

## 4. IDENTITY CORRELATION
- Cross-reference findings between tools
- Identity linkage confidence
- Alternative identity indicators

## 5. RISK ASSESSMENT
- Threat level with justification
- Attack surface analysis
- Exposure severity

## 6. INVESTIGATIVE LEADS
- Recommended follow-up actions
- Additional tools or techniques to employ
- Priority ranking of leads

## 7. RECOMMENDED TOOLS
- Specific tools for next steps
- Both free and paid options
- Expected outputs

## 8. VERIFICATION REQUIREMENTS
- What needs independent confirmation
- Potential false positives
- Data quality caveats

## 9. CAVEATS & OPSEC
- Legal considerations
- Data handling requirements
- Operational security advisories

# OUTPUT FORMAT
Use clear Markdown formatting with headers, bullet points, and tables where appropriate.
Flag high-value intelligence with [HIGH VALUE] tags.
Include confidence levels (HIGH/MEDIUM/LOW) for each major finding.

--- PASTE YOUR SCAN RESULTS BELOW THIS LINE ---`;

const STEPS = [
  { num: 1, title: 'Run Comprehensive Scans', desc: 'Use all relevant tools — Email, Username, Phone, Infrastructure, Image — to collect maximum intelligence.' },
  { num: 2, title: 'Export All Results', desc: 'Use the Export PDF or copy raw JSON from each tool\'s results panel.' },
  { num: 3, title: 'Combine Results', desc: 'Paste all JSON outputs together under the master prompt.' },
  { num: 4, title: 'Submit to AI', desc: 'Paste the combined prompt + results into ChatGPT (GPT-4), Claude, or Gemini.' },
  { num: 5, title: 'Review & Verify', desc: 'Cross-check the AI analysis, verify key findings, and note confidence levels.' },
];

const MasterPrompt = () => {
  const [copied, setCopied] = useState(false);

  const copyPrompt = () => {
    navigator.clipboard.writeText(MASTER_PROMPT).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  };

  return (
    <main className="container my-4">
      <div className="portal-card">
        <div className="section-head">Master Analysis Prompt</div>
        <div className="p-3" style={{ padding: '1.25rem' }}>

          <div className="notice-callout mb-4">
            <strong>About this prompt:</strong> This is a comprehensive master prompt designed for external AI platforms.
            It instructs the AI to produce a full intelligence report from your combined OSINT scan results.
            Copy it, paste into your preferred AI, then append all your scan outputs below the divider line.
          </div>

          {/* Steps */}
          <div className="row g-3 mb-4">
            {STEPS.map(s => (
              <div key={s.num} className="col-md-6 col-lg-4">
                <div className="service-tile" style={{ minHeight: 110 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', marginBottom: '.5rem' }}>
                    <span className="step-number">{s.num}</span>
                    <strong style={{ fontSize: '.9rem', color: '#062952' }}>{s.title}</strong>
                  </div>
                  <p className="text-muted" style={{ fontSize: '.84rem', margin: 0 }}>{s.desc}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Prompt */}
          <div className="portal-card mb-3">
            <div className="section-head d-flex justify-content-between align-items-center">
              <span>Master Prompt</span>
              <button className="btn-intel" style={{ fontSize: '.78rem', padding: '.35rem .9rem' }} onClick={copyPrompt}>
                {copied ? 'Copied!' : 'Copy Full Prompt'}
              </button>
            </div>
            <div className="p-3">
              <pre style={{ background: '#0a1929', color: '#d4e6f1', padding: '1rem', borderRadius: 8, fontSize: '.8rem', whiteSpace: 'pre-wrap', maxHeight: 500, overflowY: 'auto', lineHeight: 1.55 }}>
                {MASTER_PROMPT}
              </pre>
            </div>
          </div>

          {/* OPSEC Notice */}
          <div className="advisory-bar mt-4">
            <strong>OPSEC Advisory:</strong> Do not paste classified, sensitive, or PII data into public AI platforms
            without proper authorization. Ensure compliance with your organization's data handling policies.
          </div>

        </div>
      </div>
    </main>
  );
};

export default MasterPrompt;
