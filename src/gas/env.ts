/**
 * The real Apps Script environment. Only this file touches Apps Script globals.
 *
 * The iCal link and state are stored in *User* Properties: private to the Google account
 * that runs the script, not visible to other people who might get edit access to it.
 */
import type { ManagedEvent } from '../core/diff';
import { KEY_PROP, HASH_PROP, MARKER } from '../core/diff';
import type { CalendarInfo, Env, HttpRequest, HttpResponse } from './engine';
import { SyncError } from './engine';

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const UrlFetchApp: any;
declare const PropertiesService: any;
declare const ScriptApp: any;
declare const Utilities: any;
declare const LockService: any;
declare const Calendar: any;

function calendarService(): any {
  if (typeof Calendar === 'undefined') {
    throw new SyncError(
      'The "Google Calendar API" service is not added. In the Apps Script editor: Services (+) → Google Calendar API → Add. Then run again.',
    );
  }
  return Calendar;
}

function listEvents(calendarId: string, extra: Record<string, unknown>): ManagedEvent[] {
  const out: ManagedEvent[] = [];
  let pageToken: string | undefined;
  do {
    const res = calendarService().Events.list(calendarId, {
      maxResults: 2500,
      showDeleted: false,
      pageToken,
      fields: 'nextPageToken,items(id,summary,status,extendedProperties)',
      ...extra,
    });
    for (const it of res.items ?? []) {
      if (it.status === 'cancelled') continue;
      const p = it.extendedProperties?.private ?? {};
      out.push({ id: it.id, key: p[KEY_PROP], hash: p[HASH_PROP], summary: it.summary });
    }
    pageToken = res.nextPageToken;
  } while (pageToken);
  return out;
}

let scriptLock: any = null;

export function realEnv(): Env {
  const props = PropertiesService.getUserProperties();
  return {
    http(req: HttpRequest): HttpResponse {
      const headers: Record<string, string> = {};
      if (req.url.startsWith('https://www.googleapis.com/')) headers.Authorization = 'Bearer ' + ScriptApp.getOAuthToken();
      const res = UrlFetchApp.fetch(req.url, {
        method: req.method,
        contentType: req.contentType,
        payload: req.payload !== undefined ? Utilities.newBlob(req.payload).getBytes() : undefined,
        headers,
        muteHttpExceptions: true,
        followRedirects: true,
      });
      const h = res.getHeaders() ?? {};
      return {
        code: res.getResponseCode(),
        text: res.getContentText('UTF-8'),
        contentType: String(h['Content-Type'] ?? h['content-type'] ?? ''),
      };
    },
    getProp: (k) => props.getProperty(k),
    setProp: (k, v) => props.setProperty(k, v),
    deleteProp: (k) => props.deleteProperty(k),
    now: () => Date.now(),
    sleep: (ms) => Utilities.sleep(ms),
    log: (m) => console.log(m),
    calendar: {
      listManaged: (id) => listEvents(id, { privateExtendedProperty: `${MARKER}=1` }),
      listAll: (id) => listEvents(id, { singleEvents: false }),
      get(id): CalendarInfo | null {
        const cal = calendarService();
        try {
          const e = cal.CalendarList.get(id);
          return { id: e.id, summary: e.summaryOverride || e.summary, primary: !!e.primary };
        } catch {
          try {
            const c = cal.Calendars.get(id);
            return { id: c.id, summary: c.summary, primary: false };
          } catch {
            return null;
          }
        }
      },
      list(): CalendarInfo[] {
        const res = calendarService().CalendarList.list({ maxResults: 250, minAccessRole: 'writer' });
        return (res.items ?? []).map((e: any) => ({ id: e.id, summary: e.summaryOverride || e.summary, primary: !!e.primary }));
      },
      create(name, timeZone): string {
        return calendarService().Calendars.insert({ summary: name, timeZone }).id;
      },
    },
    triggers: {
      list: (handler) =>
        ScriptApp.getProjectTriggers()
          .filter((t: any) => t.getHandlerFunction() === handler)
          .map((t: any) => t.getUniqueId()),
      remove(id) {
        for (const t of ScriptApp.getProjectTriggers()) if (t.getUniqueId() === id) ScriptApp.deleteTrigger(t);
      },
      createEveryHours(handler, hours) {
        ScriptApp.newTrigger(handler).timeBased().everyHours(hours).create();
      },
    },
    lock() {
      scriptLock = LockService.getUserLock();
      return scriptLock.tryLock(10000);
    },
    unlock() {
      try { scriptLock?.releaseLock(); } catch { /* ignore */ }
    },
  };
}

/** Uses Utilities.formatDate for time zones if this runtime's Intl has no zone data. */
export function utilitiesOffset(utcMs: number, tz: string): number {
  const s: string = Utilities.formatDate(new Date(utcMs), tz, "yyyy-MM-dd'T'HH:mm:ss");
  return Date.parse(s + 'Z') - Math.floor(utcMs / 1000) * 1000;
}
