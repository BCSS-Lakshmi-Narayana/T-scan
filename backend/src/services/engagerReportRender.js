/**
 * Renders the engager analysis report (engagerReportService data) as a PDF
 * (HTML printed by the shared headless browser) or an Excel workbook.
 */

const ExcelJS = require('exceljs');
const { getBrowser, escapeHtml: esc } = require('./reportPdfService');

const PDF_ENGAGER_ROWS = 500;     // the full list is always in the Excel file

const TIER_LABEL = { 'super-active': 'Super-active', regular: 'Regular', occasional: 'Occasional', 'one-time': 'One-time' };
const TIER_COLOR = { 'super-active': '#b91c1c', regular: '#c2410c', occasional: '#2563eb', 'one-time': '#64748b' };

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const fmtDateTime = (d) => (d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' IST' : '—');
const fmtNum = (n) => Number(n || 0).toLocaleString('en-IN');
const pct = (x) => `${Math.round((x || 0) * 100)}%`;
const excerpt = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

const pill = (label, color) => `<span class="pill" style="background:${color}1a;color:${color};border-color:${color}55">${esc(label)}</span>`;

const bars = (rows, total) => {
  if (!rows.length) return '<p class="muted">No data.</p>';
  const max = Math.max(...rows.map((r) => r.count));
  return `<table class="bars">${rows.map((r) => `
    <tr><td class="bl">${esc(r.label)}</td>
      <td class="bt"><div class="bar" style="width:${Math.max(2, (r.count / max) * 100)}%;background:${r.color}"></div></td>
      <td class="bn">${fmtNum(r.count)}${total ? ` <span class="muted">(${pct(r.count / total)})</span>` : ''}</td></tr>`).join('')}
  </table>`;
};

const engagerTable = (rows) => `
  <table class="grid">
    <thead><tr><th>#</th><th>Account</th><th class="r">Posts retweeted</th><th class="r">Share</th><th>Tier</th><th>First – last</th></tr></thead>
    <tbody>${rows.map((e, i) => `
      <tr><td class="muted">${i + 1}</td>
        <td><b>@${esc(e.handle)}</b>${e.verified ? ' <span class="ver">✓</span>' : ''}<div class="sub">${esc(excerpt(e.name, 40))}</div></td>
        <td class="r"><b>${fmtNum(e.posts_retweeted)}</b></td>
        <td class="r">${pct(e.share)}</td>
        <td>${pill(TIER_LABEL[e.frequency], TIER_COLOR[e.frequency])}</td>
        <td class="nowrap">${fmtDate(e.first_engaged)} – ${fmtDate(e.last_engaged)}</td>
      </tr>`).join('')}
    </tbody>
  </table>`;

const postCard = (p) => `
  <div class="post">
    <div class="post-head"><span class="muted">${fmtDateTime(p.created_at)}</span></div>
    <div class="post-text">${esc(excerpt(p.text, 420))}</div>
    <div class="post-foot">
      <span><b>${fmtNum(p.retweets)}</b> retweets · <b>${fmtNum(p.likes)}</b> likes · <b>${fmtNum(p.replies)}</b> replies · <b>${fmtNum(p.views)}</b> views</span>
      <a href="${esc(p.url)}">${esc(excerpt(p.url, 60))}</a>
    </div>
    ${p.top_engagers.length ? `<div class="post-eng"><span class="muted">Top engagers (${fmtNum(p.engagers.length)} found):</span> ${p.top_engagers.map((h) => `@${esc(h)}`).join(', ')}</div>` : ''}
  </div>`;

const buildReportHtml = (data, { generatedBy, generatedAt = new Date() } = {}) => {
  const t = data.totals;
  const tierRows = Object.entries(data.summary)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => ({ label: TIER_LABEL[key], count, color: TIER_COLOR[key] }));
  const maxDay = Math.max(1, ...data.timeline.map((d) => d.posts));
  const appendixEngagers = data.engagers.slice(0, PDF_ENGAGER_ROWS);

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Engager Analysis Report – @${esc(data.account.handle)}</title>
<style>
  @page { size: A4; margin: 16mm 14mm 16mm 14mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body { background: #fff; }
  body { margin: 0; color: #1e293b; font: 9.5px/1.45 Arial, 'Noto Sans', 'Noto Sans Telugu', 'Noto Sans Devanagari', sans-serif; }
  h2 { font-size: 12px; color: #0f2b4c; margin: 18px 0 6px; padding-bottom: 4px; border-bottom: 1.5px solid #0f2b4c; break-after: avoid; }
  .muted { color: #94a3b8; } .sub { color: #64748b; font-size: 8.5px; } .r { text-align: right; } .nowrap { white-space: nowrap; }
  .head { background: #0f2b4c; color: #fff; padding: 14px 16px; border-radius: 6px; }
  .head .title { font-size: 17px; font-weight: 800; letter-spacing: .02em; }
  .head .acct { font-size: 12px; margin-top: 2px; color: #cbd5e1; }
  .head .conf { float: right; font-size: 8px; font-weight: 700; letter-spacing: .12em; border: 1px solid #fbbf24; color: #fbbf24; padding: 2px 6px; border-radius: 3px; }
  .meta { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 10px; padding-top: 8px; border-top: 1px solid rgba(203,213,225,.3); }
  .meta label { display: block; font-size: 7px; text-transform: uppercase; letter-spacing: .08em; color: #94a3b8; }
  .meta span { font-size: 9.5px; font-weight: 600; }
  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-top: 10px; }
  .kpi { border: 1px solid #e2e8f0; border-radius: 5px; padding: 7px 9px; background: #f8fafc; }
  .kpi b { display: block; font-size: 15px; color: #0f2b4c; } .kpi span { font-size: 8px; color: #64748b; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  table { width: 100%; border-collapse: collapse; }
  .grid th { text-align: left; font-size: 8px; text-transform: uppercase; letter-spacing: .05em; color: #475569; background: #f1f5f9; padding: 4px 5px; border-bottom: 1px solid #cbd5e1; }
  .grid td { padding: 4px 5px; border-bottom: 1px solid #eef2f7; vertical-align: top; }
  .grid tr { break-inside: avoid; }
  .bars td { padding: 2px 4px; } .bl { width: 34%; } .bn { width: 22%; text-align: right; white-space: nowrap; }
  .bar { height: 9px; border-radius: 2px; }
  .pill { display: inline-block; padding: 0 5px; border: 1px solid; border-radius: 8px; font-size: 7.5px; font-weight: 700; white-space: nowrap; }
  .ver { color: #2563eb; font-weight: 700; }
  .post { border: 1px solid #e2e8f0; border-radius: 5px; padding: 7px 9px; margin-bottom: 6px; break-inside: avoid; }
  .post-foot { display: flex; justify-content: space-between; gap: 8px; font-size: 8.5px; color: #475569; }
  .post-foot a { color: #2563eb; text-decoration: none; }
  .post-text { margin: 4px 0; white-space: pre-wrap; word-break: break-word; }
  .post-eng { margin-top: 3px; font-size: 8.5px; }
  .note { background: #f8fafc; border-left: 3px solid #94a3b8; padding: 6px 9px; color: #475569; font-size: 8.5px; }
  .note li { margin: 2px 0; }
  .page-break { break-before: page; }
  .ptext { word-break: break-word; white-space: pre-wrap; }
  .plink { margin-top: 2px; font-size: 8px; white-space: normal; word-break: break-all; }
  .plink a { color: #2563eb; text-decoration: none; }
</style></head>
<body>
  <div class="head">
    <span class="conf">CONFIDENTIAL</span>
    <div class="title">Engager Analysis Report</div>
    <div class="acct">@${esc(data.account.handle)}${data.account.display_name && data.account.display_name !== data.account.handle ? ` · ${esc(data.account.display_name)}` : ''} · X (Twitter)</div>
    <div class="meta">
      <div><label>Report period</label><span>${fmtDate(data.range.from)} – ${fmtDate(data.range.to)}</span></div>
      <div><label>Analysis run</label><span>${fmtDateTime(data.analysis.analyzed_at)}</span></div>
      <div><label>Generated</label><span>${fmtDateTime(generatedAt)}</span></div>
      <div><label>Generated by</label><span>${esc(generatedBy || '—')}</span></div>
    </div>
  </div>

  <div class="kpis">
    <div class="kpi"><b>${fmtNum(t.posts)}</b><span>Posts in period</span></div>
    <div class="kpi"><b>${fmtNum(t.unique_engagers)}</b><span>Unique engagers</span></div>
    <div class="kpi"><b>${fmtNum(t.retweet_events)}</b><span>Retweets by engagers found</span></div>
    <div class="kpi"><b>${fmtNum(data.summary['super-active'] + data.summary.regular)}</b><span>Super-active + regular engagers</span></div>
    <div class="kpi"><b>${fmtNum(t.retweets)}</b><span>Total retweets (X count)</span></div>
    <div class="kpi"><b>${fmtNum(t.likes)}</b><span>Total likes</span></div>
    <div class="kpi"><b>${fmtNum(t.views)}</b><span>Total views</span></div>
    <div class="kpi"><b>${fmtNum(t.verified_engagers)}</b><span>Verified engagers</span></div>
  </div>

  <div class="cols">
    <div>
      <h2>Engager tiers</h2>
      ${bars(tierRows, t.unique_engagers)}
      <p class="sub">Super-active: retweeted ≥50% of posts or ≥10 posts · Regular: ≥25% or ≥5 · Occasional: 2+ · One-time: 1.</p>
    </div>
    <div>
      <h2>Posting activity</h2>
      <table class="bars">${data.timeline.slice(-14).map((d) => `
        <tr><td class="bl nowrap">${fmtDate(d.day)}</td>
          <td class="bt"><div class="bar" style="width:${Math.max(2, (d.posts / maxDay) * 100)}%;background:#0f2b4c"></div></td>
          <td class="bn">${d.posts} post${d.posts === 1 ? '' : 's'}</td></tr>`).join('') || '<tr><td class="muted">No posts.</td></tr>'}
      </table>
      ${data.timeline.length > 14 ? `<p class="sub">Last 14 active days shown; ${data.timeline.length} active days in the period.</p>` : ''}
    </div>
  </div>

  <h2>Most engaged accounts</h2>
  ${data.top_engagers.length ? engagerTable(data.top_engagers) : '<p class="muted">No engagers found for posts in this period.</p>'}
  <p class="sub">Share = posts this account retweeted ÷ ${fmtNum(t.posts_with_retweeter_data)} posts in the period with retweeter data.</p>

  <h2>Most amplified posts</h2>
  ${data.top_posts.map(postCard).join('') || '<p class="muted">No posts.</p>'}

  <h2>Method and limits</h2>
  <div class="note"><ul>
    <li>Engagers are accounts that <b>retweeted</b> the account's posts. Replies, quotes and likes are counted but the accounts behind them are not listed.</li>
    <li>Retweeters were fetched for up to the 40 most-retweeted posts of each analysis run, and X returns at most about 200 retweeters per post. ${fmtNum(t.posts_with_retweeter_data)} of ${fmtNum(t.posts)} posts in this period have retweeter data.</li>
    <li>The analysis covers posts from ${fmtDate(data.analysis.coverage?.start)} to ${fmtDate(data.analysis.coverage?.end)}. Counts here are recalculated for the report period only.</li>
    <li>Retweet, like, reply and view counts are as reported by X when the analysis ran.</li>
  </ul></div>

  <div class="page-break"></div>
  <h2>Appendix A · All posts in the period (${fmtNum(t.posts)})</h2>
  <table class="grid">
    <thead><tr><th>Date</th><th>Post</th><th class="r">RTs</th><th class="r">Likes</th><th class="r">Replies</th><th class="r">Views</th><th class="r">Engagers</th></tr></thead>
    <tbody>${data.posts.map((p) => `
      <tr><td class="nowrap">${fmtDate(p.created_at)}</td>
        <td class="ptext">${esc(p.text)}${p.url ? `<div class="plink"><a href="${esc(p.url)}">${esc(p.url)}</a></div>` : ''}</td>
        <td class="r">${fmtNum(p.retweets)}</td><td class="r">${fmtNum(p.likes)}</td><td class="r">${fmtNum(p.replies)}</td>
        <td class="r">${fmtNum(p.views)}</td><td class="r">${fmtNum(p.engagers.length)}</td></tr>`).join('')}
    </tbody>
  </table>

  <div class="page-break"></div>
  <h2>Appendix B · All engagers (${fmtNum(data.engagers.length)})</h2>
  ${engagerTable(appendixEngagers)}
  ${data.engagers.length > PDF_ENGAGER_ROWS ? `<p class="sub">First ${PDF_ENGAGER_ROWS} shown. The Excel download has all ${fmtNum(data.engagers.length)}.</p>` : ''}
</body></html>`;
};

const renderReportPdf = async (data, meta = {}) => {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    // Offline content only (no remote images), so there is nothing to wait on.
    await page.setContent(buildReportHtml(data, meta), { waitUntil: 'load', timeout: 60000 });
    await page.evaluate('document.fonts && document.fonts.ready');
    const footer = `<div style="font-size:7.5px;width:100%;padding:0 14mm;color:#94a3b8;font-family:Arial,sans-serif;display:flex;justify-content:space-between;">
      <span>T-SCAN · Engager Analysis · @${esc(data.account.handle)} · CONFIDENTIAL</span>
      <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: footer,
      margin: { top: '14mm', bottom: '16mm', left: '14mm', right: '14mm' },
    });
    // Puppeteer returns a Uint8Array; Express would send that as JSON, not bytes.
    return Buffer.from(pdf);
  } finally {
    await page.close().catch(() => {});
  }
};

const styleHeader = (sheet) => {
  const row = sheet.getRow(1);
  row.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F2B4C' } };
  row.alignment = { vertical: 'middle' };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  if (sheet.columnCount) sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columnCount } };
};

const buildReportWorkbook = async (data, { generatedBy, generatedAt = new Date() } = {}) => {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'T-SCAN';
  wb.created = generatedAt;
  const t = data.totals;

  const summary = wb.addWorksheet('Summary');
  summary.columns = [{ header: 'Item', key: 'k', width: 38 }, { header: 'Value', key: 'v', width: 48 }];
  [
    ['Account', `@${data.account.handle}`],
    ['Display name', data.account.display_name],
    ['Profile', data.account.url],
    ['Report period', `${fmtDate(data.range.from)} – ${fmtDate(data.range.to)}`],
    ['Analysis run', fmtDateTime(data.analysis.analyzed_at)],
    ['Analysis covers', `${fmtDate(data.analysis.coverage?.start)} – ${fmtDate(data.analysis.coverage?.end)}`],
    ['Generated', fmtDateTime(generatedAt)],
    ['Generated by', generatedBy || ''],
    ['Marking', 'CONFIDENTIAL'],
    [],
    ['Posts in period', t.posts],
    ['Posts with retweeter data', t.posts_with_retweeter_data],
    ['Unique engagers (retweeters)', t.unique_engagers],
    ['Retweets by engagers found', t.retweet_events],
    ['Verified engagers', t.verified_engagers],
    ['Super-active engagers', data.summary['super-active']],
    ['Regular engagers', data.summary.regular],
    ['Occasional engagers', data.summary.occasional],
    ['One-time engagers', data.summary['one-time']],
    ['Total retweets (X count)', t.retweets],
    ['Total likes', t.likes],
    ['Total replies', t.replies],
    ['Total views', t.views],
  ].forEach(([k, v]) => summary.addRow({ k, v }));
  styleHeader(summary);
  summary.autoFilter = undefined;

  const eng = wb.addWorksheet('Engagers');
  eng.columns = [
    { header: 'Rank', key: 'rank', width: 7 },
    { header: 'Handle', key: 'handle', width: 22 },
    { header: 'Name', key: 'name', width: 28 },
    { header: 'Verified', key: 'verified', width: 9 },
    { header: 'Posts retweeted', key: 'n', width: 15 },
    { header: 'Share of posts with retweeter data', key: 'share', width: 18 },
    { header: 'Tier', key: 'tier', width: 13 },
    { header: 'First engaged', key: 'first', width: 14 },
    { header: 'Last engaged', key: 'last', width: 14 },
    { header: 'Profile', key: 'url', width: 34 },
  ];
  data.engagers.forEach((e, i) => eng.addRow({
    rank: i + 1, handle: `@${e.handle}`, name: e.name, verified: e.verified ? 'Yes' : 'No',
    n: e.posts_retweeted, share: Number(e.share.toFixed(4)), tier: TIER_LABEL[e.frequency],
    first: fmtDate(e.first_engaged), last: fmtDate(e.last_engaged), url: `https://x.com/${e.handle}`,
  }));
  eng.getColumn('share').numFmt = '0%';
  styleHeader(eng);

  const posts = wb.addWorksheet('Posts');
  posts.columns = [
    { header: 'Date (IST)', key: 'date', width: 20 },
    { header: 'Post', key: 'text', width: 70 },
    { header: 'Link', key: 'url', width: 34 },
    { header: 'Retweets', key: 'rt', width: 10 },
    { header: 'Likes', key: 'likes', width: 10 },
    { header: 'Replies', key: 'replies', width: 10 },
    { header: 'Quotes', key: 'quotes', width: 10 },
    { header: 'Views', key: 'views', width: 12 },
    { header: 'Engagers found', key: 'eng', width: 10 },
    { header: 'Top engagers', key: 'top', width: 40 },
  ];
  data.posts.forEach((p) => posts.addRow({
    date: fmtDateTime(p.created_at), text: p.text, url: p.url, rt: p.retweets, likes: p.likes,
    replies: p.replies, quotes: p.quotes, views: p.views, eng: p.engagers.length,
    top: p.top_engagers.map((h) => `@${h}`).join(', '),
  }));
  posts.getColumn('text').alignment = { wrapText: true, vertical: 'top' };
  styleHeader(posts);

  const links = wb.addWorksheet('Post engagers');
  links.columns = [
    { header: 'Post date (IST)', key: 'date', width: 20 },
    { header: 'Post link', key: 'url', width: 34 },
    { header: 'Engager', key: 'handle', width: 22 },
    { header: 'Engager tier', key: 'tier', width: 13 },
  ];
  const tierOf = new Map(data.engagers.map((e) => [e.handle, e.frequency]));
  data.posts.forEach((p) => p.engagers.forEach((h) => links.addRow({
    date: fmtDateTime(p.created_at), url: p.url, handle: `@${h}`, tier: TIER_LABEL[tierOf.get(h)] || '',
  })));
  styleHeader(links);

  return wb.xlsx.writeBuffer();
};

module.exports = { buildReportHtml, renderReportPdf, buildReportWorkbook };
