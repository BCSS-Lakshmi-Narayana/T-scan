const GrievanceWorkflowReport = require('../models/GrievanceWorkflowReport');
const CriticismContact = require('../models/CriticismContact'); // reuse same contacts
const Grievance = require('../models/Grievance');
const { generateGrievanceWorkflowCode } = require('../services/grievanceWorkflowCodeService');
const { archiveContentMedia } = require('../services/contentS3Service');
const ExcelJS = require('exceljs');
const { withTenant } = require('../utils/tenantFilter');
const { logHistory } = require('../services/historyLogService');
const { scopedGrievanceIdsForDistrict, scopedDistrictQuery } = require('../utils/scopedDistricts');

/* ─── Helpers ─── */
const getUser = (req) => ({
  user_id: req.user?.id,
  email: req.user?.email,
  name: req.user?.full_name || req.user?.name || req.user?.email
});

// GrievanceWorkflowReport has no `districts` of its own — it's scoped via the
// linked Grievance's district. Fetch the report by id, then verify the linked
// grievance falls within the officer's assigned district(s) before allowing any
// action on it; returns null if the report doesn't exist or is out of scope.
const findScopedReport = async (req, id) => {
  const report = await GrievanceWorkflowReport.findOne(withTenant(req, { id }));
  if (!report) return null;
  const linkedGrievance = await Grievance.findOne(withTenant(req, { id: report.grievance_id, ...scopedDistrictQuery(req) })).select('id').lean();
  if (!linkedGrievance) return null;
  return report;
};

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

const buildStatusFilter = (rawStatus) => {
  const normalized = String(rawStatus || '').trim().toUpperCase();

  // Use regex for case-insensitive + whitespace-flexible matching
  if (normalized === 'PENDING') {
    // Correctly matches explicit "PENDING" case-insensitive AND null/missing status values
    // by explicitly matching rather than excluding everything else which pulls in query/suggestion
    return { status: { $regex: /^\s*pending\s*$/i } };
  }
  if (normalized === 'ESCALATED') {
    return { status: { $regex: /^\s*(escalated|escaled)\s*$/i } };
  }
  if (normalized === 'CLOSED') {
    return { status: { $regex: /^\s*closed\s*$/i } };
  }

  // Fallback for unknown status
  return { status: normalized };
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
/*              GRIEVANCE WORKFLOW REPORT – CREATE (Proceed)        */
/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const createReport = async (req, res) => {
  try {
    const {
      grievance_id, remarks, message, platform,
      profile_id, profile_link, post_link, post_date,
      post_description, posted_by, engagement,
      media_urls, media_items, media_s3_urls,
      complaint_phone, category
    } = req.body;

    if (!grievance_id) return res.status(400).json({ error: 'grievance_id is required' });

    const grievanceDoc = await Grievance.findOne(withTenant(req, { id: grievance_id, ...scopedDistrictQuery(req) }));
    if (!grievanceDoc) return res.status(404).json({ error: 'Grievance not found' });

    // Re-use existing report for same grievance
    const existing = await GrievanceWorkflowReport.findOne(withTenant(req, { grievance_id }));
    const unique_code = existing?.unique_code || await generateGrievanceWorkflowCode(platform || grievanceDoc.platform || 'x');

    // Collect & archive media
    const payloadMedia = dedupeMediaItems(Array.isArray(media_items) ? media_items : []);
    const grievanceMedia = extractMediaFromGrievance(grievanceDoc);
    const mediaToArchive = dedupeMediaItems([
      ...payloadMedia,
      ...grievanceMedia,
      ...(Array.isArray(media_urls) ? media_urls.map((url) => ({
        type: /\.(mp4|webm|mov|mkv|avi|m3u8)(\?|$)/i.test(String(url || '')) ? 'video' : 'photo', url
      })) : [])
    ]);

    let archivedMedia = [];
    try {
      archivedMedia = mediaToArchive.length > 0
        ? await archiveContentMedia(mediaToArchive, grievanceDoc.tweet_id || grievance_id, {
          folder: 'grievance-workflow-content',
          useUniqueFileName: true,
          replaceOriginalUrls: false,
          postUrl: post_link || grievanceDoc.tweet_url,
          tenantId: req.tenantId
        })
        : [];
    } catch (e) { console.error('Media archive warning:', e.message); }

    const finalOriginalUrls = Array.from(new Set(
      [...dedupeMediaItems(mediaToArchive).map(i => i.video_url || i.url),
      ...dedupeMediaItems(archivedMedia).map(i => i.video_url || i.url)].filter(Boolean)
    ));
    const finalS3Urls = Array.from(new Set([
      ...((Array.isArray(media_s3_urls) ? media_s3_urls : []).filter(Boolean)),
      ...((Array.isArray(archivedMedia) ? archivedMedia : [])
        .flatMap(i => [i?.s3_url, i?.s3_preview]).filter(Boolean))
    ]));

    const payload = {
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
      complaint_phone: complaint_phone || grievanceDoc.complainant_phone || '',
      category: category || 'Others',
      media_urls: finalOriginalUrls,
      media_s3_urls: finalS3Urls,
      remarks: remarks || '',
      message: message || '',
      status: existing?.status || 'PENDING',
      created_by: existing?.created_by || getUser(req)
    };

    let report;
    let created = false;
    if (existing) {
      // preserve status_history
      payload.status_history = existing.status_history || [];
      report = await GrievanceWorkflowReport.findOneAndUpdate(
        withTenant(req, { grievance_id }), { $set: payload }, { new: true }
      );
    } else {
      payload.status_history = [{
        from_status: null,
        to_status: 'PENDING',
        changed_by: getUser(req),
        note: 'Report created',
        timestamp: new Date()
      }];
      report = await GrievanceWorkflowReport.create({ ...payload, tenant_id: req.tenantId });
      created = true;
    }

    // Sync back to grievance
    const existingWorkflow = grievanceDoc.grievance_workflow || {};
    const existingInformedTo = (
      existingWorkflow.informed_to && typeof existingWorkflow.informed_to === 'object'
    )
      ? {
        name: existingWorkflow.informed_to.name || '',
        phone: existingWorkflow.informed_to.phone || '',
        department: existingWorkflow.informed_to.department || ''
      }
      : { name: '', phone: '', department: '' };

    grievanceDoc.grievance_workflow = {
      report_id: report.id,
      unique_code: report.unique_code,
      status: report.status,
      category: report.category,
      shared_at: existingWorkflow.shared_at || null,
      informed_to: existingInformedTo
    };
    grievanceDoc.markModified('grievance_workflow');
    await grievanceDoc.save();

    logHistory(req, { module: 'grievances', action: created ? 'create' : 'update', recordId: report.id, recordLabel: report.unique_code, state: grievanceDoc.state, districts: grievanceDoc.districts, changes: { grievance_id, category, status: report.status } });

    res.status(created ? 201 : 200).json(report);
  } catch (error) {
    console.error('Error creating grievance workflow report:', error);
    res.status(500).json({ error: 'Failed to create report' });
  }
};

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
/*             SHARE (WhatsApp) → records contact info             */
/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const shareReport = async (req, res) => {
  try {
    const { id } = req.params;
    const { contact_name, contact_phone, contact_department, set_status, shared_message } = req.body;

    const report = await findScopedReport(req, id);
    if (!report) return res.status(404).json({ error: 'Report not found' });

    const prevStatus = report.status;
    if (prevStatus === 'CLOSED') {
      return res.status(400).json({ error: 'Closed report cannot be shared' });
    }

    report.informed_to = { name: contact_name || '', phone: contact_phone || '', department: contact_department || '' };
    report.shared_at = new Date();
    report.action_taken_at = new Date();
    report.shared_via = 'whatsapp';

    // If caller explicitly requests ESCALATED (from status change popup), set it
    // Otherwise keep current status (PENDING for initial share from G popup)
    const targetStatus = set_status === 'ESCALATED' ? 'ESCALATED' : prevStatus;
    report.status = targetStatus;
    if (targetStatus === 'ESCALATED') report.escalated_at = new Date();
    if (targetStatus === 'ESCALATED') {
      report.escalation_message = String(shared_message || '').trim();
    }

    report.status_history.push({
      from_status: prevStatus,
      to_status: targetStatus,
      changed_by: getUser(req),
      note: targetStatus === 'ESCALATED'
        ? `Escalated via WhatsApp to ${contact_name || contact_phone}`
        : `Shared via WhatsApp to ${contact_name || contact_phone}`,
      timestamp: new Date()
    });

    await report.save();

    const linkedGrievance = await Grievance.findOneAndUpdate(
      withTenant(req, { id: report.grievance_id }),
      {
        $set: {
          'grievance_workflow.status': report.status,
          'grievance_workflow.shared_at': report.shared_at,
          'grievance_workflow.informed_to': report.informed_to
        }
      }
    );

    logHistory(req, { module: 'grievances', action: 'update', recordId: report.id, recordLabel: report.unique_code, state: linkedGrievance?.state, districts: linkedGrievance?.districts, changes: { status: report.status, informed_to: report.informed_to } });

    res.json(report);
  } catch (error) {
    console.error('Error sharing grievance workflow report:', error);
    res.status(500).json({ error: 'Failed to share report' });
  }
};

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
/*                   CLOSE REPORT                                   */
/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const closeReport = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      closing_remarks, operator_reply, final_reply_to_user, final_communication,
      fir_status, fir_number, closing_media_urls, closing_media_s3_urls
    } = req.body;

    const report = await findScopedReport(req, id);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    if (report.status === 'CLOSED') return res.status(400).json({ error: 'Report already closed' });

    const prevStatus = report.status;

    const normalizeUrlList = (arr) => Array.from(new Set((Array.isArray(arr) ? arr : [])
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .filter(Boolean)));

    const closingOriginalUrls = normalizeUrlList(closing_media_urls);
    const providedClosingS3Urls = normalizeUrlList(closing_media_s3_urls);

    // Archive external closing media URLs to S3 (if any)
    let archivedClosingS3Urls = [];
    if (Array.isArray(closing_media_urls) && closing_media_urls.length > 0) {
      try {
        const closingMediaItems = closing_media_urls.map(url => ({
          type: /\.(mp4|webm|mov)(\?|$)/i.test(url) ? 'video' : 'photo', url
        }));
        const archived = await archiveContentMedia(closingMediaItems, report.grievance_id, {
          folder: 'grievance-workflow-closing',
          useUniqueFileName: true,
          tenantId: req.tenantId
        });
        archivedClosingS3Urls = archived.flatMap(i => [i?.s3_url, i?.s3_preview]).filter(Boolean);
      } catch (e) { console.error('Closing media archive warning:', e.message); }
    }

    const finalClosingS3Urls = Array.from(new Set([
      ...providedClosingS3Urls,
      ...archivedClosingS3Urls
    ].filter(Boolean)));

    report.status = 'CLOSED';
    report.closed_at = new Date();
    report.closing_remarks = closing_remarks || '';
    report.operator_reply = operator_reply || report.operator_reply || '';
    report.final_reply_to_user = final_reply_to_user || report.final_reply_to_user || '';
    report.final_communication = final_communication || '';
    const normalizedFirStatus = String(fir_status || '').trim();
    const normalizedFirNumber = String(fir_number || '').trim();

    if (normalizedFirStatus === 'Yes' || normalizedFirStatus === 'No') {
      report.fir_status = normalizedFirStatus;
      report.fir_number = normalizedFirStatus === 'Yes' ? normalizedFirNumber : '';
    } else if (/^yes\s*[-:]\s*/i.test(normalizedFirStatus)) {
      report.fir_status = 'Yes';
      report.fir_number = normalizedFirNumber || normalizedFirStatus.replace(/^yes\s*[-:]\s*/i, '').trim();
    } else if (normalizedFirStatus) {
      report.fir_status = 'Yes';
      report.fir_number = normalizedFirNumber || normalizedFirStatus;
    } else {
      report.fir_status = '';
      report.fir_number = '';
    }
    report.closing_media_urls = closingOriginalUrls;
    report.closing_media_s3_urls = finalClosingS3Urls;
    report.status_history.push({
      from_status: prevStatus,
      to_status: 'CLOSED',
      changed_by: getUser(req),
      note: closing_remarks || 'Closed',
      timestamp: new Date()
    });

    await report.save();

    // Sync status to parent Grievance document
    const grievanceUpdate = { 'grievance_workflow.status': 'CLOSED' };
    if (report.fir_status === 'Yes') {
      grievanceUpdate.workflow_status = 'converted_to_fir';
      grievanceUpdate.fir_status = 'Yes';
      grievanceUpdate.fir_number = report.fir_number || '';
      grievanceUpdate.fir_converted_at = new Date();
    }
    const linkedGrievance = await Grievance.findOneAndUpdate(
      withTenant(req, { id: report.grievance_id }),
      { $set: grievanceUpdate }
    );

    logHistory(req, { module: 'grievances', action: 'update', recordId: report.id, recordLabel: report.unique_code, state: linkedGrievance?.state, districts: linkedGrievance?.districts, changes: { status: 'CLOSED', fir_status: report.fir_status } });

    res.json(report);
  } catch (error) {
    console.error('Error closing grievance workflow report:', error);
    res.status(500).json({ error: 'Failed to close report' });
  }
};

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
/*                 UPDATE STATUS (dropdown)                        */
/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const updateReportStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const allowed = ['PENDING', 'ESCALATED', 'CLOSED'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const report = await findScopedReport(req, id);
    if (!report) return res.status(404).json({ error: 'Report not found' });

    const prevStatus = report.status || 'PENDING';
    if (prevStatus === status) return res.json(report);

    report.status = status;
    if (status === 'CLOSED') report.closed_at = new Date();
    if (status === 'ESCALATED') report.escalated_at = new Date();

    report.status_history.push({
      from_status: prevStatus,
      to_status: status,
      changed_by: getUser(req),
      note: `Status changed from ${prevStatus} to ${status} from grievance card dropdown`,
      timestamp: new Date()
    });

    await report.save();

    const linkedGrievance = await Grievance.findOneAndUpdate(
      withTenant(req, { id: report.grievance_id }),
      { $set: { 'grievance_workflow.status': status } }
    );

    logHistory(req, { module: 'grievances', action: 'update', recordId: report.id, recordLabel: report.unique_code, state: linkedGrievance?.state, districts: linkedGrievance?.districts, changes: { status } });

    res.json(report);
  } catch (error) {
    console.error('Error updating grievance workflow status:', error);
    res.status(500).json({ error: 'Failed to update status' });
  }
};

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
/*                       LIST / GET                                 */
/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const getReports = async (req, res) => {
  try {
    const { page = 1, limit = 50, platform, from, to, status, search, sort = 'created_at', order = 'desc', category, district } = req.query;
    const query = withTenant(req);
    const normalizedStatus = String(status || '').trim().toUpperCase();

    const scopedGrievanceIds = await scopedGrievanceIdsForDistrict(req, Grievance, district, withTenant);
    if (scopedGrievanceIds) query.grievance_id = { $in: scopedGrievanceIds };

    if (platform && platform !== 'all') query.platform = platform;
    if (category && category !== 'all') query.category = category;
    if (normalizedStatus && normalizedStatus !== 'ALL') {
      if (normalizedStatus === 'FIR') {
        query.fir_status = { $nin: ['', 'No', null] };
      } else {
        Object.assign(query, buildStatusFilter(normalizedStatus));
      }
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

    // Search across multiple fields
    if (search && String(search).trim()) {
      const escaped = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const searchRegex = new RegExp(escaped, 'i');
      query.$or = [
        { unique_code: searchRegex },
        { profile_id: searchRegex },
        { post_description: searchRegex },
        { complaint_phone: searchRegex },
        { remarks: searchRegex },
        { category: searchRegex },
        { 'posted_by.display_name': searchRegex },
        { 'posted_by.handle': searchRegex },
        { 'informed_to.name': searchRegex }
      ];
    }

    // Build sort object
    const sortDir = order === 'asc' ? 1 : -1;
    const sortObj = { [sort]: sortDir };

    const total = await GrievanceWorkflowReport.countDocuments(query);
    const reports = await GrievanceWorkflowReport.find(query)
      .sort(sortObj)
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit))
      .lean();

    // Populate grievance context for X thread display
    const grievanceIds = reports.map(r => r.grievance_id).filter(Boolean);
    if (grievanceIds.length > 0) {
      const grievances = await Grievance.find(withTenant(req, { id: { $in: grievanceIds } }))
        .select('id context content posted_by post_date')
        .lean();
      const gMap = new Map(grievances.map(g => [g.id, g]));
      for (const report of reports) {
        const g = gMap.get(report.grievance_id);
        if (g) {
          report.grievance_context = g.context || {};
          report.grievance_content = g.content || {};
          report.grievance_posted_by = g.posted_by || {};
          report.grievance_post_date = g.post_date;
        }
      }
    }

    console.log('[getReports] Found', reports.length, 'reports. First report status:', reports[0]?.status);

    const statsQuery = withTenant(req);
    if (scopedGrievanceIds) statsQuery.grievance_id = { $in: scopedGrievanceIds };
    if (platform && platform !== 'all') statsQuery.platform = platform;
    if (category && category !== 'all') statsQuery.category = category;
    if (from || to) {
      statsQuery.post_date = {};
      if (from) statsQuery.post_date.$gte = new Date(from);
      if (to) {
        const toDateObj = new Date(to);
        toDateObj.setHours(23, 59, 59, 999);
        statsQuery.post_date.$lte = toDateObj;
      }
    }
    // Note: search term is not typically applied to high-level stats cards unless we specifically want it to shrink.
    // However, the user asked to "select any category it should have to show how many are there in that category and outoff all",
    // and the filters to perfectly match the table records. We will include search just in case.
    if (search && String(search).trim()) {
      const escaped = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const searchRegex = new RegExp(escaped, 'i');
      statsQuery.$or = [
        { unique_code: searchRegex },
        { profile_id: searchRegex },
        { post_description: searchRegex },
        { complaint_phone: searchRegex },
        { remarks: searchRegex },
        { category: searchRegex },
        { 'posted_by.display_name': searchRegex },
        { 'posted_by.handle': searchRegex },
        { 'informed_to.name': searchRegex }
      ];
    }

    // Build a matching query for the Grievance collection to get total received
    // (district-scoped — this feeds the "Total" stat badge, which must match the
    // same district isolation as the reports list itself, not the whole tenant).
    const grievanceTotalQuery = withTenant(req, scopedDistrictQuery(req));
    if (platform && platform !== 'all') grievanceTotalQuery.platform = platform;
    if (from || to) {
      grievanceTotalQuery.post_date = {};
      if (from) grievanceTotalQuery.post_date.$gte = new Date(from);
      if (to) {
        const toObj = new Date(to);
        toObj.setHours(23, 59, 59, 999);
        grievanceTotalQuery.post_date.$lte = toObj;
      }
    }

    const [statsTotal, pending, escalated, closed, fir] = await Promise.all([
      Grievance.countDocuments(grievanceTotalQuery),          // total = all grievances received
      GrievanceWorkflowReport.countDocuments({ ...statsQuery, ...buildStatusFilter('PENDING') }),
      GrievanceWorkflowReport.countDocuments({ ...statsQuery, ...buildStatusFilter('ESCALATED') }),
      GrievanceWorkflowReport.countDocuments({ ...statsQuery, ...buildStatusFilter('CLOSED') }),
      GrievanceWorkflowReport.countDocuments({ ...statsQuery, fir_status: { $nin: ['', 'No', null] } })
    ]);

    res.json({
      reports,
      pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / Number(limit)) },
      stats: { total: statsTotal, pending, escalated, closed, fir }
    });
  } catch (error) {
    console.error('Error fetching grievance workflow reports:', error);
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
};

const getReport = async (req, res) => {
  try {
    const report = await GrievanceWorkflowReport.findOne(withTenant(req, { id: req.params.id })).lean();
    if (!report) return res.status(404).json({ error: 'Report not found' });

    // District scoping: GrievanceWorkflowReport has no `districts` of its own —
    // it's scoped via the linked Grievance's district.
    const scopedLink = await Grievance.findOne(withTenant(req, { id: report.grievance_id, ...scopedDistrictQuery(req) })).select('id').lean();
    if (!scopedLink) return res.status(404).json({ error: 'Report not found' });

    // Populate the original grievance context (thread / in_reply_to / quoted) for X thread display
    if (report.grievance_id) {
      try {
        const grievance = await Grievance.findOne(withTenant(req, { id: report.grievance_id }))
          .select('context content posted_by post_date platform')
          .lean();
        if (grievance) {
          report.grievance_context = grievance.context || {};
          report.grievance_content = grievance.content || {};
          report.grievance_posted_by = grievance.posted_by || {};
          report.grievance_post_date = grievance.post_date;
        }
      } catch (e) {
        console.error('[getReport] Failed to fetch linked grievance context:', e.message);
      }
    }

    res.json(report);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch report' });
  }
};

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
/*                    EXCEL EXPORT                                  */
/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const exportReports = async (req, res) => {
  try {
    const { platform, from, to, status, district } = req.query;
    const query = withTenant(req);
    // District scoping: officers only export their own district(s)' workflow reports.
    const scopedGrievanceIds = await scopedGrievanceIdsForDistrict(req, Grievance, district, withTenant);
    if (scopedGrievanceIds) query.grievance_id = { $in: scopedGrievanceIds };
    const normalizedStatus = String(status || '').trim().toUpperCase();
    if (platform && platform !== 'all') query.platform = platform;
    if (normalizedStatus && normalizedStatus !== 'ALL') {
      if (normalizedStatus === 'FIR') {
        query.fir_status = { $nin: ['', 'No', null] };
      } else {
        Object.assign(query, buildStatusFilter(normalizedStatus));
      }
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

    const reports = await GrievanceWorkflowReport.find(query).sort({ created_at: -1 }).lean();

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'BCSS BluraSaga';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Grievance Workflow Reports');
    sheet.columns = [
      { header: 'SI.NO', key: 'sno', width: 8 },
      { header: 'Post Date & Time', key: 'post_date', width: 22 },
      { header: 'Mobile Number', key: 'complaint_phone', width: 18 },
      { header: 'Profile ID', key: 'profile', width: 30 },
      { header: 'Post Link', key: 'post_link', width: 40 },
      { header: 'Post Description', key: 'post_description', width: 50 },
      { header: 'Media URLs', key: 'media', width: 40 },
      { header: 'Category', key: 'category', width: 18 },
      { header: 'Operator Remarks to Officer', key: 'remarks', width: 40 },
      { header: 'Sent To', key: 'sent_to', width: 28 },
      { header: 'Date & Time (Action)', key: 'action_date', width: 22 },
      { header: 'Status', key: 'status', width: 14 },
      { header: 'Operator Reply to User', key: 'operator_reply', width: 40 },
      { header: 'Final Reply to User', key: 'final_reply', width: 40 },
      { header: 'Closing Remarks', key: 'closing_remarks', width: 38 },
      { header: 'Closing Attachment URLs', key: 'closing_media', width: 55 },
      { header: 'Final Communication to User', key: 'final_comm', width: 40 },
      { header: 'FIR', key: 'fir', width: 18 },
      { header: 'Complainant Conversation', key: 'complainant_conv', width: 60 },
      { header: 'Officer Feedback', key: 'officer_conv', width: 60 },
      { header: 'Unique ID', key: 'unique_code', width: 22 }
    ];

    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };

    const fmtDate = (d) => {
      if (!d) return '';
      try { return new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }); } catch { return ''; }
    };

    reports.forEach((r, i) => {
      const mediaUrls = (Array.isArray(r.media_s3_urls) && r.media_s3_urls.length > 0 ? r.media_s3_urls : (r.media_urls || []));
      const closingMediaUrls = (Array.isArray(r.closing_media_s3_urls) && r.closing_media_s3_urls.length > 0
        ? r.closing_media_s3_urls
        : (r.closing_media_urls || []));

      sheet.addRow({
        sno: i + 1,
        post_date: fmtDate(r.post_date),
        complaint_phone: r.complaint_phone || '',
        profile: r.profile_link || r.profile_id || '',
        post_link: r.post_link || '',
        post_description: r.post_description || '',
        media: mediaUrls.join('\n'),
        category: r.category || '',
        remarks: r.remarks || '',
        sent_to: r.informed_to ? `${r.informed_to.name || ''} (${r.informed_to.phone || ''})` : '',
        action_date: fmtDate(r.action_taken_at || r.escalated_at),
        status: r.status || 'PENDING',
        operator_reply: r.operator_reply || '',
        final_reply: r.final_reply_to_user || '',
        closing_remarks: r.closing_remarks || '',
        closing_media: closingMediaUrls.join('\n'),
        final_comm: r.final_communication || '',
        fir: r.fir_status || '',
        complainant_conv: (r.complainant_logs || []).map(log =>
          `[${fmtDate(log.timestamp)} - ${log.mode} - ${log.type}] ${log.content}`
        ).join('\n---\n'),
        officer_conv: (r.officer_logs || []).map(log =>
          `[${fmtDate(log.timestamp)} - ${log.mode}] ${log.content}`
        ).join('\n---\n'),
        unique_code: r.unique_code || ''
      });
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=grievance_workflow_${Date.now()}.xlsx`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Error exporting grievance workflow reports:', error);
    res.status(500).json({ error: 'Failed to export reports' });
  }
};

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
/*           CONTACTS (reuse criticism contacts)                    */
/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const getContacts = async (req, res) => {
  try {
    const contacts = await CriticismContact.find(withTenant(req, { is_active: true })).sort({ name: 1 }).lean();
    res.json(contacts);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
};

const updateReport = async (req, res) => {
  try {
    const { id } = req.params;
    const { complainant_logs, officer_logs } = req.body;

    const report = await findScopedReport(req, id);
    if (!report) return res.status(404).json({ error: 'Report not found' });

    if (complainant_logs) report.complainant_logs = complainant_logs;
    if (officer_logs) report.officer_logs = officer_logs;

    await report.save();

    const linkedGrievance = await Grievance.findOne(withTenant(req, { id: report.grievance_id }), 'state districts').lean();

    logHistory(req, { module: 'grievances', action: 'update', recordId: report.id, recordLabel: report.unique_code, state: linkedGrievance?.state, districts: linkedGrievance?.districts, changes: { complainant_logs: !!complainant_logs, officer_logs: !!officer_logs } });

    res.json(report);
  } catch (error) {
    console.error('Error updating grievance report details:', error);
    res.status(500).json({ error: 'Failed to update report details' });
  }
};

/* ─────────────────────────────────────────────────────────────────
   ADD COMMUNICATION LOG  –  POST /reports/:id/communication-log
   Appends a single complainant log entry to an existing report.
───────────────────────────────────────────────────────────────── */
const addCommunicationLog = async (req, res) => {
  try {
    const { id } = req.params;
    const { content, mode } = req.body;

    if (!content || !String(content).trim()) {
      return res.status(400).json({ error: 'Message content is required' });
    }

    const report = await findScopedReport(req, id);
    if (!report) return res.status(404).json({ error: 'Report not found' });

    const logEntry = {
      type: 'Operator',
      mode: mode || 'X POST',
      content: String(content).trim(),
      operator: {
        user_id: req.user?._id?.toString() || req.user?.id || '',
        email: req.user?.email || '',
        name: req.user?.full_name || req.user?.name || 'Operator'
      },
      timestamp: new Date(),
      locked: false
    };

    report.complainant_logs.push(logEntry);
    await report.save();

    res.json({ success: true, log: logEntry });
  } catch (error) {
    console.error('Error adding communication log:', error);
    res.status(500).json({ error: 'Failed to add communication log' });
  }
};

/* ─────────────────────────────────────────────────────────────────
   PDF GENERATION  –  POST /reports/:id/generate-pdf
   Uses Puppeteer to render an HTML snapshot of the report,
   uploads the PDF to S3, and saves the URL on the record.
───────────────────────────────────────────────────────────────── */
const generateReportPdf = async (req, res) => {
  try {
    const mongoose = require('mongoose');
    const { id } = req.params;
    const query = mongoose.Types.ObjectId.isValid(id)
      ? { $or: [{ _id: id }, { id }, { unique_code: id }] }
      : { $or: [{ id }, { unique_code: id }] };

    const report = await GrievanceWorkflowReport.findOne(withTenant(req, query)).lean();

    if (!report) return res.status(404).json({ error: 'Report not found' });

    // GrievanceWorkflowReport has no `districts` of its own — it's scoped via
    // the linked Grievance's district, same check as findScopedReport().
    const linkedGrievanceInScope = await Grievance.findOne(withTenant(req, { id: report.grievance_id, ...scopedDistrictQuery(req) })).select('id').lean();
    if (!linkedGrievanceInScope) return res.status(404).json({ error: 'Report not found' });

    // ── Fetch linked grievance context for thread display ──
    if (report.grievance_id) {
      try {
        const grievance = await Grievance.findOne(withTenant(req, { id: report.grievance_id }))
          .select('context content posted_by post_date platform')
          .lean();
        if (grievance) {
          report.grievance_context = grievance.context || {};
          report.grievance_content = grievance.content || {};
          report.grievance_posted_by = grievance.posted_by || {};
          report.grievance_post_date = grievance.post_date;
        }
      } catch (e) {
        console.error('[generateReportPdf] Failed to fetch grievance context:', e.message);
      }
    }

    // ── Prepare final PDF URL up front so QR in generated PDF can point to this file ──
    // On-prem, tenant-isolated storage. Absolute url from the request so the QR is
    // scannable and the subdomain resolves to this tenant's /files folder.
    const path = require('path');
    const fs = require('fs');
    const STORAGE_DIR = process.env.FILE_STORAGE_DIR || path.join(__dirname, '..', '..', 'storage');
    const safeTenant = (t) => (String(t || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'unknown');
    const key = `grievance-reports/${report.unique_code || report.id}-${Date.now()}.pdf`;
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
    const finalPdfUrl = `${proto}://${req.get('host')}/files/${key.split('/').map(encodeURIComponent).join('/')}`;

    // ── Build self-contained HTML for the report ──
    const html = buildReportHtml(
      { ...report, report_pdf_url: report.report_pdf_url || finalPdfUrl },
      { pdfUrl: finalPdfUrl }
    );

    // ── Render with Puppeteer ──
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
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
    await GrievanceWorkflowReport.updateOne(
      withTenant(req, { _id: report._id }),
      { $set: { report_pdf_url: finalPdfUrl, report_pdf_generated_at: new Date() } }
    );

    return res.json({ pdf_url: finalPdfUrl });
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

const buildQrImageUrl = (value, size = 120) => {
  if (!value) return '';
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&margin=0&format=png&data=${encodeURIComponent(value)}`;
};

const buildReportHtml = (r, options = {}) => {
  const allLogs = [
    ...(r.complainant_logs || []).map(l => ({ ...l, _src: 'complainant' })),
    ...(r.officer_logs || []).map(l => ({ ...l, _src: 'officer' }))
  ].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const dash = v => v || '—';
  const effectivePdfUrl = options.pdfUrl || r.report_pdf_url || '';
  const postQrImageUrl = buildQrImageUrl(r.post_link, 120);
  const pdfQrImageUrl = buildQrImageUrl(effectivePdfUrl, 120);

  const logRows = allLogs.map(l => {
    let role = 'User', bg = '#fff7ed', border = '#fed7aa', roleColor = '#ea580c';
    const opName = l.operator?.name || 'Operator';
    const recName = l.recipient?.name || r.informed_to?.name || 'Officer';
    const recPhone = l.recipient?.phone || r.informed_to?.phone || '';
    let toFrom = '';
    if (l._src === 'officer' && l.is_escalation) {
      role = 'Escalation'; bg = '#fef2f2'; border = '#fecaca'; roleColor = '#dc2626';
      toFrom = `Operator (${opName}) → Officer (${recName}${recPhone ? ' · ' + recPhone : ''})`;
    } else if (l._src === 'officer') {
      role = 'Operator→Officer'; bg = '#eff6ff'; border = '#bfdbfe'; roleColor = '#2563eb';
      toFrom = `Operator (${opName}) → Officer (${recName}${recPhone ? ' · ' + recPhone : ''})`;
    } else if (l.type === 'OperatorRemark') {
      role = 'Operator Note'; bg = '#fffbeb'; border = '#fde68a'; roleColor = '#d97706';
      toFrom = `Operator (${opName}) — Internal`;
    } else if (l.type === 'Operator') {
      role = 'Operator→User'; bg = '#f0fdf4'; border = '#bbf7d0'; roleColor = '#16a34a';
      toFrom = `Operator (${opName}) → User`;
    } else {
      toFrom = r.posted_by?.display_name || r.profile_id || 'User';
    }
    return `<tr style="background:${bg}">
      <td style="padding:6px 8px;border:1px solid ${border};border-radius:4px;white-space:nowrap;vertical-align:top">
        <span style="color:${roleColor};font-weight:700;font-size:9px;text-transform:uppercase">${role}</span><br/>
        <span style="font-size:9px;color:#64748b">${esc(toFrom)}</span>
      </td>
      <td style="padding:6px 8px;border:1px solid ${border};font-size:9px;color:#475569;white-space:nowrap;vertical-align:top">${esc(l.mode || '—')}</td>
      <td style="padding:6px 8px;border:1px solid ${border};font-size:10px;color:#1e293b;white-space:pre-wrap;vertical-align:top">${esc(l.content)}</td>
      <td style="padding:6px 8px;border:1px solid ${border};font-size:9px;color:#64748b;white-space:nowrap;vertical-align:top">${fmtDateHtml(l.timestamp)}</td>
    </tr>`;
  }).join('<tr><td colspan="4" style="padding:2px"></td></tr>');

  const statusColor = r.status === 'CLOSED' ? '#16a34a' : r.status === 'ESCALATED' ? '#ea580c' : '#ca8a04';
  const statusBg = r.status === 'CLOSED' ? '#f0fdf4' : r.status === 'ESCALATED' ? '#fff7ed' : '#fefce8';

  const officerLogs = (r.officer_logs || []);
  const firstOfficerLog = officerLogs[0];
  const escalationLog = officerLogs.find(l => l.is_escalation);

  const cd = r.closing_details || {};
  const firConverted = cd.fir_converted || r.fir_status || '';
  const firNumber = cd.fir_number || r.fir_number || '';
  const firStation = cd.fir_station || '';
  const firDistrict = cd.fir_district || '';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<style>
  * { box-sizing: border-box; }
  body { font-family: Arial, sans-serif; color: #1e293b; margin: 0; padding: 0; font-size: 11px; }
  .header { background: #1e293b; color: white; padding: 14px 20px; display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
  .meta-bar { background: #f8fafc; border-bottom: 2px solid #e2e8f0; padding: 8px 20px; display: flex; gap: 20px; flex-wrap: wrap; }
  .meta-item label { display:block; font-size:8px; font-weight:700; text-transform:uppercase; color:#94a3b8; letter-spacing:0.08em; }
  .meta-item span { font-size:11px; font-weight:600; color:#1e293b; }
  .section { margin: 12px 20px; }
  .section-title { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; color:#64748b; border-bottom:2px solid #e2e8f0; padding-bottom:4px; margin-bottom:8px; }
  .kv-table td { padding: 3px 0; font-size:10px; vertical-align:top; }
  .kv-table td:first-child { width:140px; color:#64748b; font-weight:600; padding-right:12px; }
  .box { border-radius:6px; padding:10px 14px; font-size:11px; line-height:1.6; white-space:pre-wrap; }
  .log-table { width:100%; border-collapse:separate; border-spacing:0 4px; }
  .log-table th { background:#f1f5f9; font-size:8px; font-weight:700; text-transform:uppercase; color:#64748b; padding:5px 8px; text-align:left; }
  .two-col { display:flex; gap:16px; }
  .two-col > div { flex:1; }
  .metrics-qr-row { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; }
  .metrics-table-wrap { flex:1; }
  .post-qr-side { min-width:92px; text-align:center; }
  .qr-stack { display:flex; justify-content:flex-end; margin-top:8px; }
  .qr-box { background:#fff; border:1px solid #cbd5e1; padding:4px; width:92px; border-radius:4px; text-align:center; }
  .qr-box img { width:82px; height:82px; display:block; margin:0 auto; }
  .qr-label { font-size:7px; color:#64748b; margin-top:3px; line-height:1.2; font-weight:600; text-transform:uppercase; letter-spacing:0.04em; }
  .qr-placeholder { width:82px; height:82px; display:flex; align-items:center; justify-content:center; border:1px dashed #cbd5e1; color:#94a3b8; font-size:7px; line-height:1.2; }
  .tag { display:inline-block; padding:1px 6px; border-radius:9999px; font-size:9px; font-weight:700; }
  /* Timeline */
  .timeline-section { margin: 12px 20px; border: 1.5px solid #e2e8f0; border-radius: 10px; overflow: hidden; }
  .timeline-header { padding: 10px 16px; background: #f8fafc; border-bottom: 1.5px solid #e2e8f0; display: flex; align-items: center; gap: 8px; }
  .timeline-header-icon { width: 28px; height: 28px; border-radius: 6px; background: rgba(219,234,254,0.5); display: flex; align-items: center; justify-content: center; }
  .timeline-body { padding: 20px 24px; }
  .tl-step { display: flex; position: relative; }
  .tl-step.inactive { opacity: 0.4; }
  .tl-date { width: 90px; padding-top: 2px; padding-right: 12px; text-align: right; flex-shrink: 0; }
  .tl-date-day { font-size: 10px; font-weight: 700; color: #0f172a; }
  .tl-date-time { font-size: 9px; color: #94a3b8; font-weight: 500; }
  .tl-center { width: 32px; display: flex; flex-direction: column; align-items: center; flex-shrink: 0; }
  .tl-dot { width: 28px; height: 28px; border-radius: 50%; border: 2px solid #e2e8f0; background: #f8fafc; display: flex; align-items: center; justify-content: center; z-index: 1; font-size: 12px; }
  .tl-dot.active { background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .tl-line { width: 2px; flex-grow: 1; margin: 3px 0; border-radius: 2px; background: #f1f5f9; }
  .tl-content { flex: 1; margin-left: 12px; padding-bottom: 24px; }
  .tl-content-last { padding-bottom: 0; }
  .tl-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; color: #0f172a; }
  .tl-label.inactive { color: #94a3b8; }
  .tl-duration { display: inline-block; font-size: 9px; font-weight: 700; color: #64748b; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; padding: 1px 6px; margin-left: 6px; vertical-align: middle; }
  .tl-card { margin-top: 6px; padding: 8px 12px; border-radius: 10px; border: 1px solid #e2e8f0; background: #fff; }
  .tl-card.inactive { background: #fafafa; border-color: #f1f5f9; }
  .tl-officer { font-size: 10px; font-weight: 600; color: #334155; margin-bottom: 4px; }
  .tl-note { font-size: 10px; color: #64748b; font-style: italic; }
  /* Tweet thread */
  .thread-section { margin: 12px 20px; border: 1.5px solid #e2e8f0; border-radius: 10px; overflow: hidden; }
  .thread-header { padding: 8px 16px; background: #f8fafc; border-bottom: 1px solid #f1f5f9; display: flex; align-items: center; gap: 8px; }
  .thread-body { padding: 16px; }
  .thread-tweet { display: flex; gap: 12px; position: relative; }
  .thread-avatar { width: 36px; height: 36px; border-radius: 50%; object-fit: cover; border: 2px solid #fff; box-shadow: 0 1px 2px rgba(0,0,0,0.08); flex-shrink: 0; background: #e2e8f0; }
  .thread-avatar-placeholder { width: 36px; height: 36px; border-radius: 50%; background: #e2e8f0; display: flex; align-items: center; justify-content: center; color: #94a3b8; font-size: 14px; flex-shrink: 0; }
  .thread-connector { position: absolute; left: 17px; top: 40px; bottom: 0; width: 2px; background: #e2e8f0; }
  .thread-content { flex: 1; min-width: 0; padding-bottom: 16px; }
  .thread-name { font-size: 12px; font-weight: 700; color: #0f172a; }
  .thread-handle { font-size: 10px; color: #94a3b8; margin-left: 4px; }
  .thread-label { font-size: 9px; padding: 1px 6px; border-radius: 9999px; background: #f1f5f9; color: #64748b; font-weight: 500; margin-left: 6px; }
  .thread-date { font-size: 9px; color: #94a3b8; margin-top: 2px; }
  .thread-text { font-size: 11px; color: #334155; margin-top: 6px; white-space: pre-wrap; line-height: 1.6; }
  .thread-link { font-size: 9px; color: #3b82f6; text-decoration: none; margin-top: 4px; display: inline-block; }
</style>
</head>
<body>

<!-- HEADER -->
<div class="header">
  <div>
    <div style="font-size:15px;font-weight:800;letter-spacing:0.02em">Grievance Report</div>
    <div style="font-size:9px;opacity:0.55;margin-top:3px">Generated: ${fmtDateHtml(new Date())}</div>
  </div>
  <div style="text-align:right">
    <div style="font-size:18px;font-weight:900;font-family:monospace;color:#fbbf24">${esc(r.unique_code || '—')}</div>
    <div style="font-size:8px;opacity:0.5;margin-top:2px">UNIQUE REPORT ID</div>
    <div style="margin-top:4px;display:inline-block;padding:2px 8px;border-radius:4px;font-size:9px;font-weight:700;background:${statusBg};color:${statusColor}">${r.status || 'PENDING'}</div>
    <div class="qr-stack">
      ${pdfQrImageUrl ? `
      <div class="qr-box">
        <img src="${esc(pdfQrImageUrl)}" alt="PDF QR"/>
        <div class="qr-label">PDF QR</div>
      </div>` : `
      <div class="qr-box">
        <div class="qr-placeholder">Generate PDF to enable QR</div>
        <div class="qr-label">PDF QR</div>
      </div>`}
    </div>
  </div>
</div>

<!-- META BAR -->
<div class="meta-bar">
  <div class="meta-item"><label>Category</label><span>${esc(dash(r.category))}</span></div>
  <div class="meta-item"><label>Platform</label><span>${(r.platform || '—').toUpperCase()}</span></div>
  <div class="meta-item"><label>Post Date</label><span>${fmtDateHtml(r.post_date)}</span></div>
  <div class="meta-item"><label>Phone</label><span>${esc(dash(r.complaint_phone))}</span></div>
  <div class="meta-item"><label>Profile</label><span>${esc(r.posted_by?.display_name || r.profile_id || '—')}</span></div>
  <div class="meta-item"><label>Created</label><span>${fmtDateHtml(r.created_at)}</span></div>
</div>

<!-- POST DETAILS -->
<div class="section">
  <div class="section-title">Post Details</div>
  <div class="two-col">
    <div>
      <table class="kv-table">
        <tr><td>Profile Handle</td><td>${esc(dash(r.posted_by?.handle || r.profile_id))}</td></tr>
        <tr><td>Profile Link</td><td>${(() => {
      const link = r.profile_link || (() => {
        const handle = r.posted_by?.handle || r.profile_id || '';
        if (!handle) return '';
        const p = (r.platform || '').toLowerCase();
        if (p === 'twitter' || p === 'x') return `https://x.com/${handle.replace(/^@/, '')}`;
        if (p === 'facebook') return `https://facebook.com/${handle.replace(/^@/, '')}`;
        if (p === 'youtube') return `https://youtube.com/${handle.startsWith('@') ? handle : '@' + handle}`;
        return '';
      })();
      return link ? `<a href="${esc(link)}" style="color:#2563eb;word-break:break-all">${esc(link)}</a>` : '—';
    })()}</td></tr>
        <tr><td>Post Link</td><td><a href="${esc(r.post_link || '')}" style="color:#2563eb;word-break:break-all">${esc(dash(r.post_link))}</a></td></tr>
        <tr><td>Post Date</td><td>${fmtDateHtml(r.post_date)}</td></tr>
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
        ${(postQrImageUrl && r.post_link) ? `
        <div class="post-qr-side">
          <div class="qr-box">
            <img src="${esc(postQrImageUrl)}" alt="Post QR"/>
            <div class="qr-label">POST QR</div>
          </div>
        </div>` : ''}
      </div>
    </div>
  </div>
  ${r.post_description ? `<div class="box" style="background:#f8fafc;border:1px solid #e2e8f0;margin-top:8px">${esc(r.post_description)}</div>` : ''}
</div>


<!-- MEDIA -->
${(() => {
      const mediaUrls = (r.media_s3_urls && r.media_s3_urls.length > 0) ? r.media_s3_urls : (r.media_urls || []);
      const isVideo = (url) => /\.(mp4|webm|mov|mkv|avi|m3u8)(\?|$)/i.test(String(url || ''));

      return mediaUrls.length > 0 ? `
<div class="section">
  <div class="section-title">Post Media (${mediaUrls.length})</div>
  <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px;">
    ${mediaUrls.map((u, i) => `
      <div style="border: 1px solid #e2e8f0; border-radius: 6px; overflow: hidden; background: #f8fafc; min-height: 40px; display: flex; flex-direction: column;">
        ${isVideo(u)
          ? `<div style="padding: 20px 10px; text-align: center; font-size: 9px; color: #2563eb; font-weight: 500; background: #f1f5f9; flex: 1; display: flex; align-items: center; justify-content: center; word-break: break-all;">
               🎬 Video: <a href="${esc(u)}" style="color:#2563eb; text-decoration: underline; margin-left: 4px;">${esc(u)}</a>
             </div>`
          : `<img src="${esc(u)}" style="width: 100%; height: 160px; object-fit: contain; display: block; background: #f1f5f9;" />`
        }
        <div style="padding: 4px 8px; font-size: 8px; color: #64748b; background: white; border-top: 1px solid #e2e8f0; text-align: center; font-weight: 600;">
          <a href="${esc(u)}" style="color:#2563eb; text-decoration: underline;">📎 ${isVideo(u) ? 'Video' : 'Image'} ${i + 1} — Click to view</a>
        </div>
      </div>`).join('')}
  </div>
</div>` : '';
    })()}

<!-- STATUS TIMELINE -->
${(() => {
  const hist = r.status_history || [];
  const createdAt = r.created_at;
  const escalatedAt = r.escalated_at || (hist.find(h => h.to_status === 'ESCALATED' || h.to_status === 'ESCALED') || {}).timestamp;
  const closedAt = r.closed_at || (hist.find(h => h.to_status === 'CLOSED') || {}).timestamp;
  const currentStatus = (r.status || 'PENDING').toUpperCase();
  const escalateHist = hist.find(h => h.to_status === 'ESCALATED' || h.to_status === 'ESCALED');
  const closeHist = hist.find(h => h.to_status === 'CLOSED');
  const isEscalatedStep = currentStatus === 'ESCALATED' || currentStatus === 'ESCALED' || currentStatus === 'CLOSED';
  const isClosedStep = currentStatus === 'CLOSED';

  const calcDur = (from, to) => {
    if (!from) return '';
    const s = new Date(from), e = to ? new Date(to) : new Date();
    const ms = Math.max(0, e - s), mins = Math.floor(ms / 60000), hrs = Math.floor(mins / 60), days = Math.floor(hrs / 24);
    if (days > 0) return days + 'd ' + (hrs % 24) + 'h';
    if (hrs > 0) return hrs + 'h ' + (mins % 60) + 'm';
    return mins + 'm';
  };

  let escalatedNote = (escalateHist || {}).note || (r.informed_to?.name ? 'Escalated to ' + esc(r.informed_to.name) : '');
  if (r.informed_to?.phone && escalatedNote && !escalatedNote.includes(r.informed_to.phone)) {
    escalatedNote += ' (' + esc(r.informed_to.phone) + ')';
  }

  const steps = [
    { label: 'Pending', date: createdAt, active: true, current: currentStatus === 'PENDING', duration: calcDur(createdAt, escalatedAt || closedAt || (currentStatus === 'PENDING' ? null : createdAt)), officer: r.created_by?.name || r.informed_to?.name || '', note: 'Issue created', color: '#eab308', icon: '＋' },
    { label: 'Escalated', date: escalatedAt, active: isEscalatedStep, current: currentStatus === 'ESCALATED' || currentStatus === 'ESCALED', duration: isEscalatedStep ? calcDur(escalatedAt, closedAt || null) : '', officer: (escalateHist || {}).changed_by?.name || r.informed_to?.name || '', note: escalatedNote, color: '#f97316', icon: '⚠' },
    { label: 'Closed', date: closedAt, active: isClosedStep, current: isClosedStep, duration: isClosedStep ? calcDur(createdAt, closedAt) : '', officer: (closeHist || {}).changed_by?.name || '', note: r.closing_remarks || (closeHist || {}).note || 'Resolved', color: '#22c55e', icon: '✓' }
  ];

  const fmtShortDate = (d) => { if (!d) return ''; return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }); };
  const fmtShortTime = (d) => { if (!d) return ''; return new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }); };

  return `
<div class="timeline-section" style="page-break-inside:avoid">
  <div class="timeline-header">
    <div class="timeline-header-icon"><span style="font-size:13px;color:#2563eb">⏱</span></div>
    <div>
      <div style="font-size:12px;font-weight:700;color:#1e293b">Status Timeline</div>
      <div style="font-size:9px;color:#64748b;font-weight:500">Tracking the lifecycle of this grievance</div>
    </div>
  </div>
  <div class="timeline-body">
    ${steps.map((step, idx) => {
      const isLast = idx === steps.length - 1;
      const nextActive = !isLast && steps[idx + 1].active;
      return `
      <div class="tl-step${step.active ? '' : ' inactive'}">
        <div class="tl-date">
          ${step.date ? `<div class="tl-date-day">${fmtShortDate(step.date)}</div><div class="tl-date-time">${fmtShortTime(step.date)}</div>` : '<div style="font-size:9px;color:#cbd5e1;font-style:italic">Pending</div>'}
        </div>
        <div class="tl-center">
          <div class="tl-dot${step.active ? ' active' : ''}" style="${step.active ? 'border-color:' + step.color + ';' : ''}">
            <span style="color:${step.active ? step.color : '#cbd5e1'}">${step.icon}</span>
          </div>
          ${!isLast ? '<div class="tl-line" style="background:' + (nextActive ? step.color : '#f1f5f9') + '"></div>' : ''}
        </div>
        <div class="tl-content${isLast ? ' tl-content-last' : ''}">
          <span class="tl-label${step.active ? '' : ' inactive'}">${esc(step.label)}</span>
          ${(step.active && step.duration) ? '<span class="tl-duration">⏱ ' + esc(step.duration) + '</span>' : ''}
          <div class="tl-card${step.active ? '' : ' inactive'}">
            <div class="tl-officer">👤 ${esc(step.officer || '—')}</div>
            ${(step.note && step.note !== '—') ? '<div class="tl-note">"' + esc(step.note) + '"</div>' : ''}
          </div>
        </div>
      </div>`;
    }).join('')}
  </div>
</div>`;
})()}

<!-- FULL TWEET THREAD -->
${(() => {
  const gCtx = r.grievance_context || {};
  const isXPlatform = (r.platform || '').toLowerCase() === 'x' || (r.platform || '').toLowerCase() === 'twitter';
  const hasCtxContent = (node) => node && (node.tweet_id || node.content?.text || node.content?.full_text || (node.content?.media || []).length);
  const threadParent = hasCtxContent(gCtx.thread_parent) ? gCtx.thread_parent : null;
  const inReplyTo = hasCtxContent(gCtx.in_reply_to) ? gCtx.in_reply_to : null;
  const quotedCtx = hasCtxContent(gCtx.quoted) ? gCtx.quoted : null;
  const repostedFrom = hasCtxContent(gCtx.reposted_from) ? gCtx.reposted_from : null;
  const hasThread = isXPlatform && (threadParent || inReplyTo || quotedCtx || repostedFrom);

  if (!hasThread) return '';

  const renderTweet = (node, label, showConnector) => {
    const user = node.posted_by || {};
    const handle = (user.handle || '').replace('@', '');
    const text = node.content?.full_text || node.content?.text || '';
    const avatarUrl = user.profile_image_url || '';
    return `
    <div class="thread-tweet">
      ${showConnector ? '<div class="thread-connector"></div>' : ''}
      ${avatarUrl ? '<img src="' + esc(avatarUrl) + '" class="thread-avatar" referrerpolicy="no-referrer" />' : '<div class="thread-avatar-placeholder">👤</div>'}
      <div class="thread-content">
        <div>
          <span class="thread-name">${esc(user.display_name || handle || 'Unknown')}</span>
          ${handle ? '<span class="thread-handle">@' + esc(handle) + '</span>' : ''}
          <span class="thread-label">${esc(label)}</span>
        </div>
        ${node.post_date ? '<div class="thread-date">' + fmtDateHtml(node.post_date) + '</div>' : ''}
        ${text ? '<div class="thread-text">' + esc(text) + '</div>' : ''}
        ${node.tweet_url ? '<a href="' + esc(node.tweet_url) + '" class="thread-link">View on X →</a>' : ''}
      </div>
    </div>`;
  };

  const threadNodes = [
    threadParent && { node: threadParent, label: 'Thread Start' },
    repostedFrom && { node: repostedFrom, label: 'Reposted From' },
    inReplyTo && (!threadParent || threadParent?.tweet_id !== inReplyTo?.tweet_id) && { node: inReplyTo, label: 'Original Post' },
  ].filter(Boolean);

  const mainNode = { posted_by: r.posted_by || r.grievance_posted_by, content: r.grievance_content || { text: r.post_description }, post_date: r.post_date, tweet_url: r.post_link };

  return `
<div class="thread-section" style="page-break-inside:avoid">
  <div class="thread-header">
    <span style="font-size:12px">↩</span>
    <span style="font-size:10px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:0.06em">Full Tweet Thread</span>
  </div>
  <div class="thread-body">
    ${threadNodes.map(item => renderTweet(item.node, item.label, true)).join('')}
    ${renderTweet(mainNode, threadNodes.length > 0 ? 'Reply' : 'Post', !!quotedCtx)}
    ${quotedCtx ? renderTweet(quotedCtx, 'Quoted', false) : ''}
  </div>
</div>`;
})()}

<!-- ESCALATION -->
${escalationLog ? `
<div class="section">
  <div class="section-title">Escalation Details</div>
  <div class="box" style="background:#fef2f2;border:1px solid #fecaca">
    <table class="kv-table">
      <tr><td>Escalated At</td><td>${fmtDateHtml(escalationLog.timestamp)}</td></tr>
      ${escalationLog.recipient?.name ? `<tr><td>Escalated To</td><td style="font-weight:700">${esc(escalationLog.recipient.name)}${escalationLog.recipient?.phone ? ' · ' + esc(escalationLog.recipient.phone) : ''}</td></tr>` : ''}
      ${escalationLog.content ? `<tr><td>Remarks</td><td>${esc(escalationLog.content)}</td></tr>` : ''}
    </table>
  </div>
</div>` : ''}

<!-- COMMUNICATION LOG -->
${allLogs.length > 0 ? `
<div class="section">
  <div class="section-title">Communication Log (${allLogs.length} entries)</div>
  <table class="log-table">
    <thead><tr><th>Comments By</th><th>Mode Of Communication</th><th>Message</th><th>Time</th></tr></thead>
    <tbody>${logRows}</tbody>
  </table>
</div>` : ''}

<!-- CLOSING -->
${(r.closing_remarks || r.final_reply_to_user || r.status === 'CLOSED') ? `
<div class="section">
  <div class="section-title">Closing Details</div>
  ${r.closing_remarks ? `
  <div style="margin-bottom:8px">
    <div style="font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase;margin-bottom:4px">Closing Remarks</div>
    <div class="box" style="background:#f0fdf4;border:1px solid #bbf7d0">${esc(r.closing_remarks)}</div>
  </div>` : ''}
  ${r.final_reply_to_user ? `
  <div>
    <div style="font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase;margin-bottom:4px">Final Reply to User</div>
    <div class="box" style="background:#f0fdf4;border:1px solid #bbf7d0">${esc(r.final_reply_to_user)}</div>
  </div>` : ''}
</div>` : ''}

<!-- FIR -->
${(firConverted === 'Yes' || firNumber) ? `
<div class="section">
  <div class="section-title">FIR Details</div>
  <div class="box" style="background:#fef2f2;border:1px solid #fecaca">
    <table class="kv-table">
      <tr><td>FIR Number</td><td style="font-weight:700;color:#dc2626;font-size:13px">${esc(firNumber || '—')}</td></tr>
      ${firStation ? `<tr><td>Police Station</td><td>${esc(firStation)}</td></tr>` : ''}
      ${firDistrict ? `<tr><td>District</td><td>${esc(firDistrict)}</td></tr>` : ''}
    </table>
  </div>
</div>` : ''}

<!-- FOOTER -->
<div style="margin:20px 20px 0;padding:8px 0;border-top:1px solid #e2e8f0;display:flex;justify-content:space-between;font-size:8px;color:#94a3b8">
  <span>Grievance Report · ${esc(r.unique_code || '')}</span>
  <span>Generated ${fmtDateHtml(new Date())}</span>
</div>

</body>
</html>`;
};

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
/*            DASHBOARD STATS (lightweight, by-platform)           */
/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
const getDashboardStats = async (req, res) => {
  try {
    // District scoping: GrievanceWorkflowReport has no `districts` of its own —
    // scope via the officer's visible grievance ids. `dScope` is null for admins
    // (no extra filter) or an object adding grievance_id: { $in } for officers.
    const scopedGrievanceIds = await scopedGrievanceIdsForDistrict(req, Grievance, req.query.district, withTenant);
    const dScope = scopedGrievanceIds ? { grievance_id: { $in: scopedGrievanceIds } } : {};

    // Count ALL GrievanceWorkflowReport documents (the "G flow" reports) per platform,
    // plus per-status breakdowns using case-insensitive regex to match buildStatusFilter logic.
    const [totalRows, pendingRows, escalatedRows, closedRows] = await Promise.all([
      GrievanceWorkflowReport.aggregate([
        { $match: withTenant(req, { ...dScope }) },
        { $group: { _id: '$platform', count: { $sum: 1 } } }
      ]),
      GrievanceWorkflowReport.aggregate([
        { $match: withTenant(req, { ...dScope, status: { $regex: /^\s*pending\s*$/i } }) },
        { $group: { _id: '$platform', count: { $sum: 1 } } }
      ]),
      GrievanceWorkflowReport.aggregate([
        { $match: withTenant(req, { ...dScope, status: { $regex: /^\s*(escalated|escaled)\s*$/i } }) },
        { $group: { _id: '$platform', count: { $sum: 1 } } }
      ]),
      GrievanceWorkflowReport.aggregate([
        { $match: withTenant(req, { ...dScope, status: { $regex: /^\s*closed\s*$/i } }) },
        { $group: { _id: '$platform', count: { $sum: 1 } } }
      ])
    ]);

    const byPlatform = {
      all: { total: 0, pending: 0, escalated: 0, closed: 0 },
      x: { total: 0, pending: 0, escalated: 0, closed: 0 },
      facebook: { total: 0, pending: 0, escalated: 0, closed: 0 },
      whatsapp: { total: 0, pending: 0, escalated: 0, closed: 0 }
    };

    const applyRows = (rows, field) => {
      rows.forEach((r) => {
        const p = r._id || 'x';
        if (!byPlatform[p]) byPlatform[p] = { total: 0, pending: 0, escalated: 0, closed: 0 };
        byPlatform[p][field] += r.count || 0;
        byPlatform.all[field] += r.count || 0;
      });
    };

    applyRows(totalRows, 'total');
    applyRows(pendingRows, 'pending');
    applyRows(escalatedRows, 'escalated');
    applyRows(closedRows, 'closed');

    res.json({ byPlatform });
  } catch (error) {
    console.error('Error fetching grievance workflow dashboard stats:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
};

module.exports = {
  createReport,
  shareReport,
  closeReport,
  updateReportStatus,
  updateReport,
  getReports,
  getReport,
  exportReports,
  getContacts,
  generateReportPdf,
  getDashboardStats,
  addCommunicationLog
};
