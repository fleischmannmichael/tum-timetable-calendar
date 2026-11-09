/**
 * Time zone handling without libraries. Uses Intl (available in browsers, Node and the
 * Apps Script V8 runtime). Apps Script can swap in a Utilities-based provider if Intl
 * lacks time zone data (see gas/env.ts).
 */
import { IcsError, type IcsProperty } from './ics';

/** Returns the offset of `tz` from UTC at instant `utcMs`, in ms (local = utc + offset). */
export type OffsetProvider = (utcMs: number, tz: string) => number;

const dtfCache = new Map<string, Intl.DateTimeFormat>();

export const intlOffsetProvider: OffsetProvider = (utcMs, tz) => {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    dtfCache.set(tz, f);
  }
  const parts = f.formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
};

let provider: OffsetProvider = intlOffsetProvider;

export function setOffsetProvider(p: OffsetProvider): void {
  provider = p;
}

export function offsetMs(utcMs: number, tz: string): number {
  return provider(utcMs, tz);
}

export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Converts a wall-clock time in `tz` to a UTC timestamp (handles DST changes). */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const o1 = offsetMs(guess, tz);
  let t = guess - o1;
  const o2 = offsetMs(t, tz);
  if (o2 !== o1) t = guess - o2;
  return t;
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 1 = Monday ... 7 = Sunday */
  weekday: number;
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM */
  time: string;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function localParts(utcMs: number, tz: string): LocalParts {
  const l = new Date(utcMs + offsetMs(utcMs, tz));
  const year = l.getUTCFullYear();
  const month = l.getUTCMonth() + 1;
  const day = l.getUTCDate();
  const hour = l.getUTCHours();
  const minute = l.getUTCMinutes();
  const wd = l.getUTCDay();
  return {
    year, month, day, hour, minute, second: l.getUTCSeconds(),
    weekday: wd === 0 ? 7 : wd,
    date: `${year}-${pad(month)}-${pad(day)}`,
    time: `${pad(hour)}:${pad(minute)}`,
  };
}

/** Adds days to a YYYY-MM-DD date string. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Weekday of a YYYY-MM-DD date: 1 = Monday ... 7 = Sunday. */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

/** UTC timestamp as compact iCalendar form, e.g. 20261020T080000Z (used in stable keys). */
export function compactUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

// Common Windows / Outlook time zone names → IANA. Not exhaustive; unknown names fall back
// to the calendar's default zone with a visible warning.
const WINDOWS_ZONES: Record<string, string> = {
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'Romance Standard Time': 'Europe/Paris',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'FLE Standard Time': 'Europe/Kiev',
  'GTB Standard Time': 'Europe/Bucharest',
  'UTC': 'UTC',
  'Coordinated Universal Time': 'UTC',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles',
  'China Standard Time': 'Asia/Shanghai',
  'India Standard Time': 'Asia/Kolkata',
  'Tokyo Standard Time': 'Asia/Tokyo',
};

/** Resolves a TZID parameter to an IANA zone, or returns null if it can't be recognised. */
export function resolveTzid(tzid: string): string | null {
  const t = tzid.trim().replace(/^"|"$/g, '');
  if (isValidTimeZone(t)) return t;
  if (WINDOWS_ZONES[t]) return WINDOWS_ZONES[t];
  // e.g. "/freeassociation.sourceforge.net/Tzfile/Europe/Berlin" or "(UTC+01:00) Europe/Berlin"
  const m = /([A-Z][A-Za-z_]+\/[A-Z][A-Za-z_]+(?:\/[A-Z][A-Za-z_]+)?)\s*$/.exec(t);
  if (m && isValidTimeZone(m[1])) return m[1];
  return null;
}

export type ParsedTime =
  | { allDay: true; date: string; ms: number }
  | { allDay: false; ms: number; tz: string };

/**
 * Parses a DTSTART/DTEND/EXDATE/RECURRENCE-ID value (single value).
 * `warn` is called when a TZID is unknown and the default zone is used instead.
 */
export function parseIcsTimeValue(
  value: string,
  params: Record<string, string>,
  defaultTz: string,
  warn: (msg: string) => void,
): ParsedTime {
  const v = value.trim();
  const dm = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (params.VALUE === 'DATE' || dm) {
    if (!dm) throw new IcsError(`Unrecognised date "${v}"`);
    const date = `${dm[1]}-${dm[2]}-${dm[3]}`;
    return { allDay: true, date, ms: zonedToUtc(+dm[1], +dm[2], +dm[3], 0, 0, 0, defaultTz) };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v);
  if (!m) throw new IcsError(`Unrecognised date/time "${v}"`);
  const [y, mo, d, h, mi, s] = [+m[1], +m[2], +m[3], +m[4], +m[5], m[6] ? +m[6] : 0];
  if (m[7]) return { allDay: false, ms: Date.UTC(y, mo - 1, d, h, mi, s), tz: 'UTC' };
  let tz = defaultTz;
  if (params.TZID) {
    const r = resolveTzid(params.TZID);
    if (r) tz = r;
    else warn(`Unknown time zone "${params.TZID}", assumed ${defaultTz}`);
  }
  return { allDay: false, ms: zonedToUtc(y, mo, d, h, mi, s, tz), tz };
}

/** Parses a property that may hold a comma-separated list (EXDATE, RDATE). */
export function parseIcsTimeList(p: IcsProperty, defaultTz: string, warn: (msg: string) => void): ParsedTime[] {
  return p.value
    .split(',')
    .filter((x) => x.trim())
    .map((x) => parseIcsTimeValue(x, p.params, defaultTz, warn));
}

/** Parses an iCalendar DURATION such as PT1H30M or P1D. Returns ms, or null if invalid. */
export function parseDuration(v: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return null;
  const [, sign, w, d, h, mi, s] = m;
  const ms = ((+(w ?? 0) * 7 + +(d ?? 0)) * 86400 + +(h ?? 0) * 3600 + +(mi ?? 0) * 60 + +(s ?? 0)) * 1000;
  return sign === '-' ? -ms : ms;
}
