const SuggestionReport = require('../models/SuggestionReport');
const CriticismContact = require('../models/CriticismContact');
const Grievance = require('../models/Grievance');
const { generateSuggestionCode } = require('../services/suggestionCodeService');
const { archiveContentMedia } = require('../services/contentS3Service');
const ExcelJS = require('exceljs');
const { withTenant } = require('../utils/tenantFilter');
const { scopedGrievanceIdsForDistrict, scopedDistrictQuery } = require('../utils/scopedDistricts');

// Report has no `districts` of its own — scoped via its linked Grievance.
const reportGrievanceInScope = async (req, report, GrievanceModel) => {
  if (!report) return false;
  const linked = await GrievanceModel.findOne(withTenant(req, { id: report.grievance_id, ...scopedDistrictQuery(req) })).select('id').lean();
  return !!linked;
};

/* ─── Helpers ─── */
const getUser = (req) => ({
  user_id: req.user?.id,
  email: req.user?.email,
  name: req.user?.full_name || req.user?.name || req.user?.email
});

const dedupeMediaItems = (items = []) => {
  const map = new Map();
  for (const item of items) {
    const url = item?.video_url || item?.url || item?.preview || item?.preview_url;
    if (!url) continue;
    if (!map.has(url)) {
      map.set(url, {
        type: item?.type || 'photo',
        url: item?.url || item?.video_url || url,
        video_url: item?.video_url || null,
        preview: item?.preview || item?.preview_url || null,
        preview_url: item?.preview_url || item?.preview || null
      });
    }
  }
  return Array.from(map.values());
};

const extractMediaFromGrievance = (grievance) => {
  const lists = [
    grievance?.content?.media,
    grievance?.context?.content?.media,
    grievance?.context?.quoted?.content?.media,
    grievance?.context?.in_reply_to?.content?.media,
    grievance?.context?.reposted_from?.content?.media,
    grievance?.context?.parent?.content?.media,
    grievance?.context?.thread_parent?.content?.media
  ];
  return dedupeMediaItems(lists.flatMap((arr) => (Array.isArray(arr) ? arr : [])));
};

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
/*                  SUGGESTION REPORT CRUD                          */
/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

/**
 * POST /api/suggestion/reports
 * Create a new suggestion report from grievance data
 */
const createReport = async (req, res) => {
  try {
    const {
      grievance_id,
      remarks,
      message,
      platform,
      profile_id,
      profile_link,
      post_link,
      post_date,
      post_description,
      posted_by,
      engagement,
      category,
      media_urls,
      media_items,
      media_s3_urls
    } = req.body;

    if (!grievance_id) {
      return res.status(400).json({ error: 'grievance_id is required' });
    }

    const grievanceDoc = await Grievance.findOne(withTenant(req, { id: grievance_id, ...scopedDistrictQuery(req) }));
    if (!grievanceDoc) {
      return res.status(404).json({ error: 'Grievance not found' });
    }

    const existingReport = await SuggestionReport.findOne(withTenant(req, { grievance_id }));
    const unique_code = existingReport?.unique_code || await generateSuggestionCode(platform || grievanceDoc.platform || 'x');

    const payloadMediaItems = Array.isArray(media_items) && media_items.length > 0
      ? dedupeMediaItems(media_items)
      : [];

    const grievanceMediaItems = extractMediaFromGrievance(grievanceDoc);

    const mediaItemsToArchive = dedupeMediaItems([
      ...payloadMediaItems,
      ...grievanceMediaItems,
      ...(Array.isArray(media_urls)
        ? media_urls.map((url) => ({
          type: /\.(mp4|webm|mov|mkv|avi|m3u8)(\?|$)/i.test(String(url || '')) ? 'video' : 'photo',
          url
        }))
        : [])
    ]);

    const archivedMedia = mediaItemsToArchive.length > 0
      ? await archiveContentMedia(
        mediaItemsToArchive,
        grievanceDoc.tweet_id || grievance_id,
        {
          folder: 'suggestion-content',
          useUniqueFileName: true,
          replaceOriginalUrls: false,
          postUrl: post_link || grievanceDoc.tweet_url,
          tenantId: req.tenantId
        }
      )
      : [];

    const finalOriginalMediaUrls = Array.from(new Set([
      ...dedupeMediaItems(mediaItemsToArchive).map((item) => item.video_url || item.url).filter(Boolean),
      ...dedupeMediaItems(archivedMedia).map((item) => item.video_url || item.url).filter(Boolean)
    ]));
    const finalS3MediaUrls = Array.from(new Set([
      ...((Array.isArray(media_s3_urls) ? media_s3_urls : []).filter(Boolean)),
      ...((Array.isArray(archivedMedia) ? archivedMedia : [])
        .flatMap((item) => [item?.s3_url, item?.s3_preview])
        .filter(Boolean))
    ]));

    const reportPayload = {
      grievance_id,
      unique_code,
      platform: platform || grievanceDoc.platform || 'x',
      profile_id: profile_id || grievanceDoc.posted_by?.handle || '',
      profile_link: profile_link || grievanceDoc.posted_by?.profile_url || '',
      post_link: post_link || grievanceDoc.tweet_url || '',
      post_date: post_date || grievanceDoc.post_date || grievanceDoc.created_at || new Date(),
      post_description: post_description || grievanceDoc.content?.full_text || grievanceDoc.content?.text || '',
      posted_by: posted_by || {
        handle: grievanceDoc.posted_by?.handle || '',
        display_name: grievanceDoc.posted_by?.display_name || '',
        profile_image_url: grievanceDoc.posted_by?.profile_image_url || ''
      },
      engagement: engagement || {
        views: grievanceDoc.engagement?.views || 0,
        reposts: grievanceDoc.engagement?.retweets || 0,
        likes: grievanceDoc.engagement?.likes || 0,
        replies: grievanceDoc.engagement?.replies || 0
      },
      category: category || existingReport?.category || 'Others',
      media_urls: finalOriginalMediaUrls,
      media_s3_urls: finalS3MediaUrls,
      remarks: remarks || '',
      message: message || '',
      created_by: existingReport?.created_by || getUser(req)
    };

    let report;
    let created = false;
    if (existingReport) {
      report = await SuggestionReport.findOneAndUpdate(
        withTenant(req, { grievance_id }),
        { $set: reportPayload },
        { new: true }
      );
    } else {
      report = await SuggestionReport.create({ ...reportPayload, tenant_id: req.tenantId });
      created = true;
    }

    // Update the parent grievance
    grievanceDoc.suggestion = {
      ...(grievanceDoc.suggestion || {}),
      report_id: report.id,
      unique_code: report.unique_code,
      remarks: report.remarks,
      category: report.category,
      message: report.message,
      media_s3_urls: report.media_s3_urls || [],
      action_taken_at: report.action_taken_at || null,
      shared_at: report.shared_at || null,
      shared_via: report.shared_via || null,
      informed_to: report.informed_to || {}
    };
    grievanceDoc.markModified('suggestion');
    await grievanceDoc.save();

    res.status(created ? 201 : 200).json(report);
  } catch (error) {
    console.error('Error creating suggestion report:', error);
    res.status(500).json({ error: 'Failed to create suggestion report' });
  }
};

/**
 * PUT /api/suggestion/reports/:id/share
 * Record sharing action
 */
const shareReport = async (req, res) => {
  try {
    const { id } = req.params;
    const { contact_name, contact_phone, contact_department } = req.body;

    const report = await SuggestionReport.findOne(withTenant(req, { id }));
    if (!report || !(await reportGrievanceInScope(req, report, Grievance))) return res.status(404).json({ error: 'Report not found' });

    report.informed_to = {
      name: contact_name || '',
      phone: contact_phone || '',
      department: contact_department || ''
    };
    report.shared_at = new Date();
    report.action_taken_at = new Date();
    report.shared_via = 'whatsapp';

    await report.save();

    await Grievance.findOneAndUpdate(
      withTenant(req, { id: report.grievance_id }),
      {
        $set: {
          'suggestion.action_taken_at': report.action_taken_at,
          'suggestion.shared_at': report.shared_at,
          'suggestion.shared_via': report.shared_via,
          'suggestion.informed_to': report.informed_to
        }
      }
    );

    res.json(report);
  } catch (error) {
    console.error('Error sharing suggestion report:', error);
    res.status(500).json({ error: 'Failed to share report' });
  }
};

/**
 * GET /api/suggestion/reports
 * List all suggestion reports with pagination
 */
const getReports = async (req, res) => {
  try {
    const { page = 1, limit = 50, platform, from, to, unique_code, search, sort, order, category, district } = req.query;
    const query = withTenant(req);

    const scopedGrievanceIds = await scopedGrievanceIdsForDistrict(req, Grievance, district, withTenant);
    if (scopedGrievanceIds) query.grievance_id = { $in: scopedGrievanceIds };

    if (platform && platform !== 'all') query.platform = platform;
    if (category && category !== 'all') query.category = category;
    const searchText = String(search || unique_code || '').trim();
    if (searchText) {
      const escaped = searchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const searchRegex = new RegExp(escaped, 'i');
      query.$or = [
        { unique_code: searchRegex },
        { profile_id: searchRegex },
        { profile_link: searchRegex },
        { post_link: searchRegex },
        { post_description: searchRegex },
        { remarks: searchRegex },
        { message: searchRegex },
        { category: searchRegex },
        { 'posted_by.display_name': searchRegex },
        { 'posted_by.handle': searchRegex },
        { 'informed_to.name': searchRegex },
        { 'informed_to.phone': searchRegex },
        { 'informed_to.department': searchRegex },
        { 'created_by.name': searchRegex },
        { 'created_by.email': searchRegex }
      ];
    }
    if (from || to) {
      query.post_date = {};
      if (from) query.post_date.$gte = new Date(from);
      if (to) {
        const toDateObj = new Date(to);
        toDateObj.setHours(23, 59, 59, 999);
        query.post_date.$lte = toDateObj;
      }
    }

    const sortFieldMap = {
      post_date: 'post_date',
      category: 'category',
      unique_code: 'unique_code',
      unique_id: 'unique_code',
      action_taken: 'action_taken_at',
      action_taken_at: 'action_taken_at',
      created_at: 'created_at'
    };
    const resolvedSortField = sortFieldMap[String(sort || 'created_at')] || 'created_at';
    const resolvedSortOrder = String(order || 'desc').toLowerCase() === 'asc' ? 1 : -1;

    const total = await SuggestionReport.countDocuments(query);
    const reports = await SuggestionReport.find(query)
      .sort({ [resolvedSortField]: resolvedSortOrder, created_at: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit))
      .lean();

    res.json({
      reports,
      pagination: {
        total,
        page: Number(page),
        limit: Number(limit),
        pages: Math.ceil(total / Number(limit))
      }
    });
  } catch (error) {
    console.error('Error fetching suggestion reports:', error);
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
};

/**
 * GET /api/suggestion/reports/:id
 */
const getReport = async (req, res) => {
  try {
    const report = await SuggestionReport.findOne(withTenant(req, { id: req.params.id })).lean();
    if (!report || !(await reportGrievanceInScope(req, report, Grievance))) return res.status(404).json({ error: 'Report not found' });
    res.json(report);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch report' });
  }
};

/**
 * GET /api/suggestion/reports/export
 * Export suggestion reports as Excel
 */
const exportReports = async (req, res) => {
  try {
    const { platform, from, to, unique_code, search, district } = req.query;
    const query = withTenant(req);

    // District scoping: officers only export their own district(s)' reports.
    const scopedGrievanceIds = await scopedGrievanceIdsForDistrict(req, Grievance, district, withTenant);
    if (scopedGrievanceIds) query.grievance_id = { $in: scopedGrievanceIds };

    if (platform && platform !== 'all') query.platform = platform;
    const searchText = String(search || unique_code || '').trim();
    if (searchText) {
      const escaped = searchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const searchRegex = new RegExp(escaped, 'i');
      query.$or = [
        { unique_code: searchRegex },
        { profile_id: searchRegex },
        { profile_link: searchRegex },
        { post_link: searchRegex },
        { post_description: searchRegex },
        { remarks: searchRegex },
        { message: searchRegex },
        { category: searchRegex },
        { 'posted_by.display_name': searchRegex },
        { 'posted_by.handle': searchRegex },
        { 'informed_to.name': searchRegex },
        { 'informed_to.phone': searchRegex },
        { 'informed_to.department': searchRegex },
        { 'created_by.name': searchRegex },
        { 'created_by.email': searchRegex }
      ];
    }
    if (from || to) {
      query.post_date = {};
      if (from) query.post_date.$gte = new Date(from);
      if (to) {
        const toDateObj = new Date(to);
        toDateObj.setHours(23, 59, 59, 999);
        query.post_date.$lte = toDateObj;
      }
    }

    const reports = await SuggestionReport.find(query).sort({ created_at: -1 }).lean();

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'BCSS BluraSaga';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Suggestion Reports');

    sheet.columns = [
      { header: 'SI.NO', key: 'sno', width: 8 },
      { header: 'Post Date & Time', key: 'post_date', width: 22 },
      { header: 'Profile ID / Profile Link', key: 'profile', width: 35 },
      { header: 'Post Link', key: 'post_link', width: 40 },
      { header: 'Post Description', key: 'post_description', width: 50 },
      { header: 'Media URLs', key: 'media', width: 40 },
      { header: 'Category', key: 'category', width: 20 },
      { header: 'Remarks', key: 'remarks', width: 40 },
      { header: 'Unique ID', key: 'unique_code', width: 22 },
      { header: 'Action Taken Date & Time', key: 'action_taken_at', width: 22 },
      { header: 'Informed To', key: 'informed_to', width: 30 }
    ];

    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    sheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF9333EA' } // purple-600
    };

    const formatDate = (d) => {
      if (!d) return '';
      try {
        return new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
      } catch { return ''; }
    };

    reports.forEach((report, index) => {
      sheet.addRow({
        sno: index + 1,
        post_date: formatDate(report.post_date),
        profile: report.profile_link || report.profile_id || '',
        post_link: report.post_link || '',
        post_description: report.post_description || '',
        media: ((Array.isArray(report.media_s3_urls) && report.media_s3_urls.length > 0)
          ? report.media_s3_urls
          : (report.media_urls || [])
        ).join('\n'),
        category: report.category || 'Others',
        remarks: report.remarks || '',
        unique_code: report.unique_code || '',
        action_taken_at: formatDate(report.action_taken_at),
        informed_to: report.informed_to
          ? `${report.informed_to.name || ''}${report.informed_to.phone ? ' (' + report.informed_to.phone + ')' : ''}`
          : ''
      });
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=suggestion_reports_${Date.now()}.xlsx`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Error exporting suggestion reports:', error);
    res.status(500).json({ error: 'Failed to export reports' });
  }
};

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
/*                  CONTACTS (reuse Criticism contacts)              */
/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const getContacts = async (req, res) => {
  try {
    const contacts = await CriticismContact.find(withTenant(req, { is_active: true }))
      .sort({ name: 1 })
      .lean();
    res.json(contacts);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
};

const generateReportPdf = async (req, res) => {
  try {
    const mongoose = require('mongoose');
    const { id } = req.params;
    const query = mongoose.Types.ObjectId.isValid(id)
      ? { $or: [{ _id: id }, { id }, { unique_code: id }] }
      : { $or: [{ id }, { unique_code: id }] };

    const report = await SuggestionReport.findOne(withTenant(req, query)).lean();

    if (!report || !(await reportGrievanceInScope(req, report, Grievance))) return res.status(404).json({ error: 'Report not found' });

    // On-prem, tenant-isolated storage. The PDF embeds a QR of its own URL, so
    // build an ABSOLUTE url from the request (its subdomain resolves to this tenant).
    const path = require('path');
    const fs = require('fs');
    const STORAGE_DIR = process.env.FILE_STORAGE_DIR || path.join(__dirname, '..', '..', 'storage');
    const safeTenant = (t) => (String(t || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'unknown');
    const key = `suggestion-reports/${report.unique_code || report.id}-${Date.now()}.pdf`;
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
    const pdfUrl = `${proto}://${req.get('host')}/files/${key.split('/').map(encodeURIComponent).join('/')}`;

    // ── Build self-contained HTML for the report ──
    const html = buildReportHtml(report, pdfUrl);

    // ── Render with Puppeteer ──
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '15mm', bottom: '15mm', left: '12mm', right: '12mm' }
    });
    await browser.close();

    // ── Write to on-prem disk under the tenant's namespace ──
    const absPath = path.join(STORAGE_DIR, safeTenant(req.tenantId), key);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    await fs.promises.writeFile(absPath, pdfBuffer);

    // ── Save URL to record ──
    await SuggestionReport.updateOne(
      withTenant(req, { _id: report._id }),
      { $set: { report_pdf_url: pdfUrl, report_pdf_generated_at: new Date() } }
    );

    return res.json({ pdf_url: pdfUrl });
  } catch (err) {
    console.error('PDF generation error:', err);
    return res.status(500).json({ error: 'PDF generation failed', detail: err.message });
  }
};

/* ─── HTML template for PDF ─── */
const fmtDateHtml = (d) => {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true
  });
};

const buildReportHtml = (r, generatedPdfUrl) => {
  const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const dash = v => v || '—';
  const clipText = (value, maxLen) => {
    const text = String(value || '').trim();
    if (!text) return '';
    return text.length > maxLen ? `${text.slice(0, maxLen).trim()}...` : text;
  };
  const qrUrl = (value) => value
    ? `https://quickchart.io/qr?size=160&margin=1&text=${encodeURIComponent(String(value))}`
    : '';
  const postQr = qrUrl(r.post_link);
  const pdfQr = qrUrl(generatedPdfUrl || r.report_pdf_url);
  const clippedDescription = clipText(r.post_description, 700);
  const clippedRemarks = clipText(r.remarks, 420);

  // Align with Grievance colors
  const statusColor = '#2563eb'; // blue-600
  const statusBg = '#eff6ff'; // blue-50

  const mediaUrls = (r.media_s3_urls && r.media_s3_urls.length > 0) ? r.media_s3_urls : (r.media_urls || []);

  // Profile Link Fallback
  let finalProfileLink = r.profile_link;
  if (!finalProfileLink && r.platform && r.posted_by?.handle) {
    const handle = r.posted_by.handle.replace(/^@/, '');
    if (r.platform === 'x' || r.platform === 'twitter') finalProfileLink = `https://x.com/${handle}`;
    else if (r.platform === 'facebook') finalProfileLink = `https://facebook.com/${handle}`;
    else if (r.platform === 'youtube') finalProfileLink = `https://youtube.com/@${handle}`;
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<style>
  * { box-sizing: border-box; }
  @page { size: A4; margin: 9mm; }
  body { font-family: Arial, sans-serif; color: #1e293b; margin: 0; padding: 0; font-size: 10px; line-height: 1.32; }
  .header { background: #1e293b; color: #ffffff; padding: 10px 14px 9px; }
  .header-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
  .header-meta { margin-top: 8px; padding-top: 7px; border-top: 1px solid rgba(148, 163, 184, 0.35); display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; }
  .header-meta-item label { display: block; font-size: 7px; font-weight: 700; text-transform: uppercase; color: #94a3b8; letter-spacing: 0.07em; }
  .header-meta-item span { display: block; margin-top: 1px; font-size: 10px; font-weight: 600; color: #e2e8f0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .section { margin: 8px 14px; page-break-inside: avoid; }
  .section-title { font-size: 8.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #64748b; border-bottom: 1px solid #cbd5e1; padding-bottom: 3px; margin-bottom: 6px; }
  .kv-table { width: 100%; border-collapse: collapse; }
  .kv-table td { padding: 2px 0; font-size: 9.5px; vertical-align: top; }
  .kv-table td:first-child { width: 112px; color: #64748b; font-weight: 600; padding-right: 8px; }
  .box { border-radius: 4px; padding: 7px 10px; font-size: 9.6px; line-height: 1.45; white-space: pre-wrap; }
  .two-col { display: flex; gap: 12px; }
  .two-col > div { flex: 1; min-width: 0; }
  .metrics-qr-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
  .metrics-table-wrap { flex: 1; min-width: 0; }
  .post-qr-side { min-width: 70px; text-align: center; }
  .qr-wrap { display: flex; justify-content: flex-end; margin-top: 6px; }
  .qr-block { text-align:center; }
  .qr-card { background: #fff; padding: 3px; border: 1px solid #cbd5e1; border-radius: 4px; width: 64px; height: 64px; display: flex; align-items: center; justify-content: center; }
  .qr-card img { width: 56px; height: 56px; display: block; }
  .qr-label { font-size: 6.5px; opacity: 0.8; margin-top: 2px; letter-spacing: 0.02em; color: #64748b; }
  .note { font-size: 8.5px; color: #475569; }
  a { color: #2563eb; text-decoration: underline; word-break: break-all; }
</style>
</head>
<body>

<!-- HEADER -->
<div class="header">
  <div class="header-top">
    <div>
      <div style="font-size:14px;font-weight:800;letter-spacing:0.02em">Suggestion Report</div>
      <div style="font-size:8px;opacity:0.7;margin-top:2px">Generated: ${fmtDateHtml(new Date())}</div>
    </div>
    <div style="text-align:right">
      <div style="font-size:16px;font-weight:900;font-family:monospace;color:#fbbf24">${esc(r.unique_code || '—')}</div>
      <div style="font-size:7px;opacity:0.7;margin-top:1px">UNIQUE REPORT ID</div>
      <div style="margin-top:3px;display:inline-block;padding:2px 7px;border-radius:4px;font-size:8px;font-weight:700;background:${statusBg};color:${statusColor}">SUGGESTION</div>
      <div class="qr-wrap">
        ${pdfQr ? `
        <div class="qr-block">
          <div class="qr-card"><img src="${esc(pdfQr)}" alt="PDF QR" /></div>
          <div class="qr-label">PDF QR</div>
        </div>` : ''}
      </div>
    </div>
  </div>
  <div class="header-meta">
    <div class="header-meta-item"><label>Category</label><span>${esc(dash(r.category))}</span></div>
    <div class="header-meta-item"><label>Platform</label><span>${(r.platform || '—').toUpperCase()}</span></div>
    <div class="header-meta-item"><label>Post Date</label><span>${fmtDateHtml(r.post_date)}</span></div>
    <div class="header-meta-item"><label>Profile</label><span>${esc(r.posted_by?.display_name || r.profile_id || '—')}</span></div>
    <div class="header-meta-item"><label>Created</label><span>${fmtDateHtml(r.created_at)}</span></div>
  </div>
</div>

<!-- POST SNAPSHOT -->
<div class="section">
  <div class="section-title">Post Snapshot</div>
  <div class="two-col">
    <div>
      <table class="kv-table">
        <tr><td>Profile Handle</td><td>${esc(dash(r.posted_by?.handle || r.profile_id))}</td></tr>
        <tr><td>Profile Link</td><td>${finalProfileLink ? `<a href="${esc(finalProfileLink)}">${esc(finalProfileLink)}</a>` : '—'}</td></tr>
        <tr><td>Post Link</td><td>${r.post_link ? `<a href="${esc(r.post_link)}">${esc(r.post_link)}</a>` : '—'}</td></tr>
      </table>
    </div>
    <div>
      <div class="metrics-qr-row">
        <div class="metrics-table-wrap">
          <table class="kv-table">
            <tr><td>Views</td><td>${dash(r.engagement?.views)}</td></tr>
            <tr><td>Likes</td><td>${dash(r.engagement?.likes)}</td></tr>
            <tr><td>Reposts</td><td>${dash(r.engagement?.reposts)}</td></tr>
            <tr><td>Replies</td><td>${dash(r.engagement?.replies)}</td></tr>
          </table>
        </div>
        ${postQr ? `
        <div class="post-qr-side">
          <div class="qr-card"><img src="${esc(postQr)}" alt="Post QR" /></div>
          <div class="qr-label">POST QR</div>
        </div>` : ''}
      </div>
    </div>
  </div>
  ${clippedDescription ? `<div class="box" style="background:#f8fafc;border:1px solid #e2e8f0;margin-top:6px">${esc(clippedDescription)}</div>` : ''}
</div>

${mediaUrls.length > 0 ? `
<div class="section">
  <div class="section-title">Media</div>
  <div class="note">Attached media items: ${mediaUrls.length}. Open Post Link to view full media.</div>
</div>` : ''}

<!-- REMARKS -->
<div class="section">
  <div class="section-title">Operator Remarks</div>
  <div class="box" style="background:#f8fafc;border:1px solid #e2e8f0">${esc(dash(clippedRemarks))}</div>
</div>

${r.informed_to?.name ? `
<div class="section">
  <div class="section-title">Informed To</div>
  <div class="box" style="background:#eff6ff;border:1px solid #bfdbfe">
    <table class="kv-table">
      <tr><td>Name</td><td>${esc(r.informed_to.name)}</td></tr>
      ${r.informed_to.phone ? `<tr><td>Phone</td><td>${esc(r.informed_to.phone)}</td></tr>` : ''}
      ${r.informed_to.department ? `<tr><td>Department</td><td>${esc(r.informed_to.department)}</td></tr>` : ''}
      ${r.action_taken_at ? `<tr><td>Action Taken At</td><td>${fmtDateHtml(r.action_taken_at)}</td></tr>` : ''}
    </table>
  </div>
</div>` : ''}

<!-- FOOTER -->
<div style="margin:10px 14px 0;padding:6px 0;border-top:1px solid #e2e8f0;display:flex;justify-content:space-between;font-size:7px;color:#94a3b8">
  <span>Suggestion Report · ${esc(r.unique_code || '')}</span>
  <span>Generated ${fmtDateHtml(new Date())}</span>
</div>

</body>
</html>`;
};

module.exports = {
  createReport,
  shareReport,
  getReports,
  getReport,
  exportReports,
  getContacts,
  generateReportPdf
};
