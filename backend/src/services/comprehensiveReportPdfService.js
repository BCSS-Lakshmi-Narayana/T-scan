const PDFDocument = require('pdfkit');

const C = {
  primary: '#0f2b4c', secondary: '#475569', danger: '#dc2626',
  warning: '#f59e0b', success: '#16a34a', dark: '#1e293b',
  light: '#f1f5f9', white: '#ffffff', accent: '#2563eb'
};

const addHeader = (doc, title, dateKey, dateRange) => {
  doc.fontSize(22).fillColor(C.primary).font('Helvetica-Bold')
    .text(title, 50, 50, { align: 'center' });
  doc.fontSize(11).fillColor(C.secondary).font('Helvetica')
    .text(`Report Date: ${dateKey}`, 50, 80, { align: 'center' });
  doc.fontSize(9).text(`Period: ${new Date(dateRange.start).toLocaleDateString('en-IN')} 06:00 AM to ${new Date(dateRange.end).toLocaleDateString('en-IN')} 06:00 AM`, 50, 98, { align: 'center' });
  doc.fontSize(8).text(`Generated: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST | CONFIDENTIAL`, 50, 112, { align: 'center' });
  doc.moveTo(50, 130).lineTo(doc.page.width - 50, 130).strokeColor(C.primary).lineWidth(2).stroke();
};

const addSection = (doc, title, y) => {
  if (y > doc.page.height - 120) { doc.addPage(); y = 50; }
  doc.fontSize(14).fillColor(C.primary).font('Helvetica-Bold').text(title, 50, y);
  doc.moveTo(50, y + 20).lineTo(doc.page.width - 50, y + 20).strokeColor(C.accent).lineWidth(1).stroke();
  return y + 30;
};

const addKV = (doc, key, value, y, opts = {}) => {
  if (y > doc.page.height - 80) { doc.addPage(); y = 50; }
  doc.fontSize(10).fillColor(C.secondary).font('Helvetica-Bold')
    .text(`${key}:`, 65, y, { continued: true, width: 160 });
  doc.fillColor(opts.color || C.dark).font(opts.bold ? 'Helvetica-Bold' : 'Helvetica')
    .text(` ${value}`, { width: 400 });
  return y + 20;
};

const addTable = (doc, headers, rows, y, colWidths) => {
  if (y > doc.page.height - 180) { doc.addPage(); y = 50; }
  const totalW = doc.page.width - 100;
  const cw = colWidths || headers.map(() => totalW / headers.length);
  let cy = y;
  doc.fontSize(8).fillColor(C.white).font('Helvetica-Bold');
  doc.rect(50, cy, totalW, 22).fillAndStroke(C.primary, C.primary);
  let cx = 55;
  headers.forEach((h, i) => { doc.text(h, cx, cy + 7, { width: cw[i] - 10, align: 'left' }); cx += cw[i]; });
  cy += 22;
  doc.fillColor(C.dark).font('Helvetica').fontSize(8);
  rows.forEach((row, ri) => {
    if (cy > doc.page.height - 80) { doc.addPage(); cy = 50; }
    doc.rect(50, cy, totalW, 18).fillAndStroke(ri % 2 === 0 ? C.white : C.light, C.secondary);
    cx = 55;
    row.forEach((cell, i) => { doc.fillColor(C.dark).text(String(cell || ''), cx, cy + 4, { width: cw[i] - 10, align: 'left' }); cx += cw[i]; });
    cy += 18;
  });
  return cy + 15;
};

const addText = (doc, text, y, opts = {}) => {
  if (y > doc.page.height - 100) { doc.addPage(); y = 50; }
  doc.fontSize(opts.size || 9).fillColor(opts.color || C.dark).font(opts.font || 'Helvetica')
    .text(text, 65, y, { width: doc.page.width - 130 });
  return y + (opts.height || 60);
};

const generateComprehensiveReportPdf = async (report) => {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margins: { top: 50, bottom: 50, left: 50, right: 50 },
        info: { Title: `Comprehensive Intelligence Report - ${report.date_key}`, Author: 'SOCEYE Intelligence System' } });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      addHeader(doc, 'COMPREHENSIVE INTELLIGENCE REPORT', report.date_key, report.date_range);
      let y = 150;

      // 1. EXECUTIVE SUMMARY
      y = addSection(doc, '1. EXECUTIVE SUMMARY', y);
      y = addText(doc, report.executive_summary, y, { height: 80 });

      // 2. SUMMARY CARDS
      y = addSection(doc, '2. SUMMARY DASHBOARD', y);

      // A. Dial-100
      y = addSection(doc, 'A. Dial-100 Calls', y);
      y = addKV(doc, 'Total Calls', String(report.dial100_calls.total_count), y, { bold: true });
      y = addKV(doc, 'Trend', `${report.dial100_calls.trend_percentage >= 0 ? '+' : ''}${report.dial100_calls.trend_percentage}%`, y, { color: report.dial100_calls.trend_percentage > 0 ? C.danger : C.success });
      y = addKV(doc, 'Critical Incidents', String(report.dial100_calls.critical_incidents), y, { color: report.dial100_calls.critical_incidents > 5 ? C.danger : C.dark });
      y = addKV(doc, 'Avg Response Time', `${report.dial100_calls.response_time_avg} min`, y);
      y = addText(doc, report.dial100_calls.ai_summary, y, { size: 8, height: 40 });

      // B. Grievances
      y = addSection(doc, 'B. Grievances', y);
      y = addKV(doc, 'Total', String(report.grievances.total_count), y, { bold: true });
      y = addKV(doc, 'Under Review', String(report.grievances.under_review), y, { color: C.warning });
      y = addKV(doc, 'Pending', String(report.grievances.pending), y, { color: C.danger });
      y = addKV(doc, 'Closed', String(report.grievances.closed), y, { color: C.success });
      y = addText(doc, report.grievances.ai_summary, y, { size: 8, height: 40 });

      // C. Events
      doc.addPage(); y = 50;
      y = addSection(doc, 'C. Events Intelligence', y);
      y = addKV(doc, 'Total Events', String(report.events.total_count), y, { bold: true });
      y = addKV(doc, 'Human Trafficking', String(report.events.human_trafficking), y, { color: C.danger });
      y = addKV(doc, 'Public Unrest', String(report.events.public_unrest), y, { color: C.warning });
      y = addKV(doc, 'Other', String(report.events.other_categorized), y);
      y = addText(doc, report.events.ai_insights, y, { size: 8, height: 40 });
      y = addText(doc, report.events.ai_observations, y, { size: 8, height: 40 });

      if (report.events.top_events.length > 0) {
        y = addTable(doc, ['#', 'Event Name', 'Type', 'Risk', 'Platforms'],
          report.events.top_events.slice(0, 15).map((e, i) => [i + 1, (e.event_name || '').substring(0, 30), e.event_type || 'detected', String(e.risk_score || 0), (e.platforms || []).join(', ')]), y,
          [25, 180, 70, 50, 150]);
      }

      // D. Alerts
      doc.addPage(); y = 50;
      y = addSection(doc, 'D. Alerts Intelligence', y);
      y = addKV(doc, 'Total Alerts', String(report.alerts.total_count), y, { bold: true });
      y = addKV(doc, 'HIGH Priority', String(report.alerts.priority_scoring.high), y, { color: C.danger, bold: true });
      y = addKV(doc, 'MEDIUM Priority', String(report.alerts.priority_scoring.medium), y, { color: C.warning });
      y = addKV(doc, 'LOW Priority', String(report.alerts.priority_scoring.low), y);
      y = addKV(doc, 'Escalated', String(report.alerts.escalated_count), y, { color: C.danger });
      y = addText(doc, report.alerts.ai_intelligence_summary, y, { size: 8, height: 40 });

      if (report.alerts.top_5_critical.length > 0) {
        y = addSection(doc, 'Top 5 Critical Alerts', y);
        y = addTable(doc, ['#', 'Title', 'Category', 'Risk', 'Status'],
          report.alerts.top_5_critical.map((a, i) => [i + 1, (a.title || '').substring(0, 35), (a.category || '').substring(0, 20), String(a.risk_score), a.status || 'active']), y,
          [25, 200, 120, 50, 80]);
      }

      // Top Profiles
      if (report.alerts.top_profiles.length > 0) {
        doc.addPage(); y = 50;
        y = addSection(doc, 'Top 10 Suspicious Profiles', y);
        y = addTable(doc, ['#', 'Name', 'Platform', 'Category', 'Influence', 'Threat'],
          report.alerts.top_profiles.map((p, i) => [i + 1, (p.name || '').substring(0, 25), p.platform, (p.category || '').substring(0, 15), String(p.influence_score), String(p.threat_score)]), y,
          [25, 150, 80, 80, 70, 70]);
      }

      // Viral Posts
      if (report.alerts.viral_posts.length > 0) {
        doc.addPage(); y = 50;
        y = addSection(doc, 'Top Viral Posts', y);
        y = addTable(doc, ['#', 'Preview', 'Platform', 'Virality'],
          report.alerts.viral_posts.map((p, i) => [i + 1, (p.content_preview || '').substring(0, 40), p.platform, String(p.virality_score)]), y,
          [25, 250, 80, 120]);
      }

      // Alert Summaries
      if (report.alerts.alert_summaries.length > 0) {
        doc.addPage(); y = 50;
        y = addSection(doc, 'Top 50 Alert Summaries', y);
        y = addTable(doc, ['#', 'Title', 'Category', 'Threat', 'Status'],
          report.alerts.alert_summaries.slice(0, 50).map((a, i) => [i + 1, (a.title || '').substring(0, 35), (a.category || '').substring(0, 18), a.threat_level, a.status || 'active']), y,
          [25, 200, 110, 70, 70]);
      }

      // E. Escalations
      doc.addPage(); y = 50;
      y = addSection(doc, 'E. Escalated to Investigation', y);
      y = addKV(doc, 'Total Escalated', String(report.escalations.total_count), y, { bold: true });
      y = addKV(doc, 'Under Action', String(report.escalations.under_action), y, { color: C.warning });
      y = addKV(doc, 'Pending', String(report.escalations.pending), y, { color: C.danger });
      y = addKV(doc, 'Closed', String(report.escalations.closed), y, { color: C.success });
      y = addText(doc, report.escalations.ai_recommendation, y, { size: 8, height: 50 });

      // F. Profiles
      y = addSection(doc, 'F. Profiles Monitoring', y);
      y = addKV(doc, 'Total Monitoring', String(report.profiles.total_monitoring), y, { bold: true });
      y = addKV(doc, 'Added', String(report.profiles.added_count), y, { color: C.success });
      y = addKV(doc, 'Deleted', String(report.profiles.deleted_count), y, { color: C.danger });
      y = addKV(doc, 'High Risk', String(report.profiles.high_risk), y, { color: C.danger });

      if (report.profiles.high_risk_profiles.length > 0) {
        y = addTable(doc, ['#', 'Name', 'Platform', 'Handle', 'Alerts'],
          report.profiles.high_risk_profiles.map((p, i) => [i + 1, (p.name || '').substring(0, 25), p.platform, (p.handle || '').substring(0, 20), String(p.alert_count)]), y,
          [25, 150, 80, 120, 100]);
      }

      // G. Keywords
      doc.addPage(); y = 50;
      y = addSection(doc, 'G. Top 10 Keywords / Trends', y);
      if (report.keywords_trends.length > 0) {
        y = addTable(doc, ['#', 'Keyword', 'Frequency', 'Sentiment', 'Trend', 'Risk'],
          report.keywords_trends.map((k, i) => [i + 1, k.keyword, String(k.frequency), k.sentiment, k.trend, k.risk_level]), y,
          [25, 120, 70, 70, 70, 120]);
      }

      // Threat Highlights & Recommendations
      doc.addPage(); y = 50;
      y = addSection(doc, 'THREAT HIGHLIGHTS', y);
      y = addText(doc, report.threat_highlights, y, { height: 60 });
      y = addSection(doc, 'ESCALATION RECOMMENDATIONS', y);
      y = addText(doc, report.escalation_recommendations, y, { height: 80 });
      y = addSection(doc, 'INTELLIGENCE OBSERVATIONS', y);
      y = addText(doc, report.intelligence_observations, y, { height: 60 });

      // Footer on all pages
      const totalPages = doc.bufferedPageRange().count;
      for (let i = 0; i < totalPages; i++) {
        doc.switchToPage(i);
        doc.fontSize(7).fillColor(C.secondary).font('Helvetica')
          .text(`CONFIDENTIAL - For Official Use Only | Page ${i + 1} | SOCEYE Intelligence System`,
            50, doc.page.height - 40, { align: 'center', width: doc.page.width - 100 });
      }

      doc.end();
    } catch (error) { reject(error); }
  });
};

module.exports = { generateComprehensiveReportPdf };