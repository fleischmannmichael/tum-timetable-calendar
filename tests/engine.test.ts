import { describe, expect, it } from 'vitest';
import { BATCH_URL, buildBatchBody, parseBatchResponse } from '../src/gas/batch';
import {
  deleteEverythingInCalendar, removeMyEvents, run, setLink, setupAutoSync, SyncError,
  PROP_CALENDAR, PROP_LINK, type Env, type HttpRequest,
} from '../src/gas/engine';
import { defaultSettings, type Settings } from '../src/core/settings';
import { SAMPLE } from './helpers';

const LINK = 'https://campus.tum.de/tumonlinej/ws/termin/ical?pStud=TEST&pToken=TEST';
const NOW = Date.UTC(2026, 9, 1);

interface StoredEvent {
  id: string;
  summary?: string;
  location?: string;
  extendedProperties?: { private?: Record<string, string> };
  [k: string]: unknown;
}

/** In-memory stand-in for Apps Script + Google Calendar. */
class FakeEnv implements Env {
  props = new Map<string, string>();
  logs: string[] = [];
  calendars = new Map<string, { summary: string; primary: boolean; events: Map<string, StoredEvent> }>();
  feed = { code: 200, text: SAMPLE };
  t = NOW;
  tickPerHttp = 0;
  batchCalls = 0;
  nextId = 1;
  triggerList: Array<{ id: string; handler: string }> = [];
  /** Return a status to inject for a batch item (attempt counts per item path+body). */
  inject: (method: string, body: StoredEvent | undefined, attempt: number) => number | undefined = () => undefined;
  private attempts = new Map<string, number>();

  constructor() {
    this.calendars.set('me@example.com', { summary: 'Me', primary: true, events: new Map() });
  }

  http(req: HttpRequest) {
    this.t += this.tickPerHttp;
    if (req.url === LINK) return { code: this.feed.code, text: this.feed.text, contentType: 'text/calendar' };
    if (req.url === BATCH_URL) return this.batch(req);
    return { code: 404, text: 'not found', contentType: 'text/plain' };
  }

  private batch(req: HttpRequest) {
    this.batchCalls++;
    const boundary = /boundary=(\S+)/.exec(req.contentType!)![1];
    const parts = req.payload!.split('--' + boundary).filter((p) => p.includes('Content-ID'));
    expect(parts.length).toBeLessThanOrEqual(50);
    let out = '';
    for (const part of parts) {
      const idx = /<item(\d+)>/.exec(part)![1];
      const [, method, path] = /(POST|PUT|DELETE|PATCH) (\S+) HTTP\/1\.1/.exec(part)!;
      const jsonStart = part.indexOf('{');
      const body = jsonStart >= 0 ? (JSON.parse(part.slice(jsonStart).trim()) as StoredEvent) : undefined;
      const [, calEnc, , evEnc] = /\/calendars\/([^/]+)\/events(\/(.+))?$/.exec(path)!;
      const cal = this.calendars.get(decodeURIComponent(calEnc))!;
      const attemptKey = method + path + (body?.extendedProperties?.private?.tumcalKey ?? '');
      const attempt = (this.attempts.get(attemptKey) ?? 0) + 1;
      this.attempts.set(attemptKey, attempt);
      let status = this.inject(method, body, attempt) ?? 200;
      let resBody: unknown = {};
      if (status === 200) {
        if (method === 'POST') {
          const id = 'ev' + this.nextId++;
          cal.events.set(id, { ...body!, id });
          resBody = { id };
        } else if (method === 'PUT') {
          const id = decodeURIComponent(evEnc);
          if (!cal.events.has(id)) status = 404;
          else cal.events.set(id, { ...body!, id });
        } else if (method === 'DELETE') {
          const id = decodeURIComponent(evEnc);
          if (!cal.events.delete(id)) status = 410;
          else status = 204;
        }
      } else {
        resBody = { error: { message: 'injected', errors: [{ reason: status === 403 ? 'rateLimitExceeded' : 'invalid' }] } };
      }
      // answer out of order to prove we match by Content-ID
      out = `--resp\r\nContent-Type: application/http\r\nContent-ID: <response-item${idx}>\r\n\r\nHTTP/1.1 ${status} X\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(resBody)}\r\n` + out;
    }
    return { code: 200, text: out + '--resp--', contentType: 'multipart/mixed; boundary=resp' };
  }

  getProp = (k: string) => this.props.get(k) ?? null;
  setProp = (k: string, v: string) => void this.props.set(k, v);
  deleteProp = (k: string) => void this.props.delete(k);
  now = () => this.t;
  sleep = (ms: number) => { this.t += ms; };
  log = (m: string) => void this.logs.push(m);
  lock = () => true;
  unlock = () => {};

  calendar = {
    listManaged: (id: string) => [...this.calendars.get(id)!.events.values()]
      .filter((e) => e.extendedProperties?.private?.tumcal === '1')
      .map((e) => ({ id: e.id, key: e.extendedProperties!.private!.tumcalKey, hash: e.extendedProperties!.private!.tumcalHash, summary: e.summary })),
    listAll: (id: string) => [...this.calendars.get(id)!.events.values()].map((e) => ({ id: e.id, summary: e.summary })),
    get: (id: string) => {
      const c = this.calendars.get(id);
      return c ? { id, summary: c.summary, primary: c.primary } : null;
    },
    list: () => [...this.calendars.entries()].map(([id, c]) => ({ id, summary: c.summary, primary: c.primary })),
    create: (name: string) => {
      const id = `cal${this.calendars.size}@group.calendar.google.com`;
      this.calendars.set(id, { summary: name, primary: false, events: new Map() });
      return id;
    },
  };

  triggers = {
    list: (h: string) => this.triggerList.filter((t) => t.handler === h).map((t) => t.id),
    remove: (id: string) => { this.triggerList = this.triggerList.filter((t) => t.id !== id); },
    createEveryHours: (h: string) => { this.triggerList.push({ id: 't' + this.nextId++, handler: h }); },
  };

  events(calId = this.props.get(PROP_CALENDAR)!) {
    return [...this.calendars.get(calId)!.events.values()];
  }
}

function makeEnv(): FakeEnv {
  const env = new FakeEnv();
  env.props.set(PROP_LINK, LINK);
  return env;
}

const settings = (): Settings => defaultSettings();
const removeEvent = (text: string, uid: string) => text.replace(new RegExp(`BEGIN:VEVENT\\r\\nUID:${uid}[\\s\\S]*?END:VEVENT\\r\\n`), '');

describe('batch format', () => {
  it('builds multipart requests and matches responses by Content-ID', () => {
    const body = buildBatchBody([{ method: 'POST', path: '/x', body: { a: 'ü' } }, { method: 'DELETE', path: '/y' }], 'B');
    expect(body).toContain('Content-ID: <item1>');
    expect(body).toContain('{"a":"ü"}');
    const res = '--R\r\nContent-ID: <response-item1>\r\n\r\nHTTP/1.1 204 No Content\r\n\r\n\r\n--R\r\nContent-ID: <response-item0>\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"id":"e1"}\r\n--R--';
    expect(parseBatchResponse(res, 'multipart/mixed; boundary=R', 3)).toEqual([
      { status: 200, body: { id: 'e1' } },
      { status: 204, body: null },
      { status: 0, body: null }, // missing answer → treated as failure/retry
    ]);
  });
});

describe('sync engine with a fake Google Calendar', () => {
  it('first run creates a new calendar and all events in batches, marked as ours', () => {
    const env = makeEnv();
    const r = run(env, settings(), { manual: true });
    expect(r).toMatchObject({ status: 'ok', created: 296, updated: 0, deleted: 0 });
    expect(env.batchCalls).toBe(6); // 296 / 50
    const evs = env.events();
    expect(evs).toHaveLength(296);
    expect(evs.every((e) => e.extendedProperties?.private?.tumcal === '1')).toBe(true);
    expect(env.calendars.get(env.props.get(PROP_CALENDAR)!)!.summary).toBe('TUM Stundenplan');
  });

  it('second run is skipped by the hash; a forced run changes nothing', () => {
    const env = makeEnv();
    run(env, settings(), { manual: true });
    const calls = env.batchCalls;
    expect(run(env, settings(), {}).status).toBe('unchanged');
    expect(run(env, settings(), { manual: true, force: true })).toMatchObject({ status: 'ok', unchanged: 296, created: 0 });
    expect(env.batchCalls).toBe(calls);
  });

  it('updates moved/changed events in place and deletes vanished ones', () => {
    const env = makeEnv();
    run(env, settings(), { manual: true });
    const before = env.events();
    const firstUid = /UID:(\S+)/.exec(SAMPLE)![1];
    const secondUid = SAMPLE.match(/UID:(\S+)/g)![1].slice(4);
    env.feed.text = removeEvent(SAMPLE.replace('Hörsaal Nord (0002.01.200)', 'Hörsaal Neu (0002.01.201)'), secondUid);
    const r = run(env, settings(), {});
    expect(r.deleted).toBe(1);
    expect(r.updated).toBeGreaterThan(0);
    expect(r.created).toBe(0);
    const after = env.events();
    expect(after).toHaveLength(295);
    // same Google ids → updated in place
    const keyed = (l: StoredEvent[]) => new Map(l.map((e) => [e.extendedProperties!.private!.tumcalKey, e.id]));
    expect(keyed(after).get(firstUid)).toBe(keyed(before).get(firstUid));
  });

  it('never touches events it did not create', () => {
    const env = makeEnv();
    run(env, settings(), { manual: true });
    const cal = env.calendars.get(env.props.get(PROP_CALENDAR)!)!;
    cal.events.set('mine', { id: 'mine', summary: 'Dentist' });
    run(env, settings(), { manual: true, force: true });
    removeMyEvents(env, settings());
    expect(env.events().map((e) => e.summary)).toEqual(['Dentist']);
  });

  it('applies user settings (rename + colour) as updates', () => {
    const env = makeEnv();
    const s = settings();
    run(env, s, { manual: true }); // like the web tool, this stores a colour for every course in s
    s.courses['m:MA9001'] = { ...s.courses['m:MA9001'], name: 'Analysis', color: '8' };
    const r = run(env, s, {});
    expect(r.updated).toBe(63);
    expect(env.events().filter((e) => e.summary === 'ZÜ · Analysis' && e.colorId === '8')).toHaveLength(16);
  });

  it('aborts without changes on an error page, empty feed or missing link', () => {
    const env = makeEnv();
    run(env, settings(), { manual: true });
    const n = env.events().length;
    env.feed = { code: 200, text: '<html>Wartungsarbeiten</html>' };
    expect(() => run(env, settings(), { manual: true })).toThrow(/no calendar/);
    env.feed = { code: 503, text: '' };
    expect(() => run(env, settings(), { manual: true })).toThrow(/HTTP 503/);
    expect(run(env, settings(), {}).status).toBe('aborted'); // automatic: quiet retry next hour
    env.feed = { code: 200, text: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR' };
    expect(() => run(env, settings(), { manual: true, force: true })).toThrow(/0 events/);
    expect(env.events()).toHaveLength(n);
    env.props.delete(PROP_LINK);
    expect(() => run(env, settings(), { manual: true })).toThrow(/setLink/);
  });

  it('automatic runs fail loudly after 24 hours of TUMonline errors', () => {
    const env = makeEnv();
    env.feed = { code: 500, text: '' };
    expect(run(env, settings(), {}).status).toBe('aborted');
    env.t += 25 * 3600 * 1000;
    expect(() => run(env, settings(), {})).toThrow(/24 hours/);
  });

  it('retries rate-limited items and reports permanent failures without claiming success', () => {
    const env = makeEnv();
    let rateLimited = 0;
    env.inject = (method, body, attempt) => {
      const key = body?.extendedProperties?.private?.tumcalKey ?? '';
      if (method === 'POST' && key.endsWith('5@tum.de') && attempt === 1) { rateLimited++; return 403; }
      if (method === 'POST' && key === '900000007@tum.de') return 400; // permanent
      return undefined;
    };
    expect(() => run(env, settings(), { manual: true })).toThrow(SyncError);
    expect(rateLimited).toBeGreaterThan(0);
    expect(env.events()).toHaveLength(295); // all but the permanently failing one
    expect(env.logs.some((l) => l.startsWith('FAILED create') && l.includes('HTTP 400'))).toBe(true);
    expect(env.logs.some((l) => l.startsWith('Done'))).toBe(false);
    // next run retries only what is still missing
    env.inject = () => undefined;
    expect(run(env, settings(), {})).toMatchObject({ status: 'ok', created: 1 });
  });

  it('safety stop: an automatic run will not delete most events; a manual run may', () => {
    const env = makeEnv();
    run(env, settings(), { manual: true });
    const keep = SAMPLE.split('BEGIN:VEVENT').slice(0, 21).join('BEGIN:VEVENT') + 'END:VCALENDAR\r\n';
    env.feed.text = keep;
    expect(() => run(env, settings(), {})).toThrow(/Safety stop/);
    expect(env.events()).toHaveLength(296);
    expect(run(env, settings(), { manual: true })).toMatchObject({ status: 'ok', deleted: 276 });
  });

  it('stops before the time limit and reports what is left', () => {
    const env = makeEnv();
    env.tickPerHttp = 2 * 60 * 1000; // each request "takes" 2 minutes
    expect(() => run(env, settings(), { manual: true })).toThrow(/not attempted/);
    expect(env.events().length).toBeLessThan(296);
    env.tickPerHttp = 0;
    expect(run(env, settings(), { manual: true }).status).toBe('ok');
    expect(env.events()).toHaveLength(296);
  });

  it('preview (dry run) reports counts and changes nothing', () => {
    const env = makeEnv();
    const r = run(env, settings(), { dryRun: true, manual: true });
    expect(r).toMatchObject({ status: 'dry-run', created: 296 });
    expect(env.props.get(PROP_CALENDAR)).toBeUndefined();
    expect(env.batchCalls).toBe(0);
    expect(env.logs.join('\n')).toContain('Would create');
  });

  it('refuses to use a calendar that does not exist', () => {
    const env = makeEnv();
    const s = settings();
    s.target.calendarId = 'nope@group.calendar.google.com';
    expect(() => run(env, s, { manual: true })).toThrow(/not found/);
  });

  it('"delete everything" needs the confirmation text and never empties the primary calendar', () => {
    const env = makeEnv();
    run(env, settings(), { manual: true });
    const cal = env.calendars.get(env.props.get(PROP_CALENDAR)!)!;
    cal.events.set('old', { id: 'old', summary: 'Leftover from old script (no marker)' });
    expect(() => deleteEverythingInCalendar(env, settings(), 'yes')).toThrow(/CONFIRM/);
    expect(deleteEverythingInCalendar(env, settings(), 'YES DELETE ALL')).toBe(297);
    const s = settings();
    s.target.calendarId = 'me@example.com';
    expect(() => deleteEverythingInCalendar(env, s, 'YES DELETE ALL')).toThrow(/primary/);
  });

  it('setLink checks the link before saving it and never logs it', () => {
    const env = makeEnv();
    env.props.clear();
    expect(() => setLink(env, 'PASTE_YOUR_LINK_HERE')).toThrow(/Paste/);
    setLink(env, LINK);
    expect(env.props.get(PROP_LINK)).toBe(LINK);
    expect(env.logs.join('\n')).not.toContain('pToken');
  });

  it('setupAutoSync replaces only its own trigger', () => {
    const env = makeEnv();
    env.triggerList.push({ id: 'other', handler: 'myOwnFunction' });
    setupAutoSync(env, settings());
    setupAutoSync(env, settings());
    expect(env.triggerList.map((t) => t.handler).sort()).toEqual(['autoSync', 'myOwnFunction']);
  });
});
