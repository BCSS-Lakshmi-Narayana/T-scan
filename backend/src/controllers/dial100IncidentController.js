const Dial100Incident = require('../models/Dial100Incident');
const { createAuditLog } = require('../services/auditService');
const { withTenant } = require('../utils/tenantFilter');

const getDayRange = (dateStr) => {
  const date = new Date(dateStr);
  const start = new Date(date.setHours(0, 0, 0, 0));
  const end = new Date(date.setHours(23, 59, 59, 999));
  return { start, end };
};

// @desc    Get incidents by date or date range
// @route   GET /api/dial100-incidents?date=YYYY-MM-DD or ?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
// @access  Private
const getIncidentsByDate = async (req, res) => {
  try {
    const { date, startDate, endDate } = req.query;
    let start;
    let end;

    if (startDate || endDate) {
      if (!startDate || !endDate) {
        return res.status(400).json({ message: 'startDate and endDate are required for range queries' });
      }
      start = new Date(startDate);
      end = new Date(endDate);
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        return res.status(400).json({ message: 'Invalid startDate or endDate' });
      }
      start.setHours(0, 0, 0, 0);
      end.setHours(23, 59, 59, 999);
    } else if (date) {
      ({ start, end } = getDayRange(date));
    } else {
      return res.status(400).json({ message: 'date or startDate/endDate query parameters are required' });
    }

    const incidents = await Dial100Incident.find(withTenant(req, {
      date: { $gte: start, $lte: end }
    })).sort({ category: 1, slNo: 1 });

    res.status(200).json({
      date: date || null,
      startDate: startDate || null,
      endDate: endDate || null,
      total: incidents.length,
      incidents
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Save incidents for a date (bulk replace)
// @route   POST /api/dial100-incidents/bulk
// @access  Private
const saveIncidentsBulk = async (req, res) => {
  try {
    const { date, incidents } = req.body;

    if (!date || !Array.isArray(incidents)) {
      return res.status(400).json({ message: 'date and incidents are required' });
    }

    const { start, end } = getDayRange(date);

    await Dial100Incident.deleteMany(withTenant(req, {
      date: { $gte: start, $lte: end }
    }));

    const incidentDate = new Date(date);
    incidentDate.setHours(12, 0, 0, 0);

    const createdBy = req.user?.email || req.user?.id || 'system';

    const prepared = incidents.map((incident, index) => ({
      id: incident.id || undefined,
      tenant_id: req.tenantId,
      date: incidentDate,
      category: incident.category,
      slNo: incident.slNo || index + 1,
      incidentDetails: incident.incidentDetails || '',
      incidentCategory: incident.incidentCategory || '',
      location: incident.location || '',
      callerName: incident.callerName || '',
      dateTime: incident.dateTime ? new Date(incident.dateTime) : undefined,
      psJurisdiction: incident.psJurisdiction || '',
      zoneJurisdiction: incident.zoneJurisdiction || '',
      psTypeOfVehicle: incident.psTypeOfVehicle || '',
      pcBc: incident.pcBc || '',
      callerNumber: incident.callerNumber || incident.phNo || '',
      assignedTime: incident.assignedTime ? new Date(incident.assignedTime) : undefined,
      receivedTime: incident.receivedTime ? new Date(incident.receivedTime) : undefined,
      acceptedTime: incident.acceptedTime ? new Date(incident.acceptedTime) : undefined,
      responseTimeForAcceptingCall: Number(incident.responseTimeForAcceptingCall || 0),
      reachedTime: incident.reachedTime ? new Date(incident.reachedTime) : undefined,
      responseTimeForAcceptanceToVehicleReachedMins: Number(incident.responseTimeForAcceptanceToVehicleReachedMins || 0),
      responseTimeForAssignedToVehicleReached: Number(incident.responseTimeForAssignedToVehicleReached || 0),
      pcRemarks: incident.pcRemarks || '',
      shoRemarks: incident.shoRemarks || '',
      remarks: incident.remarks || '',
      mediaFiles: Array.isArray(incident.mediaFiles) ? incident.mediaFiles : [],
      status: incident.status || 'Pending',
      priority: incident.priority || 'Normal',
      assignedTo: incident.assignedTo || '',
      createdBy
    }));

    const created = prepared.length > 0 ? await Dial100Incident.insertMany(prepared) : [];

    await createAuditLog(req.user, 'save', 'dial100_incidents', date, {
      count: created.length
    });

    res.status(201).json({
      message: `Saved ${created.length} incidents for ${date}`,
      count: created.length
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const parseDateField = (value) => {
  if (value === undefined || value === null || value === '') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date;
};

const normalizePublicIncident = (incident) => {
  if (!incident || typeof incident !== 'object') return incident;
  const normalized = { ...incident };
  normalized.date = parseDateField(normalized.date);
  normalized.dateTime = parseDateField(normalized.dateTime);
  normalized.createdAt = parseDateField(normalized.createdAt) || new Date();
  normalized.updatedAt = parseDateField(normalized.updatedAt) || new Date();
  normalized.createdBy = normalized.createdBy || 'public-api';
  return normalized;
};

const incidentPayloadFromBody = (body) => {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  if (Array.isArray(body.incidents)) return body.incidents;
  return [body];
};

// @desc    Get all Dial100 incidents without authentication
// @route   GET /api/dial100-incidents/public
// @access  Public
const getPublicIncidents = async (req, res) => {
  try {
    // Tenant-scoped: this route is JWT-protected, so req.tenantId is set.
    const incidents = await Dial100Incident.find(withTenant(req)).sort({ date: -1 }).lean();

    res.status(200).json({
      total: incidents.length,
      incidents
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Store Dial100 incident(s) directly in DB without authentication
// @route   POST /api/dial100-incidents/public
// @access  Public
const savePublicIncidents = async (req, res) => {
  try {
    const rawPayload = incidentPayloadFromBody(req.body);

    if (rawPayload.length === 0) {
      return res.status(400).json({ message: 'Incident payload is required' });
    }

    const prepared = rawPayload.map(normalizePublicIncident);
    // Stamp every incident with the caller's tenant so it stays tenant-isolated.
    prepared.forEach((p) => { p.tenant_id = req.tenantId; });
    const operations = prepared.map((incident) => {
      if (incident.id) {
        return {
          updateOne: {
            filter: { tenant_id: req.tenantId, id: incident.id },
            update: { $set: incident },
            upsert: true
          }
        };
      }
      return { insertOne: { document: incident } };
    });

    const result = await Dial100Incident.bulkWrite(operations, { ordered: false });

    const upsertedCount = result.upsertedCount || 0;
    const modifiedCount = result.modifiedCount || 0;
    const insertedCount = result.insertedCount || 0;
    const totalSaved = upsertedCount + modifiedCount + insertedCount;

    res.status(201).json({
      message: `Stored ${totalSaved} Dial100 incident(s)`,
      count: totalSaved,
      result
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getIncidentsByDate,
  saveIncidentsBulk,
  getPublicIncidents,
  savePublicIncidents
};
