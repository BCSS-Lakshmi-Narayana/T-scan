import React, { useState } from 'react';
import { Link } from 'react-router-dom';

const ANALYSIS_PROMPT = `You are an expert OSINT/SOCMINT analyst. I will paste the raw JSON results from various scanning tools below.

Please provide:
1. A brief executive summary of findings
2. Key identity indicators discovered
3. Risk assessment (low/medium/high) with justification
4. Recommended next investigative steps
5. Any connections or patterns between different data points

Format your response with clear headings and bullet points.

--- PASTE YOUR SCAN RESULTS BELOW THIS LINE ---`;

const STEPS = [
  { num: 1, title: 'Run Your Scans', desc: 'Use the Email, Username, Phone, Infrastructure, or Image tools to gather raw intelligence data.' },
  { num: 2, title: 'Export or Copy Results', desc: 'Copy the JSON results or use the Export PDF feature from any scan results page.' },
  { num: 3, title: 'Open an AI Platform', desc: 'Navigate to ChatGPT, Claude, Gemini, or any LLM of your choice.' },
  { num: 4, title: 'Paste the Prompt Below', desc: 'Copy the analysis prompt, paste it into the AI, then append your scan results.' },
  { num: 5, title: 'Review AI Analysis', desc: 'The AI will provide structured analysis, risk assessment, and recommended next steps.' },
];

const AIAssistant = () => {
  const [copied, setCopied] = useState(false);

  const copyPrompt = () => {
    navigator.clipboard.writeText(ANALYSIS_PROMPT).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <main className="container my-4">
      <div className="portal-card">
        <div className="section-head">AI Investigation Assistant</div>
        <div className="p-3" style={{ padding: '1.25rem' }}>

          <div className="notice-callout mb-4">
            <strong>How to use AI for OSINT analysis:</strong> Follow the steps below to leverage external AI platforms
            (ChatGPT, Claude, Gemini) to interpret your scan results and generate actionable intelligence reports.
          </div>

          {/* Steps */}
          <div className="row g-3 mb-4">
            {STEPS.map(s => (
              <div key={s.num} className="col-md-6 col-lg-4">
                <div className="service-tile" style={{ minHeight: 120 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', marginBottom: '.5rem' }}>
                    <span className="step-number">{s.num}</span>
                    <strong style={{ fontSize: '.92rem', color: '#062952' }}>{s.title}</strong>
                  </div>
                  <p className="text-muted" style={{ fontSize: '.85rem', margin: 0 }}>{s.desc}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Prompt Box */}
          <div className="portal-card mb-4">
            <div className="section-head d-flex justify-content-between align-items-center">
              <span>Analysis Prompt</span>
              <button className="btn-intel" style={{ fontSize: '.78rem', padding: '.35rem .9rem' }} onClick={copyPrompt}>
                {copied ? 'Copied!' : 'Copy Prompt'}
              </button>
            </div>
            <div className="p-3">
              <pre style={{ background: '#0a1929', color: '#d4e6f1', padding: '1rem', borderRadius: 8, fontSize: '.82rem', whiteSpace: 'pre-wrap', maxHeight: 300, overflowY: 'auto' }}>
                {ANALYSIS_PROMPT}
              </pre>
            </div>
          </div>

          {/* Quick Links */}
          <div className="row g-3">
            <div className="col-md-4">
              <a href="https://chat.openai.com" target="_blank" rel="noopener noreferrer"
                style={{ display: 'block', padding: '.8rem 1rem', background: '#f8fbff', border: '1px solid #d3deef', borderRadius: 8, fontWeight: 600, color: '#062952', textDecoration: 'none', fontSize: '.9rem' }}>
                ChatGPT &rarr;
              </a>
            </div>
            <div className="col-md-4">
              <a href="https://claude.ai" target="_blank" rel="noopener noreferrer"
                style={{ display: 'block', padding: '.8rem 1rem', background: '#f8fbff', border: '1px solid #d3deef', borderRadius: 8, fontWeight: 600, color: '#062952', textDecoration: 'none', fontSize: '.9rem' }}>
                Claude &rarr;
              </a>
            </div>
            <div className="col-md-4">
              <a href="https://gemini.google.com" target="_blank" rel="noopener noreferrer"
                style={{ display: 'block', padding: '.8rem 1rem', background: '#f8fbff', border: '1px solid #d3deef', borderRadius: 8, fontWeight: 600, color: '#062952', textDecoration: 'none', fontSize: '.9rem' }}>
                Gemini &rarr;
              </a>
            </div>
          </div>

          <div className="mt-4 d-flex gap-2">
            <Link to="/analysis-tools/osint-tools/ask-ai" className="btn-intel" style={{ textDecoration: 'none' }}>
              Try Ask AI Copilot &rarr;
            </Link>
            <Link to="/analysis-tools/osint-tools/master-prompt" className="btn-intel" style={{ textDecoration: 'none', background: 'transparent', color: '#0b3d6e', border: '1px solid #0b3d6e' }}>
              View Master Prompt &rarr;
            </Link>
          </div>

        </div>
      </div>
    </main>
  );
};

export default AIAssistant;
