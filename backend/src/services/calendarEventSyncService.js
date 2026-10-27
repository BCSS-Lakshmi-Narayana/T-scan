/**
 * Calendar → Event Sync Service
 *
 * Reads MasterCalendarEvent entries and auto-creates corresponding Event
 * documents so they appear in the Events page with full monitoring support.
 *
 * - Recurring events (isRecurring: true)  → created for the current year
 *   (and next year if we're in December). Re-created every year automatically.
 * - Non-recurring events (isRecurring: false) → created once.
 * - Dedup via origin_calendar_id + origin_year on the Event model.
 */

const MasterCalendarEvent = require('../models/MasterCalendarEvent');
const Event = require('../models/Event');

// ── Date parsing helpers ──────────────────────────────────

const MONTH_MAP = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11
};

/**
 * Parse "26 January" or "2 Oct" → { day, month (0-indexed) }
 */
const parseDayMonth = (str) => {
  if (!str) return null;
  const match = str.trim().match(/^(\d{1,2})\s+([A-Za-z]+)$/);
  if (!match) return null;
  const day = parseInt(match[1], 10);
  const month = MONTH_MAP[match[2].toLowerCase()];
  if (month === undefined || day < 1 || day > 31) return null;
  return { day, month };
};

/**
 * Parse monitoring range like "24 Jan – 28 Jan" or "31 Dec – 2 Jan"
 * Returns { startDay, startMonth, endDay, endMonth } (months 0-indexed)
 */
const parseMonitoringRange = (range) => {
  if (!range) return null;
  // Normalize dash variants
  const normalized = range.replace(/\u2013|\u2014/g, '-').trim();
  const parts = normalized.split(/\s*-\s*/);
  if (parts.length !== 2) return null;

  const start = parseDayMonth(parts[0].trim());
  const end = parseDayMonth(parts[1].trim());
  if (!start || !end) return null;

  return {
    startDay: start.day,
    startMonth: start.month,
    endDay: end.day,
    endMonth: end.month
  };
};

/**
 * Build start_date and end_date for a given year from a MasterCalendarEvent.
 * Uses monitoringRange if available, otherwise falls back to occasion date ±1 day.
 */
const buildEventDates = (calendarEvent, year) => {
  const range = parseMonitoringRange(calendarEvent.monitoringRange);

  if (range) {
    let startYear = year;
    let endYear = year;

    // Handle cross-year ranges (e.g., "31 Dec – 2 Jan")
    if (range.endMonth < range.startMonth) {
      endYear = year + 1;
    }

    const start_date = new Date(startYear, range.startMonth, range.startDay, 0, 0, 0);
    const end_date = new Date(endYear, range.endMonth, range.endDay, 23, 59, 59);
    return { start_date, end_date };
  }

  // Fallback: parse the occasion date and use ±1 day
  const dm = parseDayMonth(calendarEvent.date);
  if (!dm) return null;

  const center = new Date(year, dm.month, dm.day, 12, 0, 0);
  const start_date = new Date(center.getTime() - 24 * 60 * 60 * 1000);
  start_date.setHours(0, 0, 0, 0);
  const end_date = new Date(center.getTime() + 24 * 60 * 60 * 1000);
  end_date.setHours(23, 59, 59, 999);
  return { start_date, end_date };
};

/**
 * Convert comma-separated keywords string → Event keyword array.
 * Treats all keywords as language 'en' (master calendar keywords are in English).
 */
const parseKeywords = (keywordsStr) => {
  if (!keywordsStr) return [];
  return keywordsStr
    .split(/,/)
    .map((k) => k.trim())
    .filter(Boolean)
    .map((keyword) => ({ keyword, language: 'en' }));
};

/**
 * Determine the proper status for a new event based on its dates.
 */
const computeStatus = (start_date, end_date) => {
  const now = new Date();
  if (now > end_date) return 'archived';
  if (now >= start_date) return 'active';
  return 'planned';
};

// ── Main sync function ────────────────────────────────────

/**
 * Sync MasterCalendarEvent entries → Event documents.
 *
 * For recurring events: ensures an Event exists for the current year
 * (and next year when in December).
 *
 * For non-recurring events: creates a one-time Event if not already present
 * (uses origin_year = 0 as a sentinel).
 */
const syncCalendarToEvents = async () => {
  try {
    const calendarEvents = await MasterCalendarEvent.find({}).lean();
    if (!calendarEvents.length) return;

    const now = new Date();
    const currentYear = now.getFullYear();
    // In December, also pre-create next year's recurring events
    const targetYears = now.getMonth() === 11
      ? [currentYear, currentYear + 1]
      : [currentYear];

    let created = 0;
    let skipped = 0;
    let statusUpdated = 0;

    for (const cal of calendarEvents) {
      if (cal.isRecurring) {
        // ── Recurring: create for each target year ──
        for (const year of targetYears) {
          const dates = buildEventDates(cal, year);
          if (!dates) {
            skipped++;
            continue;
          }

          // Check if already exists
          const existing = await Event.findOne({
            origin: 'master_calendar',
            origin_calendar_id: cal.id,
            origin_year: year
          });

          if (existing) {
            // Update status if dates have passed
            const correctStatus = computeStatus(dates.start_date, dates.end_date);
            if (existing.status !== correctStatus && existing.status !== 'paused') {
              existing.status = correctStatus;
              if (correctStatus === 'archived') existing.archived_at = new Date();
              await existing.save();
              statusUpdated++;
            }
            skipped++;
            continue;
          }

          await Event.create({
            name: cal.occasion,
            description: cal.remarks || `Auto-created from Master Calendar (${cal.isRecurring ? 'recurring' : 'one-time'})`,
            start_date: dates.start_date,
            end_date: dates.end_date,
            keywords: parseKeywords(cal.keywords),
            platforms: ['youtube', 'x', 'facebook', 'instagram'],
            status: computeStatus(dates.start_date, dates.end_date),
            auto_archive: true,
            created_by: 'system',
            origin: 'master_calendar',
            origin_calendar_id: cal.id,
            origin_year: year
          });
          created++;
        }
      } else {
        // ── Non-recurring: create once ──
        // Parse the date — for non-recurring the date field may include a year,
        // otherwise default to current year.
        const dm = parseDayMonth(cal.date);
        if (!dm) {
          skipped++;
          continue;
        }

        const year = currentYear; // Non-recurring events are for this year
        const dates = buildEventDates(cal, year);
        if (!dates) {
          skipped++;
          continue;
        }

        const existing = await Event.findOne({
          origin: 'master_calendar',
          origin_calendar_id: cal.id,
          origin_year: year
        });

        if (existing) {
          const correctStatus = computeStatus(dates.start_date, dates.end_date);
          if (existing.status !== correctStatus && existing.status !== 'paused') {
            existing.status = correctStatus;
            if (correctStatus === 'archived') existing.archived_at = new Date();
            await existing.save();
            statusUpdated++;
          }
          skipped++;
          continue;
        }

        await Event.create({
          name: cal.occasion,
          description: cal.remarks || 'Auto-created from Master Calendar',
          start_date: dates.start_date,
          end_date: dates.end_date,
          keywords: parseKeywords(cal.keywords),
          platforms: ['youtube', 'x', 'facebook', 'instagram'],
          status: computeStatus(dates.start_date, dates.end_date),
          auto_archive: true,
          created_by: 'system',
          origin: 'master_calendar',
          origin_calendar_id: cal.id,
          origin_year: year
        });
        created++;
      }
    }

    if (created > 0 || statusUpdated > 0) {
      console.log(`[CalendarSync] Created ${created} events, updated ${statusUpdated} statuses, skipped ${skipped} existing`);
    }
  } catch (err) {
    console.error('[CalendarSync] Error:', err.message);
  }
};

module.exports = { syncCalendarToEvents };
