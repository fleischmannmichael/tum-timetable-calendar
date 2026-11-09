/**
 * Turns iCalendar text into a flat list of source events, one per date, each with a
 * stable key. Handles TZID/UTC/floating times, all-day events, STATUS:CANCELLED, VALARM
 * (ignored), RRULE/RDATE/EXDATE expansion and RECURRENCE-ID overrides.
 */
import { getProp, getProps, getText, parseIcs, IcsError, type IcsComponent } from './ics';
import { expandRule, parseRrule } from './recurrence';
import {
  addDays, compactUtc, isValidTimeZone, parseDuration, parseIcsTimeList, parseIcsTimeValue, type ParsedTime,
} from './time';
import { hash } from './text';

export interface SourceEvent {
  /** Stable key: UID for single events, UID#RECURRENCE-ID for dates of a repeating event. */
  key: string;
  uid: string;
  recurrenceId?: string;
  summary: string;
  description: string;
  location: string;
  url?: string;
  allDay: boolean;
  startMs: number;
  endMs: number;
  /** For all-day events: YYYY-MM-DD, end exclusive. */
  startDate?: string;
  endDate?: string;
  /** Groups dates of one series (TUMonline X-CO-RECURRINGID, or the UID of an RRULE event). */
  seriesId?: string;
  cancelled: boolean;
  /** Problems found while reading this event; shown as "needs attention". */
  warnings: string[];
}

export interface ParseResult {
  events: SourceEvent[];
  /** Events marked STATUS:CANCELLED in the feed (not imported, listed for transparency). */
  cancelled: SourceEvent[];
  warnings: string[];
  calendarName: string;
  timeZone: string;
  veventCount: number;
}

export interface ParseOptions {
  /** Zone for floating times and all-day dates, if the feed doesn't name a valid one. */
  defaultTimeZone?: string;
  /** Open-ended repeats are expanded up to this many days after their start. */
  horizonDays?: number;
}

interface Base {
  comp: IcsComponent;
  uid: string;
  start: ParsedTime;
  durationMs: number;
  endDateOffsetDays: number;
  warnings: string[];
}

function recurrenceIdString(t: ParsedTime): string {
  return t.allDay ? t.date.replace(/-/g, '') : compactUtc(t.ms);
}

export function parseCalendar(text: string, opts: ParseOptions = {}): ParseResult {
  const cal = parseIcs(text);
  const wrTz = getText(cal, 'X-WR-TIMEZONE');
  const fallbackTz = opts.defaultTimeZone ?? 'Europe/Berlin';
  const tz = wrTz && isValidTimeZone(wrTz) ? wrTz : fallbackTz;
  const horizonDays = opts.horizonDays ?? 550;
  const warnings: string[] = [];
  const vevents = cal.components.filter((c) => c.name === 'VEVENT');

  const masters = new Map<string, IcsComponent>();
  const overrides = new Map<string, IcsComponent[]>();
  const extraMasters: IcsComponent[] = [];

  for (const ev of vevents) {
    let uid = getText(ev, 'UID');
    if (!uid) {
      uid = 'nouid-' + hash(getText(ev, 'SUMMARY') + '|' + (getProp(ev, 'DTSTART')?.value ?? ''));
      ev.properties.push({ name: 'UID', params: {}, value: uid });
      warnings.push(`Event "${getText(ev, 'SUMMARY')}" has no UID; a key was generated from title and start.`);
    }
    if (getProp(ev, 'RECURRENCE-ID')) {
      const list = overrides.get(uid) ?? [];
      list.push(ev);
      overrides.set(uid, list);
    } else if (masters.has(uid)) {
      extraMasters.push(ev); // duplicate UID without RECURRENCE-ID: keep, but key will be made unique
    } else {
      masters.set(uid, ev);
    }
  }

  const makeBase = (comp: IcsComponent, uid: string): Base | null => {
    const w: string[] = [];
    const warn = (m: string) => w.push(m);
    const dtstart = getProp(comp, 'DTSTART');
    if (!dtstart) {
      warnings.push(`Event "${getText(comp, 'SUMMARY')}" has no start time and was skipped.`);
      return null;
    }
    let start: ParsedTime;
    try {
      start = parseIcsTimeValue(dtstart.value, dtstart.params, tz, warn);
    } catch (e) {
      warnings.push(`Event "${getText(comp, 'SUMMARY')}": ${(e as Error).message}; skipped.`);
      return null;
    }
    let durationMs = 0;
    let endDateOffsetDays = start.allDay ? 1 : 0;
    const dtend = getProp(comp, 'DTEND');
    const dur = getProp(comp, 'DURATION');
    if (dtend) {
      try {
        const end = parseIcsTimeValue(dtend.value, dtend.params, tz, warn);
        if (start.allDay && end.allDay) {
          endDateOffsetDays = Math.max(1, Math.round((Date.parse(end.date) - Date.parse(start.date)) / 86400000));
        } else {
          durationMs = Math.max(0, end.ms - start.ms);
        }
      } catch (e) {
        warn(`End time unreadable (${(e as Error).message}); start time used`);
      }
    } else if (dur) {
      const d = parseDuration(dur.value);
      if (d === null) warn(`Duration "${dur.value}" unreadable`);
      else if (start.allDay) endDateOffsetDays = Math.max(1, Math.round(d / 86400000));
      else durationMs = Math.max(0, d);
    } else if (!start.allDay) {
      warn('Event has no end time');
    }
    return { comp, uid, start, durationMs, endDateOffsetDays, warnings: w };
  };

  const build = (b: Base, start: ParsedTime, key: string, recurrenceId?: string, seriesId?: string): SourceEvent => {
    const c = b.comp;
    const status = getText(c, 'STATUS').toUpperCase();
    const ev: SourceEvent = {
      key,
      uid: b.uid,
      recurrenceId,
      summary: getText(c, 'SUMMARY') || '(no title)',
      description: getText(c, 'DESCRIPTION'),
      location: getText(c, 'LOCATION'),
      url: getText(c, 'URL') || undefined,
      allDay: start.allDay,
      startMs: start.ms,
      endMs: start.allDay ? start.ms + b.endDateOffsetDays * 86400000 : start.ms + b.durationMs,
      cancelled: status === 'CANCELLED',
      seriesId: seriesId ?? (getText(c, 'X-CO-RECURRINGID') || undefined),
      warnings: [...b.warnings],
    };
    if (start.allDay) {
      ev.startDate = start.date;
      ev.endDate = addDays(start.date, b.endDateOffsetDays);
    }
    return ev;
  };

  const out: SourceEvent[] = [];
  const horizon = (t: ParsedTime) => t.ms + horizonDays * 86400000;

  for (const [uid, master] of masters) {
    const base = makeBase(master, uid);
    if (!base) continue;
    const ovList = overrides.get(uid) ?? [];
    overrides.delete(uid);
    const ovById = new Map<string, Base>();
    for (const ov of ovList) {
      const rid = getProp(ov, 'RECURRENCE-ID')!;
      try {
        const t = parseIcsTimeValue(rid.value, rid.params, tz, () => {});
        const ob = makeBase(ov, uid);
        if (ob) ovById.set(recurrenceIdString(t), ob);
      } catch {
        warnings.push(`Unreadable RECURRENCE-ID "${rid.value}" ignored.`);
      }
    }

    const rrule = getProp(master, 'RRULE');
    const rdates = getProps(master, 'RDATE');
    if (!rrule && !rdates.length) {
      const own = ovById.get(recurrenceIdString(base.start));
      out.push(own ? build(own, own.start, uid) : build(base, base.start, uid));
      continue;
    }

    let starts: ParsedTime[] = [base.start];
    if (rrule) {
      const pr = parseRrule(rrule.value);
      if (pr.rule) {
        const r = expandRule(base.start, pr.rule, { horizonMs: horizon(base.start) });
        starts = r.starts;
        if (r.truncated) warnings.push(`"${getText(master, 'SUMMARY')}" repeats without end; dates after ${horizonDays} days were not imported.`);
      } else {
        base.warnings.push(`Repeat rule not supported (${pr.unsupported}); only the first date was imported`);
      }
    }
    for (const rd of rdates) {
      try {
        starts.push(...parseIcsTimeList(rd, tz, (m) => base.warnings.push(m)));
      } catch (e) {
        base.warnings.push(`RDATE unreadable: ${(e as Error).message}`);
      }
    }
    const excluded = new Set<string>();
    for (const ex of getProps(master, 'EXDATE')) {
      try {
        for (const t of parseIcsTimeList(ex, tz, () => {})) excluded.add(recurrenceIdString(t));
      } catch (e) {
        base.warnings.push(`EXDATE unreadable: ${(e as Error).message}`);
      }
    }
    const seen = new Set<string>();
    for (const s of starts.sort((a, b) => a.ms - b.ms)) {
      const rid = recurrenceIdString(s);
      if (seen.has(rid) || excluded.has(rid)) continue;
      seen.add(rid);
      const key = `${uid}#${rid}`;
      const ov = ovById.get(rid);
      out.push(ov ? build(ov, ov.start, key, rid, uid) : build(base, s, key, rid, uid));
    }
    // Overrides that point to a date the rule doesn't produce (moved via RDATE etc.)
    for (const [rid, ov] of ovById) {
      if (!seen.has(rid)) out.push(build(ov, ov.start, `${uid}#${rid}`, rid, uid));
    }
  }

  // Overrides whose master isn't in the feed: import them as single dates.
  for (const [uid, list] of overrides) {
    for (const ov of list) {
      const b = makeBase(ov, uid);
      if (!b) continue;
      const rid = getProp(ov, 'RECURRENCE-ID')!;
      let ridStr = rid.value;
      try { ridStr = recurrenceIdString(parseIcsTimeValue(rid.value, rid.params, tz, () => {})); } catch { /* keep raw */ }
      out.push(build(b, b.start, `${uid}#${ridStr}`, ridStr, uid));
    }
  }
  extraMasters.forEach((m, i) => {
    const uid = getText(m, 'UID');
    const b = makeBase(m, uid);
    if (b) {
      const key = `${uid}#dup${i + 1}-${recurrenceIdString(b.start)}`;
      warnings.push(`UID "${uid}" appears more than once; extra copies get their own key.`);
      out.push(build(b, b.start, key));
    }
  });

  out.sort((a, b) => a.startMs - b.startMs || a.key.localeCompare(b.key));
  return {
    events: out.filter((e) => !e.cancelled),
    cancelled: out.filter((e) => e.cancelled),
    warnings,
    calendarName: getText(cal, 'X-WR-CALNAME'),
    timeZone: tz,
    veventCount: vevents.length,
  };
}

/**
 * Checks a downloaded feed before anything is changed. Throws a readable error if the
 * download is an error page or contains no events.
 */
export function parseFeedStrict(text: string, opts: ParseOptions = {}): ParseResult {
  if (!text || !text.includes('BEGIN:VCALENDAR')) {
    throw new IcsError('TUMonline did not return a calendar (maybe an error page or an expired link).');
  }
  const r = parseCalendar(text, opts);
  if (r.veventCount === 0) throw new IcsError('The calendar contains 0 events.');
  return r;
}
