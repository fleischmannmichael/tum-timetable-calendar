/**
 * The sync engine that runs inside Google Apps Script. All Google/Apps Script access goes
 * through the `Env` interface (see env.ts for the real one), so the whole flow is tested
 * with a fake calendar in tests/engine.test.ts.
 */
import { parseFeedStrict } from '../core/calendar';
import { detect } from '../core/detect';
import { diffEvents, toGoogleBody, type ManagedEvent } from '../core/diff';
import { ensureCourseColors, resolve, resultHash, type DesiredEvent } from '../core/resolve';
import type { Settings } from '../core/settings';
import { localParts } from '../core/time';
import {
  BATCH_SIZE, BATCH_URL, buildBatchBody, errorMessage, isRetryable, parseBatchResponse, type BatchRequest,
} from './batch';

export interface HttpRequest {
  url: string;
  method: 'get' | 'post';
  contentType?: string;
  payload?: string;
}

export interface HttpResponse {
  code: number;
  text: string;
  contentType: string;
}

export interface CalendarInfo {
  id: string;
  summary: string;
  primary?: boolean;
}

export interface Env {
  /** Plain HTTP. Requests to googleapis.com carry the user's OAuth token; others don't. */
  http(req: HttpRequest): HttpResponse;
  getProp(key: string): string | null;
  setProp(key: string, value: string): void;
  deleteProp(key: string): void;
  now(): number;
  sleep(ms: number): void;
  log(msg: string): void;
  calendar: {
    listManaged(calendarId: string): ManagedEvent[];
    listAll(calendarId: string): ManagedEvent[];
    get(calendarId: string): CalendarInfo | null;
    list(): CalendarInfo[];
    create(name: string, timeZone: string): string;
  };
  triggers: {
    list(handler: string): string[];
    remove(id: string): void;
    createEveryHours(handler: string, hours: number): void;
  };
  lock(): boolean;
  unlock(): void;
}

export const PROP_LINK = 'TUM_ICAL_URL';
export const PROP_CALENDAR = 'CALENDAR_ID';
export const PROP_LAST_HASH = 'LAST_RESULT_HASH';
export const PROP_FEED_FAIL_SINCE = 'FEED_FAIL_SINCE';
export const AUTO_HANDLER = 'autoSync';

/** Apps Script stops scripts after 6 minutes; stop starting new work well before that. */
export const TIME_BUDGET_MS = 4.5 * 60 * 1000;

export type RunStatus = 'ok' | 'unchanged' | 'dry-run' | 'incomplete' | 'aborted';

export interface RunReport {
  status: RunStatus;
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
  failed: string[];
  notRun: number;
  attention: number;
  message: string;
}

export interface RunOptions {
  dryRun?: boolean;
  /** Started by the user (not by the hourly trigger). Manual runs skip the mass-delete guard. */
  manual?: boolean;
  /** Ignore the "nothing changed" shortcut. */
  force?: boolean;
}

export class SyncError extends Error {}

function fmt(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  return `${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][p.weekday - 1]} ${p.date} ${p.time}`;
}

const eventsPath = (calId: string) => `/calendar/v3/calendars/${encodeURIComponent(calId)}/events`;

// ------------------------------------------------------------------ setup helpers

export function setLink(env: Env, link: string): void {
  const l = (link || '').trim();
  if (!l || l.includes('PASTE_')) throw new SyncError('Paste your TUMonline iCal link between the quotes first, then run setLink again.');
  if (!/^https:\/\//.test(l)) throw new SyncError('The link must start with https://');
  const res = env.http({ url: l, method: 'get' });
  if (res.code !== 200) throw new SyncError(`TUMonline answered HTTP ${res.code}. Check the link (or create a new one in TUMonline). Nothing was saved.`);
  const parsed = parseFeedStrict(res.text);
  env.setProp(PROP_LINK, l);
  env.deleteProp(PROP_LAST_HASH);
  env.log(`Link saved privately in your Script/User Properties (${parsed.events.length} events found).`);
  env.log('IMPORTANT: now delete the link from the code (leave the quotes empty) and save.');
}

export function resolveCalendarId(env: Env, settings: Settings): string | null {
  return settings.target.calendarId || env.getProp(PROP_CALENDAR);
}

export function createCalendar(env: Env, settings: Settings): string {
  const id = env.calendar.create(settings.target.newCalendarName || 'TUM Stundenplan', settings.timeZone);
  env.setProp(PROP_CALENDAR, id);
  env.deleteProp(PROP_LAST_HASH);
  env.log(`Created calendar "${settings.target.newCalendarName}". ID: ${id}`);
  return id;
}

export function listCalendars(env: Env): void {
  for (const c of env.calendar.list()) env.log(`${c.primary ? '[primary] ' : ''}${c.summary}\n    ID: ${c.id}`);
}

export function setupAutoSync(env: Env, settings: Settings): void {
  for (const id of env.triggers.list(AUTO_HANDLER)) env.triggers.remove(id);
  const hours = Math.max(1, Math.min(24, Math.round(settings.autoSync.everyHours || 1)));
  env.triggers.createEveryHours(AUTO_HANDLER, hours);
  env.log(`Automatic sync is on: every ${hours} hour(s). Your other triggers were not touched.`);
}

export function stopAutoSync(env: Env): void {
  const ids = env.triggers.list(AUTO_HANDLER);
  ids.forEach((id) => env.triggers.remove(id));
  env.log(ids.length ? 'Automatic sync is off.' : 'Automatic sync was not on.');
}

export function checkSetup(env: Env, settings: Settings): void {
  env.log(env.getProp(PROP_LINK) ? '✔ TUMonline link is saved.' : '✘ No TUMonline link yet: run setLink.');
  const calId = resolveCalendarId(env, settings);
  if (!calId) env.log('• No target calendar yet: the first syncNow creates "' + settings.target.newCalendarName + '".');
  else {
    const cal = env.calendar.get(calId);
    env.log(cal ? `✔ Target calendar: ${cal.summary}` : `✘ Target calendar ${calId} not found or no access.`);
  }
  env.log(env.triggers.list(AUTO_HANDLER).length ? '✔ Automatic sync is on.' : '• Automatic sync is off (run setupAutoSync to turn it on).');
}

// ------------------------------------------------------------------ batch execution

interface Op {
  kind: 'create' | 'update' | 'delete';
  req: BatchRequest;
  label: string;
}

interface BatchOutcome {
  ok: number;
  failed: string[];
  notRun: Op[];
}

function sendBatch(env: Env, ops: Op[]): Array<{ status: number; body: unknown }> {
  const boundary = 'batch_tumcal_' + Math.floor(env.now()).toString(36) + '_' + Math.random().toString(36).slice(2);
  try {
    const res = env.http({
      url: BATCH_URL,
      method: 'post',
      contentType: `multipart/mixed; boundary=${boundary}`,
      payload: buildBatchBody(ops.map((o) => o.req), boundary),
    });
    if (res.code !== 200) return ops.map(() => ({ status: res.code >= 500 || res.code === 429 ? 0 : res.code, body: res.text }));
    return parseBatchResponse(res.text, res.contentType, ops.length);
  } catch (e) {
    return ops.map(() => ({ status: 0, body: String(e) }));
  }
}

/** Runs operations in batches of 50, retrying temporary failures with backoff. */
export function executeOps(env: Env, ops: Op[], deadline: number): BatchOutcome {
  let pending = ops;
  let ok = 0;
  const failed: string[] = [];
  for (let attempt = 0; attempt < 5 && pending.length; attempt++) {
    if (attempt > 0) env.sleep(Math.min(16000, 1000 * 2 ** (attempt - 1)));
    const retry: Op[] = [];
    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      if (env.now() > deadline) {
        return { ok, failed, notRun: [...retry, ...pending.slice(i)] };
      }
      const chunk = pending.slice(i, i + BATCH_SIZE);
      const results = sendBatch(env, chunk);
      chunk.forEach((op, j) => {
        const { status, body } = results[j];
        if ((status >= 200 && status < 300) || (op.kind === 'delete' && (status === 404 || status === 410))) ok++;
        else if (isRetryable(status, body) && attempt < 4) retry.push(op);
        else failed.push(`${op.kind} "${op.label}": HTTP ${status || 'no answer'} ${errorMessage(body)}`.trim());
      });
    }
    pending = retry;
  }
  return { ok, failed, notRun: [] };
}

// ------------------------------------------------------------------ the sync

function emptyReport(status: RunStatus, message: string): RunReport {
  return { status, created: 0, updated: 0, deleted: 0, unchanged: 0, failed: [], notRun: 0, attention: 0, message };
}

function fetchFeed(env: Env, link: string, manual: boolean): string | null {
  let res: HttpResponse;
  try {
    res = env.http({ url: link, method: 'get' });
  } catch (e) {
    return feedFailure(env, manual, `TUMonline not reachable (${(e as Error).message}).`);
  }
  if (res.code !== 200) return feedFailure(env, manual, `TUMonline answered HTTP ${res.code}.`);
  if (!res.text.includes('BEGIN:VCALENDAR')) return feedFailure(env, manual, 'TUMonline returned no calendar (error page?).');
  env.deleteProp(PROP_FEED_FAIL_SINCE);
  return res.text;
}

/** Automatic runs tolerate short TUMonline outages quietly; after 24 h (or when run by hand) they fail loudly. */
function feedFailure(env: Env, manual: boolean, why: string): null {
  const msg = `${why} Nothing was changed.`;
  if (manual) throw new SyncError(msg + ' If this keeps happening, create a new iCal link in TUMonline and run setLink.');
  const since = Number(env.getProp(PROP_FEED_FAIL_SINCE) || 0);
  if (!since) env.setProp(PROP_FEED_FAIL_SINCE, String(env.now()));
  else if (env.now() - since > 24 * 3600 * 1000) throw new SyncError(msg + ' TUMonline has failed for over 24 hours; check your link.');
  env.log(msg + ' Will try again next run.');
  return null;
}

export function run(env: Env, settings: Settings, opts: RunOptions = {}): RunReport {
  const started = env.now();
  const deadline = started + TIME_BUDGET_MS;
  if (!env.lock()) {
    env.log('Another sync is still running. Skipped.');
    return emptyReport('aborted', 'locked');
  }
  try {
    return runLocked(env, settings, opts, deadline);
  } finally {
    env.unlock();
  }
}

function runLocked(env: Env, settings: Settings, opts: RunOptions, deadline: number): RunReport {
  const tz = settings.timeZone;
  const link = env.getProp(PROP_LINK);
  if (!link) throw new SyncError('No TUMonline link saved yet. Paste it into setLink() and run setLink first.');

  // 1. Download and parse. Any problem here → nothing is changed.
  const text = fetchFeed(env, link, !!opts.manual);
  if (text === null) return emptyReport('aborted', 'feed unavailable');
  const parsed = parseFeedStrict(text, { defaultTimeZone: tz });
  parsed.warnings.forEach((w) => env.log('Note: ' + w));

  // 2. Apply settings.
  const detection = detect(parsed.events, settings);
  ensureCourseColors(detection, settings);
  const { desired, skipped } = resolve(detection, settings, env.now());
  const attention = desired.filter((d) => d.attention.length);

  // 3. Target calendar.
  let calId = resolveCalendarId(env, settings);
  if (calId && !env.calendar.get(calId)) {
    throw new SyncError(`Target calendar not found or no access (ID ${calId}). Nothing was changed. Run listMyCalendars to see your calendar IDs.`);
  }
  const hash = resultHash(desired, calId ?? '(new)');
  if (!opts.dryRun && !opts.force && calId && env.getProp(PROP_LAST_HASH) === hash) {
    env.log(`No changes since the last sync (${desired.length} events). Nothing to do.`);
    return { ...emptyReport('unchanged', 'no changes'), unchanged: desired.length, attention: attention.length };
  }

  const existing = calId ? env.calendar.listManaged(calId) : [];
  const diff = diffEvents(desired, existing);

  env.log(
    `${opts.dryRun ? 'PREVIEW (nothing is changed): ' : ''}${desired.length} events from TUMonline ` +
      `(${skipped.length} skipped). To create: ${diff.create.length}, to update: ${diff.update.length}, ` +
      `to delete: ${diff.remove.length}, unchanged: ${diff.unchanged}.`,
  );
  if (attention.length) {
    env.log(`${attention.length} event(s) need attention (open the web tool's preview to fix them):`);
    for (const a of attention.slice(0, 20)) env.log(`  ${fmt(a.source.startMs, tz)}  ${a.source.summary}  → ${a.attention.join('; ')}`);
  }

  if (opts.dryRun) {
    const show = (label: string, lines: string[]) => {
      if (!lines.length) return;
      env.log(`${label}:`);
      lines.slice(0, 25).forEach((l) => env.log('  ' + l));
      if (lines.length > 25) env.log(`  … and ${lines.length - 25} more`);
    };
    show('Would create', diff.create.map((x) => `${fmt(x.source.startMs, tz)}  ${x.summary}`));
    show('Would update', diff.update.map((u) => `${fmt(u.event.source.startMs, tz)}  ${u.event.summary}`));
    show('Would delete', diff.remove.map((r) => r.summary ?? r.id));
    return {
      ...emptyReport('dry-run', 'preview only'),
      created: diff.create.length, updated: diff.update.length, deleted: diff.remove.length,
      unchanged: diff.unchanged, attention: attention.length,
    };
  }

  // 4. Safety: an automatic run must not wipe out most of the calendar.
  const frac = settings.safety.maxDeleteFraction;
  if (!opts.manual && existing.length >= 10 && diff.remove.length > frac * existing.length) {
    throw new SyncError(
      `Safety stop: this run would delete ${diff.remove.length} of ${existing.length} events. Nothing was changed. ` +
        'If that is really intended (e.g. new semester), run syncNow by hand.',
    );
  }

  if (!calId) calId = createCalendar(env, settings);
  const path = eventsPath(calId);
  const label = (d: DesiredEvent) => `${d.summary} (${fmt(d.source.startMs, tz)})`;

  // 5. Write: create/update first, delete last (a failure never leaves the calendar half empty).
  const writes: Op[] = [
    ...diff.create.map((d): Op => ({ kind: 'create', req: { method: 'POST', path, body: toGoogleBody(d) }, label: label(d) })),
    ...diff.update.map((u): Op => ({
      kind: 'update', req: { method: 'PUT', path: `${path}/${encodeURIComponent(u.id)}`, body: toGoogleBody(u.event) }, label: label(u.event),
    })),
  ];
  const w = executeOps(env, writes, deadline);
  let d: BatchOutcome = { ok: 0, failed: [], notRun: [] };
  const deletes: Op[] = diff.remove.map((r) => ({
    kind: 'delete', req: { method: 'DELETE', path: `${path}/${encodeURIComponent(r.id)}` }, label: r.summary ?? r.id,
  }));
  if (!w.notRun.length) d = executeOps(env, deletes, deadline);
  else d.notRun = deletes;

  const failed = [...w.failed, ...d.failed];
  const notRun = w.notRun.length + d.notRun.length;
  const created = writes.filter((o) => o.kind === 'create').length;
  const report: RunReport = {
    status: failed.length || notRun ? 'incomplete' : 'ok',
    created: Math.min(created, w.ok),
    updated: Math.max(0, w.ok - created),
    deleted: d.ok,
    unchanged: diff.unchanged,
    failed,
    notRun,
    attention: attention.length,
    message: '',
  };

  if (report.status === 'ok') {
    env.setProp(PROP_LAST_HASH, resultHash(desired, calId));
    report.message = `Done: created ${diff.create.length}, updated ${diff.update.length}, deleted ${d.ok}, unchanged ${diff.unchanged}.`;
    env.log(report.message);
    return report;
  }
  env.deleteProp(PROP_LAST_HASH); // next run retries everything that is still different
  failed.slice(0, 30).forEach((f) => env.log('FAILED ' + f));
  report.message =
    `Sync NOT complete: ${w.ok + d.ok} changes done, ${failed.length} failed` +
    (notRun ? `, ${notRun} not attempted (time limit; the next run continues)` : '') + '.';
  env.log(report.message);
  throw new SyncError(report.message);
}

// ------------------------------------------------------------------ clean-up

/** Deletes only events this tool created (marked with the private property). */
export function removeMyEvents(env: Env, settings: Settings): number {
  const calId = resolveCalendarId(env, settings);
  if (!calId) throw new SyncError('No target calendar configured.');
  const mine = env.calendar.listManaged(calId);
  const ops: Op[] = mine.map((m) => ({ kind: 'delete', req: { method: 'DELETE', path: `${eventsPath(calId)}/${encodeURIComponent(m.id)}` }, label: m.summary ?? m.id }));
  const r = executeOps(env, ops, env.now() + TIME_BUDGET_MS);
  env.deleteProp(PROP_LAST_HASH);
  env.log(`Deleted ${r.ok} of ${mine.length} events created by this tool.`);
  if (r.failed.length || r.notRun.length) throw new SyncError(`${r.failed.length + r.notRun.length} could not be deleted; run again.`);
  return r.ok;
}

export const DELETE_ALL_CONFIRMATION = 'YES DELETE ALL';

/**
 * Deletes EVERY event in the target calendar, including ones this tool didn't create
 * (e.g. leftovers from older scripts without markers). Refuses to touch the primary calendar.
 */
export function deleteEverythingInCalendar(env: Env, settings: Settings, confirmation: string): number {
  if (confirmation !== DELETE_ALL_CONFIRMATION) {
    throw new SyncError(`This deletes ALL events in the target calendar. To confirm, set CONFIRM = "${DELETE_ALL_CONFIRMATION}" and run again.`);
  }
  const calId = resolveCalendarId(env, settings);
  if (!calId) throw new SyncError('No target calendar configured.');
  const cal = env.calendar.get(calId);
  if (!cal) throw new SyncError('Target calendar not found.');
  if (cal.primary || calId === 'primary') throw new SyncError('Refusing to empty your primary (main) calendar. Use a separate calendar for the timetable.');
  const all = env.calendar.listAll(calId);
  const ops: Op[] = all.map((m) => ({ kind: 'delete', req: { method: 'DELETE', path: `${eventsPath(calId)}/${encodeURIComponent(m.id)}` }, label: m.summary ?? m.id }));
  const r = executeOps(env, ops, env.now() + TIME_BUDGET_MS);
  env.deleteProp(PROP_LAST_HASH);
  env.log(`Deleted ${r.ok} of ${all.length} events in "${cal.summary}".`);
  if (r.failed.length || r.notRun.length) throw new SyncError(`${r.failed.length + r.notRun.length} could not be deleted; run again.`);
  return r.ok;
}
