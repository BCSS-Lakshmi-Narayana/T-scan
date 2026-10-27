const MasterCalendarEvent = require('../models/MasterCalendarEvent');
const { withTenant } = require('../utils/tenantFilter');
const { validateScopedDistricts, scopedDistrictQuery, districtErrorMessage } = require('../utils/scopedDistricts');
const { logHistory } = require('../services/historyLogService');

// ── Seed data: recurring HCP events ───────────────────────
const RECURRING_SEED = [
  { slNo: 1,  occasion: 'All India Industrial Exhibition',                          date: '1 January',    monitoringRange: '30 Dec – 15 Feb',  keywords: 'Industrial Exhibition, Numaish, Nampally',                remarks: '' },
  { slNo: 2,  occasion: 'Vaikunta Ekadashi',                                       date: '10 January',   monitoringRange: '9 Jan – 11 Jan',   keywords: 'Vaikunta Ekadashi, temple, Vishnu',                       remarks: 'Date varies each year' },
  { slNo: 3,  occasion: 'Bhogi',                                                   date: '13 January',   monitoringRange: '12 Jan – 14 Jan',  keywords: 'Bhogi, bonfire, Sankranthi',                              remarks: '' },
  { slNo: 4,  occasion: 'Sankranthi/Pongal Festival',                              date: '14 January',   monitoringRange: '13 Jan – 16 Jan',  keywords: 'Sankranthi, Pongal, Makar Sankranti',                    remarks: '' },
  { slNo: 5,  occasion: 'Republic Day Celebration',                                date: '26 January',   monitoringRange: '24 Jan – 28 Jan',  keywords: 'Republic Day, 26 January, parade, national flag',        remarks: 'High priority' },
  { slNo: 6,  occasion: 'Observance of Shab-e-Meraj (Jagne ki Raath)',             date: '27 January',   monitoringRange: '26 Jan – 28 Jan',  keywords: 'Shab-e-Meraj, Jagne ki Raath, Islamic',                  remarks: 'Date varies each year' },
  { slNo: 7,  occasion: 'Mahathma Gandhi Vardanti',                                date: '30 January',   monitoringRange: '29 Jan – 31 Jan',  keywords: 'Mahatma Gandhi, Vardanti, martyrdom',                    remarks: '' },
  { slNo: 8,  occasion: 'Observance of Shab-e-Barath (Jagne ki Raath)',            date: '14 February',  monitoringRange: '13 Feb – 15 Feb',  keywords: 'Shab-e-Barath, Jagne ki Raath, Islamic',                 remarks: 'Date varies each year' },
  { slNo: 9,  occasion: 'Chatrapathi Shivaji Maharaj Jayanthi (Procession)',       date: '19 February',  monitoringRange: '18 Feb – 20 Feb',  keywords: 'Shivaji Jayanthi, procession, Maratha',                  remarks: '' },
  { slNo: 10, occasion: 'TG Legislative Budget Sessions',                          date: '20 February',  monitoringRange: '18 Feb – 30 Mar',  keywords: 'TG Legislature, Budget Session, Telangana Assembly',     remarks: '' },
  { slNo: 11, occasion: 'Observance of Maha Shivaratri',                           date: '26 February',  monitoringRange: '25 Feb – 27 Feb',  keywords: 'Maha Shivaratri, Shiva, temple',                         remarks: 'Date varies each year' },
  { slNo: 12, occasion: 'Month of Ramzan starts',                                  date: '1 March',      monitoringRange: '28 Feb – 2 Mar',   keywords: 'Ramzan, Ramadan, fasting, Islamic',                      remarks: 'Date varies each year' },
  { slNo: 13, occasion: 'Observance of Holi Festival',                             date: '14 March',     monitoringRange: '13 Mar – 16 Mar',  keywords: 'Holi, colours, celebration',                              remarks: 'Date varies each year' },
  { slNo: 14, occasion: 'Ugadi Festival',                                          date: '30 March',     monitoringRange: '29 Mar – 31 Mar',  keywords: 'Ugadi, Telugu New Year, festival',                        remarks: 'Date varies each year' },
  { slNo: 15, occasion: 'Observance of Shab-e-Qadar (Jagne ki Raath)',             date: '27 March',     monitoringRange: '26 Mar – 28 Mar',  keywords: 'Shab-e-Qadar, Lailatul Qadr, Ramzan',                    remarks: 'Date varies each year' },
  { slNo: 16, occasion: 'Observance of Jumat-ul-Vida (last Friday of Ramzan)',     date: '28 March',     monitoringRange: '27 Mar – 29 Mar',  keywords: 'Jumat-ul-Vida, Ramzan, Friday prayer',                   remarks: 'Date varies each year' },
  { slNo: 17, occasion: 'Observance of Ramzan Festival (Eid-UL-Fitr)',             date: '31 March',     monitoringRange: '29 Mar – 2 Apr',   keywords: 'Eid-ul-Fitr, Ramzan, Eid',                               remarks: 'Date varies each year' },
  { slNo: 18, occasion: 'Babu Jagjivan Rams Birthday',                             date: '5 April',      monitoringRange: '4 Apr – 6 Apr',    keywords: 'Jagjivan Ram, birthday, Dalit',                           remarks: '' },
  { slNo: 19, occasion: 'Sri Rama Navami',                                         date: '6 April',      monitoringRange: '4 Apr – 8 Apr',    keywords: 'Rama Navami, Ram, procession',                            remarks: 'Date varies each year' },
  { slNo: 20, occasion: 'Mahaveer Jayathi',                                        date: '10 April',     monitoringRange: '9 Apr – 11 Apr',   keywords: 'Mahaveer Jayanti, Jain',                                  remarks: 'Date varies each year' },
  { slNo: 21, occasion: 'Sri Hanuman Jayanthi',                                    date: '12 April',     monitoringRange: '11 Apr – 13 Apr',  keywords: 'Hanuman Jayanti, temple',                                 remarks: 'Date varies each year' },
  { slNo: 22, occasion: 'Dr. B.R. Ambedkar birthday',                              date: '14 April',     monitoringRange: '13 Apr – 15 Apr',  keywords: 'Ambedkar Jayanti, Dalit, reservation',                    remarks: '' },
  { slNo: 23, occasion: 'Good Friday',                                             date: '18 April',     monitoringRange: '17 Apr – 20 Apr',  keywords: 'Good Friday, Easter, church',                             remarks: 'Date varies each year' },
  { slNo: 24, occasion: 'Observance of Hajj Pilgrims',                             date: '5 June',       monitoringRange: '3 Jun – 7 Jun',    keywords: 'Hajj, pilgrims, Mecca',                                   remarks: 'Date varies each year' },
  { slNo: 25, occasion: 'Observance of Mecca Masjid Bomb Blast',                   date: '18 May',       monitoringRange: '17 May – 19 May',  keywords: 'Mecca Masjid, bomb blast, anniversary',                   remarks: 'Sensitive date' },
  { slNo: 26, occasion: 'Telangana Formation Day Celebration',                     date: '2 June',       monitoringRange: '1 Jun – 3 Jun',    keywords: 'Telangana Formation Day, statehood',                     remarks: '' },
  { slNo: 27, occasion: 'Distribution of Fish Prasadam at Exhibition Ground',      date: '8 June',       monitoringRange: '7 Jun – 9 Jun',    keywords: 'Fish Prasadam, Exhibition Ground, asthma',               remarks: 'Date varies each year' },
  { slNo: 28, occasion: 'Observance of Bakrid Festival (Eid-UL-Azha)',             date: '7 June',       monitoringRange: '5 Jun – 9 Jun',    keywords: 'Eid-ul-Adha, Bakrid, sacrifice',                          remarks: 'Date varies each year' },
  { slNo: 29, occasion: 'Ratha Yatra Of Lord Shree Jagannath, Road No.12, Banjara Hills, Hyderabad', date: '27 June', monitoringRange: '26 Jun – 28 Jun', keywords: 'Rath Yatra, Jagannath, Banjara Hills',   remarks: '' },
  { slNo: 30, occasion: 'Observance Of Moharrum (Mourning Month)',                 date: '6 July',       monitoringRange: '4 Jul – 8 Jul',    keywords: 'Muharram, Tazia, Ashura, mourning',                      remarks: 'Date varies each year' },
  { slNo: 31, occasion: 'Observance of Bonalu Festival Golconda Fort, Ashada bagicha, Mangalhat PS and Balkempet Ellamma Temple, S.R. Nagar PS', date: '14 July', monitoringRange: '13 Jul – 15 Jul', keywords: 'Bonalu, Golconda, Mangalhat, Balkempet, Ellamma', remarks: 'Date varies each year' },
  { slNo: 32, occasion: 'Observance of Bonalu Festival in Secunderabad',           date: '21 July',      monitoringRange: '20 Jul – 22 Jul',  keywords: 'Bonalu, Secunderabad, procession',                       remarks: 'Date varies each year' },
  { slNo: 33, occasion: 'Observance of Bonalu Festival in Hyderabad',              date: '28 July',      monitoringRange: '27 Jul – 29 Jul',  keywords: 'Bonalu, Hyderabad, procession',                          remarks: 'Date varies each year' },
  { slNo: 34, occasion: 'Observance of Independence Day',                          date: '15 August',    monitoringRange: '13 Aug – 17 Aug',  keywords: 'Independence Day, 15 August, tricolour',                 remarks: 'High priority' },
  { slNo: 35, occasion: 'Arbayeen (40th day of Moharrum)',                         date: '14 August',    monitoringRange: '13 Aug – 15 Aug',  keywords: 'Arbayeen, Moharrum, 40th day',                           remarks: 'Date varies each year' },
  { slNo: 36, occasion: 'Sri Janama Asthami/Krishna Asthami',                      date: '16 August',    monitoringRange: '15 Aug – 17 Aug',  keywords: 'Janmashtami, Krishna, Dahi Handi',                       remarks: 'Date varies each year' },
  { slNo: 37, occasion: 'TG Legislative Monsoon Sessions',                         date: '18 August',    monitoringRange: '16 Aug – 30 Sep',  keywords: 'TG Legislature, Monsoon Session, Telangana Assembly',    remarks: '' },
  { slNo: 38, occasion: 'Observance of Ganesh Festival',                           date: '27 August',    monitoringRange: '26 Aug – 7 Sep',   keywords: 'Ganesh Chaturthi, Ganpati, Visarjan, immersion',         remarks: 'Date varies each year' },
  { slNo: 39, occasion: 'Milad-Un-Nabi',                                           date: '5 September',  monitoringRange: '4 Sep – 6 Sep',    keywords: 'Milad-un-Nabi, Prophet, Eid Milad',                      remarks: 'Date varies each year' },
  { slNo: 40, occasion: 'Bathukamma Celebrations Starting Day',                    date: '25 September', monitoringRange: '24 Sep – 3 Oct',   keywords: 'Bathukamma, Telangana, flowers, festival',               remarks: 'Date varies each year' },
  { slNo: 41, occasion: 'Observance of Dussehra Festival',                         date: '12 October',   monitoringRange: '10 Oct – 13 Oct',  keywords: 'Dussehra, Vijayadashami, Ravan',                         remarks: 'Date varies each year' },
  { slNo: 42, occasion: 'Observance of Gandhi Jayanthi',                           date: '2 October',    monitoringRange: '1 Oct – 3 Oct',    keywords: 'Gandhi Jayanti, Mahatma Gandhi, non-violence',           remarks: '' },
  { slNo: 43, occasion: 'Observance of Deepavali Festival',                        date: '1 November',   monitoringRange: '30 Oct – 3 Nov',   keywords: 'Diwali, Deepavali, firecrackers, Lakshmi',               remarks: 'Date varies each year' },
  { slNo: 44, occasion: 'Guru Nanak Jayanthi',                                     date: '15 November',  monitoringRange: '14 Nov – 16 Nov',  keywords: 'Guru Nanak Jayanti, Sikh, Gurudwara',                    remarks: 'Date varies each year' },
  { slNo: 45, occasion: 'Black Day (Anniversary demolition of Babri Masjid)',      date: '6 December',   monitoringRange: '5 Dec – 7 Dec',    keywords: 'Babri Masjid, Black Day, demolition, anniversary',       remarks: 'Sensitive date' },
  { slNo: 46, occasion: 'Visit of H.E. President of India to Hyderabad',           date: '15 December',  monitoringRange: '14 Dec – 16 Dec',  keywords: 'President, India, Hyderabad, visit, VVIP',               remarks: 'Date varies' },
  { slNo: 47, occasion: 'Christmas Celebrations',                                  date: '25 December',  monitoringRange: '24 Dec – 26 Dec',  keywords: 'Christmas, Santa, church, carol',                        remarks: '' },
  { slNo: 48, occasion: 'New Years Day Celebrations',                              date: '1 January',    monitoringRange: '31 Dec – 2 Jan',   keywords: 'New Year, celebrations, countdown',                      remarks: '' },
];

// Ensure recurring seed events exist in the DB (replaces old data with updated list)
const seedRecurringEvents = async () => {
  try {
    // Remove old seed data and re-insert the updated 48 events
    const existing = await MasterCalendarEvent.find({ isRecurring: true, createdBy: 'system' });
    const existingSlNos = new Set(existing.map(e => e.slNo));
    const seedSlNos = new Set(RECURRING_SEED.map(e => e.slNo));

    // Delete old system events whose slNo no longer exists in seed
    for (const evt of existing) {
      if (!seedSlNos.has(evt.slNo)) {
        await MasterCalendarEvent.deleteOne({ _id: evt._id });
      }
    }

    // Upsert all seed events
    for (const evt of RECURRING_SEED) {
      await MasterCalendarEvent.findOneAndUpdate(
        { isRecurring: true, slNo: evt.slNo },
        { $set: { ...evt, isRecurring: true, createdBy: 'system' } },
        { upsert: true, new: true }
      );
    }
    console.log('[MasterCalendar] 48 HCP recurring events seeded');
  } catch (err) {
    console.error('[MasterCalendar] Seed error:', err.message);
  }
};

// ── CRUD controllers ──────────────────────────────────────

const listEvents = async (req, res) => {
  try {
    const { recurring, district } = req.query;
    const query = { ...withTenant(req, scopedDistrictQuery(req)) };
    if (district && district !== 'all') {
      if (req.user?.role !== 'admin' && !(req.user?.districts || []).includes(district)) {
        return res.status(403).json({ message: 'District not assigned to you' });
      }
      query.districts = district;
    }
    if (recurring === 'true') query.isRecurring = true;
    else if (recurring === 'false') query.isRecurring = false;

    const events = await MasterCalendarEvent.find(query).sort({ slNo: 1, createdAt: -1 });
    res.json(events);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createEvent = async (req, res) => {
  try {
    const { occasion, date, monitoringRange, keywords, remarks, isRecurring, state, districts } = req.body;
    if (!occasion || !date) {
      return res.status(400).json({ message: 'Occasion and date are required' });
    }

    const districtCheck = validateScopedDistricts(req, districts);
    if (!districtCheck.ok) {
      return res.status(400).json({ message: districtErrorMessage(districtCheck) });
    }

    // Auto-assign slNo (tenant-scoped so each tenant has its own slNo sequence)
    const maxDoc = await MasterCalendarEvent.findOne(withTenant(req, { isRecurring: !!isRecurring }))
      .sort({ slNo: -1 }).select('slNo').lean();
    const slNo = (maxDoc?.slNo || 0) + 1;

    const event = await MasterCalendarEvent.create({
      slNo,
      occasion,
      date,
      monitoringRange: monitoringRange || '',
      keywords: keywords || '',
      remarks: remarks || '',
      isRecurring: !!isRecurring,
      createdBy: req.user?.email || 'unknown',
      state: state || '',
      districts: districtCheck.districts,
      ...withTenant(req)
    });

    logHistory(req, { module: event.isRecurring ? 'master_calendar_recurring' : 'master_calendar_non_recurring', action: 'create', recordId: event.id, recordLabel: event.occasion, state: event.state, districts: event.districts, changes: { occasion, date, monitoringRange, isRecurring: !!isRecurring } });

    res.status(201).json(event);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateEvent = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    const event = await MasterCalendarEvent.findOne(withTenant(req, { id, ...scopedDistrictQuery(req) }));
    if (!event) return res.status(404).json({ message: 'Event not found' });

    const allowedFields = ['occasion', 'date', 'monitoringRange', 'keywords', 'remarks'];
    for (const field of allowedFields) {
      if (updates[field] !== undefined) event[field] = updates[field];
    }
    event.updatedBy = req.user?.email || req.user?.id || '';
    await event.save();

    logHistory(req, { module: event.isRecurring ? 'master_calendar_recurring' : 'master_calendar_non_recurring', action: 'update', recordId: id, recordLabel: event.occasion, state: event.state, districts: event.districts, changes: updates });

    res.json(event);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const deleteEvent = async (req, res) => {
  try {
    const { id } = req.params;
    const event = await MasterCalendarEvent.findOne(withTenant(req, { id, ...scopedDistrictQuery(req) }));
    if (!event) return res.status(404).json({ message: 'Event not found' });

    await MasterCalendarEvent.deleteOne(withTenant(req, { id, ...scopedDistrictQuery(req) }));

    logHistory(req, { module: event.isRecurring ? 'master_calendar_recurring' : 'master_calendar_non_recurring', action: 'delete', recordId: id, recordLabel: event.occasion, state: event.state, districts: event.districts, changes: { occasion: event.occasion, date: event.date } });

    res.json({ message: 'Event deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  seedRecurringEvents,
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent
};
