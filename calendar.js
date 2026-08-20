// Shared live-calendar reader. Used by the Vercel function (api/events.js)
// and the Vite dev middleware so localhost and production read the same feed.
// The calendar is the single source of truth; no event data is hand-maintained.

const DEFAULT_CALENDAR_ID =
  "c_3b0c348068f9425cfb01cb35fce3f9a75b8ba285fd179a655774f67b377628c8@group.calendar.google.com";

export function calendarId() {
  return (
    process.env.GOOGLE_CALENDAR_ID ||
    process.env.VITE_GOOGLE_CALENDAR_ID ||
    DEFAULT_CALENDAR_ID
  );
}

function calendarUrl() {
  return `https://calendar.google.com/calendar/ical/${encodeURIComponent(calendarId())}/public/basic.ics`;
}

function unescapeText(value = "") {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

function property(block, name) {
  const line = block.split("\n").find((entry) => entry.startsWith(`${name}:`) || entry.startsWith(`${name};`));
  return line ? line.slice(line.indexOf(":") + 1) : "";
}

function dateProperty(block, name) {
  const line = block.split("\n").find((entry) => entry.startsWith(`${name}:`) || entry.startsWith(`${name};`));
  if (!line) return null;

  const raw = line.slice(line.indexOf(":") + 1).trim();
  const allDay = line.includes("VALUE=DATE") || /^\d{8}$/.test(raw);

  if (allDay) {
    const year = raw.slice(0, 4);
    const month = raw.slice(4, 6);
    const day = raw.slice(6, 8);
    return { iso: `${year}-${month}-${day}T00:00:00-07:00`, allDay: true };
  }

  const match = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, zone] = match;
  return {
    iso: `${year}-${month}-${day}T${hour}:${minute}:${second}${zone || "-07:00"}`,
    allDay: false,
  };
}

function externalUrl(block) {
  const direct = unescapeText(property(block, "URL"));
  const description = unescapeText(property(block, "DESCRIPTION"));
  const found = direct || description.match(/https?:\/\/[^\s<>]+/i)?.[0] || "";

  if (!found) return "";
  try {
    const url = new URL(found);
    if (url.hostname.endsWith("google.com") && url.pathname.includes("calendar")) return "";
    return url.toString();
  } catch {
    return "";
  }
}

const DAY_MS = 86400000;
const DAY_CODES = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

// How far ahead recurring series are expanded, and the safety cap on how many
// occurrences one series may contribute.
const HORIZON_DAYS = 400;
const MAX_OCCURRENCES = 60;

function parseRule(block) {
  const line = block.split("\n").find((entry) => entry.startsWith("RRULE:"));
  if (!line) return null;
  const rule = {};
  for (const part of line.slice(6).split(";")) {
    const [key, value] = part.split("=");
    if (key && value) rule[key.trim().toUpperCase()] = value.trim();
  }
  return rule.FREQ ? rule : null;
}

// EXDATE lines list occurrences the owner deleted from a series.
function excludedDates(block) {
  const out = new Set();
  for (const line of block.split("\n")) {
    if (!line.startsWith("EXDATE")) continue;
    for (const value of line.slice(line.indexOf(":") + 1).split(",")) {
      out.add(value.trim().slice(0, 8));
    }
  }
  return out;
}

function ruleLimit(rule) {
  if (!rule.UNTIL) return null;
  const raw = rule.UNTIL.trim();
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(4, 6));
  const day = Number(raw.slice(6, 8));
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day, 23, 59, 59).getTime();
}

// Expand a recurring series into concrete start dates. Supports the shapes
// Google Calendar emits for a lounge schedule: daily, weekly (with BYDAY),
// monthly by date or by nth weekday, and yearly.
function expandRecurrence(rule, seed, exdates, horizonEnd) {
  const interval = Math.max(1, Number(rule.INTERVAL) || 1);
  const count = Number(rule.COUNT) || null;
  const until = ruleLimit(rule);
  const freq = rule.FREQ.toUpperCase();
  const byDay = rule.BYDAY
    ? rule.BYDAY.split(",").map((token) => token.trim().toUpperCase())
    : [];

  const stamps = [];
  const push = (date) => {
    const time = date.getTime();
    if (until && time > until) return false;
    if (time > horizonEnd) return false;
    const key = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
    if (!exdates.has(key)) stamps.push(new Date(date));
    return true;
  };

  const cursor = new Date(seed);
  let guard = 0;

  while (stamps.length < (count || MAX_OCCURRENCES) && guard < 1200) {
    guard += 1;

    if (freq === "WEEKLY" && byDay.length) {
      // Walk the week containing the cursor and emit each selected weekday.
      const weekStart = new Date(cursor);
      weekStart.setDate(weekStart.getDate() - weekStart.getDay());
      let overshot = false;
      for (const token of byDay) {
        const dayIndex = DAY_CODES[token.slice(-2)];
        if (dayIndex === undefined) continue;
        const occurrence = new Date(weekStart);
        occurrence.setDate(weekStart.getDate() + dayIndex);
        occurrence.setHours(seed.getHours(), seed.getMinutes(), seed.getSeconds(), 0);
        if (occurrence < seed) continue;
        if (!push(occurrence)) overshot = true;
      }
      if (overshot) break;
      cursor.setDate(cursor.getDate() + 7 * interval);
    } else if (freq === "MONTHLY" && byDay.length && /^-?\d/.test(byDay[0])) {
      // e.g. BYDAY=3TU -> third Tuesday of the month
      const token = byDay[0];
      const ordinal = parseInt(token, 10);
      const dayIndex = DAY_CODES[token.slice(-2)];
      const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
      let occurrence;
      if (ordinal > 0) {
        const offset = (dayIndex - first.getDay() + 7) % 7;
        occurrence = new Date(first);
        occurrence.setDate(1 + offset + (ordinal - 1) * 7);
      } else {
        const last = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
        const offset = (last.getDay() - dayIndex + 7) % 7;
        occurrence = new Date(last);
        occurrence.setDate(last.getDate() - offset);
      }
      occurrence.setHours(seed.getHours(), seed.getMinutes(), seed.getSeconds(), 0);
      if (occurrence.getMonth() === cursor.getMonth() && occurrence >= seed) {
        if (!push(occurrence)) break;
      }
      cursor.setMonth(cursor.getMonth() + interval);
    } else {
      if (cursor >= seed && !push(new Date(cursor))) break;
      if (freq === "DAILY") cursor.setDate(cursor.getDate() + interval);
      else if (freq === "WEEKLY") cursor.setDate(cursor.getDate() + 7 * interval);
      else if (freq === "MONTHLY") cursor.setMonth(cursor.getMonth() + interval);
      else if (freq === "YEARLY") cursor.setFullYear(cursor.getFullYear() + interval);
      else break;
    }

    if (cursor.getTime() > horizonEnd) break;
  }

  return stamps.slice(0, count || MAX_OCCURRENCES);
}

export function parseCalendar(source) {
  const unfolded = source.replace(/\r?\n[ \t]/g, "").replace(/\r/g, "");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const horizonEnd = today.getTime() + HORIZON_DAYS * DAY_MS;

  const blocks = unfolded
    .split("BEGIN:VEVENT")
    .slice(1)
    .map((chunk) => chunk.split("END:VEVENT")[0]);

  // A VEVENT carrying RECURRENCE-ID is a single edited instance of a series.
  // It is emitted separately, so the generated occurrence for that date is
  // dropped in favour of the edited one.
  const overriddenInstances = new Set();
  for (const block of blocks) {
    const line = block.split("\n").find((entry) => entry.startsWith("RECURRENCE-ID"));
    if (!line) continue;
    const uid = unescapeText(property(block, "UID"));
    overriddenInstances.add(`${uid}:${line.slice(line.indexOf(":") + 1).trim().slice(0, 8)}`);
  }

  const events = [];

  for (const block of blocks) {
    // An event the owner cancelled must not stay on the site.
    if (/^STATUS:CANCELLED/m.test(block)) continue;

    const start = dateProperty(block, "DTSTART");
    const end = dateProperty(block, "DTEND");
    const title = unescapeText(property(block, "SUMMARY"));
    if (!start || !title) continue;

    const base = {
      id: unescapeText(property(block, "UID")),
      title,
      start: start.iso,
      end: end?.iso || "",
      allDay: start.allDay,
      location: unescapeText(property(block, "LOCATION")).replace(/\n+/g, ", "),
      url: externalUrl(block),
    };

    const rule = parseRule(block);
    if (!rule) {
      events.push(base);
      continue;
    }

    const seed = new Date(start.iso);
    const spanMs = end?.iso ? new Date(end.iso).getTime() - seed.getTime() : 0;
    for (const occurrence of expandRecurrence(rule, seed, excludedDates(block), horizonEnd)) {
      const stamp = `${occurrence.getFullYear()}${String(occurrence.getMonth() + 1).padStart(2, "0")}${String(occurrence.getDate()).padStart(2, "0")}`;
      if (overriddenInstances.has(`${base.id}:${stamp}`)) continue;
      events.push({
        ...base,
        id: `${base.id}-${stamp}`,
        seriesId: base.id,
        start: occurrence.toISOString(),
        end: spanMs ? new Date(occurrence.getTime() + spanMs).toISOString() : "",
      });
    }
  }

  const upcoming = events
    .filter((event) => {
      // All-day DTEND is exclusive in iCalendar, so an event that finished
      // yesterday reports tomorrow's date. Step it back before comparing.
      const raw = event.end || event.start;
      let endsAt = new Date(raw).getTime();
      if (event.allDay && event.end) endsAt -= DAY_MS;
      return endsAt >= today.getTime();
    })
    .sort((a, b) => new Date(a.start) - new Date(b.start));

  // Keep a repeating series from filling the whole list: show its next couple
  // of dates so one-off events still reach the page.
  const perSeries = new Map();
  const balanced = [];
  for (const event of upcoming) {
    if (event.seriesId) {
      const shown = perSeries.get(event.seriesId) || 0;
      if (shown >= 2) continue;
      perSeries.set(event.seriesId, shown + 1);
    }
    balanced.push(event);
    if (balanced.length === 8) break;
  }

  return balanced.map(({ seriesId, ...event }) => event);
}

// Fetch and parse the live calendar. Throws on a non-OK response so callers
// can decide how to degrade.
export async function fetchLiveEvents() {
  const calendarResponse = await fetch(calendarUrl(), {
    headers: { Accept: "text/calendar" },
  });
  if (!calendarResponse.ok) {
    throw new Error(`Calendar request failed with ${calendarResponse.status}`);
  }
  return parseCalendar(await calendarResponse.text());
}
