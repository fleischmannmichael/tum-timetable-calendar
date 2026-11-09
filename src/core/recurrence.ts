/**
 * RRULE expansion for the rules timetables actually use. Works in wall-clock time of the
 * event's zone, so "every Thursday 15:00" stays 15:00 across daylight-saving changes.
 *
 * Supported: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL, COUNT, UNTIL, BYDAY (weekly: plain
 * days; monthly: plain or with ordinal like 1MO / -1FR), BYMONTHDAY, BYMONTH, WKST.
 * Anything else makes expandRule() return null; the caller then imports only the first date
 * and flags the event, instead of silently dropping dates.
 */
import { addDays, localParts, weekdayOf, zonedToUtc, type ParsedTime } from './time';

const DAYS: Record<string, number> = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 };

export interface Rrule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  count?: number;
  untilRaw?: string;
  byDay?: Array<{ n?: number; wd: number }>;
  byMonthDay?: number[];
  byMonth?: number[];
}

export interface RruleParse {
  rule?: Rrule;
  unsupported?: string;
}

export function parseRrule(value: string): RruleParse {
  const parts: Record<string, string> = {};
  for (const kv of value.split(';')) {
    const [k, v] = kv.split('=');
    if (k && v !== undefined) parts[k.trim().toUpperCase()] = v.trim().toUpperCase();
  }
  const freq = parts.FREQ;
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') {
    return { unsupported: `FREQ=${freq ?? '(missing)'}` };
  }
  const bad = Object.keys(parts).filter(
    (k) => !['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'WKST'].includes(k),
  );
  if (bad.length) return { unsupported: bad.join(', ') };

  const rule: Rrule = { freq, interval: Math.max(1, parseInt(parts.INTERVAL ?? '1', 10) || 1) };
  if (parts.COUNT) rule.count = parseInt(parts.COUNT, 10);
  if (parts.UNTIL) rule.untilRaw = parts.UNTIL;
  if (parts.BYDAY) {
    const list: Array<{ n?: number; wd: number }> = [];
    for (const item of parts.BYDAY.split(',')) {
      const m = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(item);
      if (!m) return { unsupported: `BYDAY=${parts.BYDAY}` };
      list.push({ n: m[1] ? parseInt(m[1], 10) : undefined, wd: DAYS[m[2]] });
    }
    if (freq !== 'MONTHLY' && list.some((d) => d.n !== undefined)) return { unsupported: `BYDAY=${parts.BYDAY}` };
    if (freq === 'YEARLY') return { unsupported: 'BYDAY with FREQ=YEARLY' };
    rule.byDay = list;
  }
  if (parts.BYMONTHDAY) rule.byMonthDay = parts.BYMONTHDAY.split(',').map((x) => parseInt(x, 10));
  if (parts.BYMONTH) rule.byMonth = parts.BYMONTH.split(',').map((x) => parseInt(x, 10));
  return { rule };
}

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** Candidate dates (YYYY-MM-DD) for one period, unsorted, may include dates before start. */
function periodDates(rule: Rrule, startDate: string, k: number): string[] {
  const [sy, sm, sd] = startDate.split('-').map(Number);
  switch (rule.freq) {
    case 'DAILY':
      return [addDays(startDate, k * rule.interval)];
    case 'WEEKLY': {
      const monday = addDays(startDate, 1 - weekdayOf(startDate) + 7 * k * rule.interval);
      const wds = rule.byDay?.map((d) => d.wd) ?? [weekdayOf(startDate)];
      return wds.map((wd) => addDays(monday, wd - 1));
    }
    case 'MONTHLY': {
      const idx = sm - 1 + k * rule.interval;
      const y = sy + Math.floor(idx / 12);
      const m = (idx % 12) + 1;
      if (rule.byMonth && !rule.byMonth.includes(m)) return [];
      const dim = daysInMonth(y, m);
      const out: string[] = [];
      if (rule.byDay) {
        for (const { n, wd } of rule.byDay) {
          const all: number[] = [];
          for (let d = 1; d <= dim; d++) if (weekdayOf(ymd(y, m, d)) === wd) all.push(d);
          if (n === undefined) all.forEach((d) => out.push(ymd(y, m, d)));
          else {
            const d = n > 0 ? all[n - 1] : all[all.length + n];
            if (d) out.push(ymd(y, m, d));
          }
        }
      } else {
        for (const md of rule.byMonthDay ?? [sd]) {
          const d = md > 0 ? md : dim + md + 1;
          if (d >= 1 && d <= dim) out.push(ymd(y, m, d));
        }
      }
      return out;
    }
    case 'YEARLY': {
      const y = sy + k * rule.interval;
      const out: string[] = [];
      for (const m of rule.byMonth ?? [sm]) {
        const dim = daysInMonth(y, m);
        for (const md of rule.byMonthDay ?? [sd]) {
          const d = md > 0 ? md : dim + md + 1;
          if (d >= 1 && d <= dim) out.push(ymd(y, m, d));
        }
      }
      return out;
    }
  }
}

export interface ExpandOptions {
  /** Stop generating after this instant (protects against endless rules). */
  horizonMs: number;
  /** Hard cap on occurrences. */
  maxCount?: number;
}

export interface ExpandResult {
  starts: ParsedTime[];
  /** True if the rule had no end and was cut at the horizon. */
  truncated: boolean;
}

/** Expands a rule starting at dtstart. dtstart itself is always the first occurrence. */
export function expandRule(dtstart: ParsedTime, rule: Rrule, opts: ExpandOptions): ExpandResult {
  const maxCount = opts.maxCount ?? 1000;
  const tz = dtstart.allDay ? 'UTC' : dtstart.tz;
  const lp = dtstart.allDay ? null : localParts(dtstart.ms, tz);
  const startDate = dtstart.allDay ? dtstart.date : lp!.date;

  let untilMs = Infinity;
  let untilDate: string | null = null;
  if (rule.untilRaw) {
    const u = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(rule.untilRaw);
    if (u) {
      untilDate = `${u[1]}-${u[2]}-${u[3]}`;
      if (u[4]) {
        untilMs = u[7]
          ? Date.UTC(+u[1], +u[2] - 1, +u[3], +u[4], +u[5], +u[6])
          : zonedToUtc(+u[1], +u[2], +u[3], +u[4], +u[5], +u[6], tz);
      } else if (!dtstart.allDay) {
        untilMs = zonedToUtc(+u[1], +u[2], +u[3], 23, 59, 59, tz);
      }
    }
  }

  const toTime = (date: string): ParsedTime => {
    if (dtstart.allDay) {
      return { allDay: true, date, ms: dtstart.ms + (Date.parse(date) - Date.parse(startDate)) };
    }
    const [y, m, d] = date.split('-').map(Number);
    return { allDay: false, ms: zonedToUtc(y, m, d, lp!.hour, lp!.minute, lp!.second, tz), tz };
  };

  const starts: ParsedTime[] = [dtstart];
  const seen = new Set<string>([startDate]);
  let truncated = false;
  const hasEnd = rule.count !== undefined || rule.untilRaw !== undefined;

  for (let k = 0; k < 5000; k++) {
    const dates = periodDates(rule, startDate, k).filter((d) => d > startDate && !seen.has(d)).sort();
    let stop = false;
    for (const date of dates) {
      if (rule.count !== undefined && starts.length >= rule.count) { stop = true; break; }
      const t = toTime(date);
      if (dtstart.allDay ? untilDate !== null && date > untilDate : t.ms > untilMs) { stop = true; break; }
      if (t.ms > opts.horizonMs) { truncated = !hasEnd; stop = true; break; }
      if (starts.length >= maxCount) { truncated = true; stop = true; break; }
      seen.add(date);
      starts.push(t);
    }
    if (stop) break;
    // Periods that produce nothing (e.g. BYMONTH filters) still advance; guard against runaway.
    const probe = periodDates(rule, startDate, k + 1)[0];
    if (probe && toTime(probe).ms > opts.horizonMs + 400 * 86400000) break;
  }
  return { starts, truncated };
}
