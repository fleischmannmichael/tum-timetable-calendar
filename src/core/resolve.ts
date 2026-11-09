/**
 * Applies the user's settings to detected events and produces the events that should exist
 * in Google Calendar. Precedence (strongest first):
 *   single-event edit  >  "all like this" rule  >  course settings  >  detection
 */
import type { DetectedEvent, Detection } from './detect';
import { groupIdOf } from './detect';
import type { EventChange, Settings, SlotRule } from './settings';
import { suggestColors } from './colors';
import { localParts } from './time';
import { hash, stableStringify } from './text';

export type SkipReason = 'outside-window' | 'cancel-word' | 'course-off' | 'type-hidden' | 'removed';

export interface GoogleTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

export interface DesiredEvent {
  key: string;
  summary: string;
  description: string;
  location: string;
  colorId?: string;
  start: GoogleTime;
  end: GoogleTime;
  /** Hash of everything written to Google; a different hash means "update". */
  hash: string;
  typeId: string | null;
  courseId: string | null;
  groupId: string;
  weekday: number;
  /** Local start "HH:MM", or "all-day". */
  time: string;
  /** Reasons the user should look at this event. Empty = fine. */
  attention: string[];
  /** Which levels changed this event (for the editor). */
  changedBy: { edit: boolean; rule: boolean };
  source: DetectedEvent;
}

export interface SkippedEvent {
  source: DetectedEvent;
  reason: SkipReason;
  detail?: string;
  /** What the event would look like if it weren't skipped (for "show hidden" in the preview). */
  preview?: DesiredEvent;
}

export interface Resolution {
  desired: DesiredEvent[];
  skipped: SkippedEvent[];
}

export interface ResolveOptions {
  /** Leave out the single-event edit / matching rule (used by the editor to compute "defaults"). */
  ignoreEdit?: boolean;
  ignoreRule?: boolean;
}

const DAY = 86400000;
const ROOM_CODE = /\((\d{4}\.[A-Z0-9]{2,3}\.[A-Z0-9]{2,5})\)/i;

/** Fills a title template and tidies separators left over from empty placeholders. */
export function renderTemplate(template: string, values: Record<string, string>): string {
  let s = template.replace(/\{(\w+)\}/g, (all, k: string) => (k in values ? values[k] : all));
  s = s.replace(/[ \t]+/g, ' ');
  // "· Analysis" or "VL ·" or "VL ·  · X" → drop the dangling separators
  s = s.replace(/(\s*[·|•–—:-]\s*){2,}/g, (m) => m.match(/\s*[·|•–—:-]\s*/)![0]);
  s = s.replace(/^[\s·|•–—:,-]+|[\s·|•–—:,-]+$/g, '');
  s = s.replace(/\(\s*\)|\[\s*\]/g, '').replace(/\s+/g, ' ').trim();
  return s;
}

export function findRule(rules: SlotRule[], groupId: string, weekday: number, time: string): SlotRule | undefined {
  return rules.find((r) => r.groupId === groupId && r.weekday === weekday && r.time === time);
}

/** Gives every detected course a distinct default colour (only those without one). */
export function ensureCourseColors(detection: Detection, settings: Settings): { reused: boolean } {
  const ids = detection.courses.map((c) => c.id);
  const existing: Record<string, string | undefined> = {};
  for (const id of Object.keys(settings.courses)) existing[id] = settings.courses[id].color;
  const { colors, reused } = suggestColors(ids, existing);
  for (const [id, color] of Object.entries(colors)) {
    settings.courses[id] = { ...(settings.courses[id] ?? {}), color };
  }
  const enabled = detection.courses.filter((c) => settings.courses[c.id]?.enabled !== false).length;
  return { reused: reused || enabled > 11 };
}

export function buildDescription(e: DetectedEvent, settings: Settings, location: string): string {
  const parts: string[] = [];
  if (e.description) parts.push(e.description);
  parts.push(`TUMonline: ${e.summary}`);
  if (settings.addRoomLink) {
    const m = ROOM_CODE.exec(location);
    if (m && !/nav\.tum\.de\/room/.test(e.description)) parts.push(`Room: https://nav.tum.de/room/${m[1]}`);
  }
  if (e.url) parts.push(e.url);
  return parts.join('\n\n');
}

export function resolveEvent(
  e: DetectedEvent,
  settings: Settings,
  opts: ResolveOptions = {},
): { event: DesiredEvent; skip?: { reason: SkipReason; detail?: string } } {
  const tz = settings.timeZone;
  const lp = localParts(e.startMs, tz);
  const weekday = e.allDay && e.startDate ? localParts(Date.parse(e.startDate + 'T12:00:00Z'), 'UTC').weekday : lp.weekday;
  const time = e.allDay ? 'all-day' : lp.time;
  const groupId = groupIdOf(e);

  const rule = opts.ignoreRule ? undefined : findRule(settings.rules, groupId, weekday, time);
  const edit = opts.ignoreEdit ? undefined : settings.eventEdits[e.key];
  const change: EventChange = { ...(rule?.set ?? {}), ...(edit ?? {}) };

  const typeId = change.typeId || e.typeId;
  const cs = (e.courseId && settings.courses[e.courseId]) || {};
  const typeDef = settings.types.find((t) => t.id === typeId);
  const typeLabel = typeId ? (cs.typeLabels?.[typeId] ?? typeDef?.label ?? '') : '';
  const courseName = cs.name?.trim() || e.courseName || '';
  const location = change.location ?? e.location;

  const summary =
    change.title?.trim() ||
    (e.courseId
      ? renderTemplate(settings.titleTemplate, {
          type: typeLabel,
          course: courseName,
          group: e.group ?? '',
          code: e.moduleCode ?? '',
          original: e.summary,
          location,
        }) || e.summary
      : e.summary);

  const attention: string[] = [];
  if (!e.courseId) attention.push('Course not recognised');
  if (!typeId) attention.push('Event type not recognised');
  else if (!typeDef) attention.push(`Unknown type "${typeId}"`);
  attention.push(...e.warnings);

  const colorId = change.colorId ?? cs.color;
  const start: GoogleTime = e.allDay ? { date: e.startDate } : { dateTime: new Date(e.startMs).toISOString(), timeZone: tz };
  const end: GoogleTime = e.allDay ? { date: e.endDate } : { dateTime: new Date(e.endMs).toISOString(), timeZone: tz };
  const description = buildDescription(e, settings, location);
  const body = { summary, description, location, colorId: colorId ?? null, start, end };

  const event: DesiredEvent = {
    key: e.key,
    summary,
    description,
    location,
    colorId,
    start,
    end,
    hash: hash(stableStringify(body)),
    typeId: typeId ?? null,
    courseId: e.courseId,
    groupId,
    weekday,
    time,
    attention,
    changedBy: { edit: !!edit && Object.keys(edit).length > 0, rule: !!rule },
    source: e,
  };

  if (change.remove) return { event, skip: { reason: 'removed', detail: edit?.remove ? 'removed (this event)' : 'removed (all like this)' } };
  if (e.cancelWord) return { event, skip: { reason: 'cancel-word', detail: `title/description contains "${e.cancelWord}"` } };
  if (e.courseId && cs.enabled === false) return { event, skip: { reason: 'course-off' } };
  if (typeId && cs.hiddenTypes?.includes(typeId)) return { event, skip: { reason: 'type-hidden', detail: typeDef?.name ?? typeId } };
  return { event };
}

export function resolve(detection: Detection, settings: Settings, nowMs: number): Resolution {
  const desired: DesiredEvent[] = [];
  const skipped: SkippedEvent[] = [];
  const from = nowMs - settings.window.daysBack * DAY;
  const to = settings.window.daysAhead === null ? Infinity : nowMs + settings.window.daysAhead * DAY;
  for (const e of detection.events) {
    if (e.endMs < from || e.startMs > to) {
      skipped.push({ source: e, reason: 'outside-window' });
      continue;
    }
    const r = resolveEvent(e, settings);
    if (r.skip) skipped.push({ source: e, reason: r.skip.reason, detail: r.skip.detail, preview: r.event });
    else desired.push(r.event);
  }
  return { desired, skipped };
}

/** Hash over everything that would be written, plus the target calendar. Same hash = nothing to do. */
export function resultHash(desired: DesiredEvent[], calendarId: string): string {
  return hash(calendarId + '|' + desired.map((d) => d.key + '=' + d.hash).sort().join(','));
}
