/**
 * Runs the real generated .gs file (settings + wrappers + bundled engine) in a sandbox with
 * stand-ins for the Apps Script services. Catches wiring problems the unit tests can't see.
 * Requires `npm run build:gas` first (the test script does this).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { generateScript } from '../src/web/generate';
import { defaultSettings } from '../src/core/settings';
import { SAMPLE } from './helpers';

const enginePath = fileURLToPath(new URL('../dist-gas/tumcal-engine.js', import.meta.url));
const LINK = 'https://campus.tum.de/tumonlinej/ws/termin/ical?pStud=X&pToken=Y';

function sandbox() {
  const props = new Map<string, string>();
  const logs: string[] = [];
  const events = new Map<string, Record<string, unknown>>();
  const calendars: Record<string, { summary: string }> = {};
  let n = 0;
  const response = (code: number, text: string, ct = 'text/plain') => ({
    getResponseCode: () => code, getContentText: () => text, getHeaders: () => ({ 'Content-Type': ct }),
  });
  const ctx = {
    console: { log: (m: string) => logs.push(String(m)) },
    PropertiesService: { getUserProperties: () => ({ getProperty: (k: string) => props.get(k) ?? null, setProperty: (k: string, v: string) => props.set(k, v), deleteProperty: (k: string) => props.delete(k) }) },
    LockService: { getUserLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    ScriptApp: { getOAuthToken: () => 'token', getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ everyHours: () => ({ create: () => {} }) }) }) },
    Utilities: { newBlob: (s: string) => ({ getBytes: () => s }), sleep: () => {}, formatDate: () => '' },
    UrlFetchApp: {
      fetch: (url: string, opts: { payload?: string; contentType?: string; headers: Record<string, string> }) => {
        if (url === LINK) {
          if (opts.headers.Authorization) throw new Error('OAuth token must never be sent to TUMonline');
          return response(200, SAMPLE, 'text/calendar');
        }
        if (url === 'https://www.googleapis.com/batch/calendar/v3') {
          const boundary = /boundary=(\S+)/.exec(opts.contentType!)![1];
          let out = '';
          for (const part of opts.payload!.split('--' + boundary).filter((p) => p.includes('Content-ID'))) {
            const i = /<item(\d+)>/.exec(part)![1];
            const id = 'e' + ++n;
            events.set(id, JSON.parse(part.slice(part.indexOf('{'))));
            out += `--b\r\nContent-ID: <response-item${i}>\r\n\r\nHTTP/1.1 200 OK\r\n\r\n{"id":"${id}"}\r\n`;
          }
          return response(200, out + '--b--', 'multipart/mixed; boundary=b');
        }
        return response(404, '');
      },
    },
    Calendar: {
      Events: {
        list: () => ({ items: [...events.entries()].map(([id, e]) => ({ id, ...e })) }),
      },
      Calendars: { insert: (c: { summary: string }) => { calendars['new@group'] = c; return { id: 'new@group' }; }, get: () => { throw new Error('nf'); } },
      CalendarList: {
        get: (id: string) => { if (!calendars[id]) throw new Error('not found'); return { id, summary: calendars[id].summary }; },
        list: () => ({ items: [] }),
      },
    },
  };
  return { ctx: vm.createContext(ctx), props, logs, events };
}

describe.runIf(existsSync(enginePath))('generated Apps Script', () => {
  const settings = defaultSettings();
  settings.courses['m:MA9001'] = { name: 'Analysis', color: '9' };
  const code = generateScript(settings, { engineSource: readFileSync(enginePath, 'utf8') });

  it('contains the settings, setup steps and a placeholder (never a real link)', () => {
    expect(code).toContain('"name": "Analysis"');
    expect(code).toContain('PASTE_YOUR_TUMONLINE_ICAL_LINK_HERE');
    expect(code).toContain('Google Calendar API');
    expect(code).not.toMatch(/pToken=/);
  });

  it('runs setLink → previewSync → syncNow → syncNow (unchanged)', () => {
    const sb = sandbox();
    vm.runInContext(code.replace('PASTE_YOUR_TUMONLINE_ICAL_LINK_HERE', LINK), sb.ctx);
    vm.runInContext('setLink()', sb.ctx);
    expect(sb.props.get('TUM_ICAL_URL')).toBe(LINK);
    vm.runInContext('previewSync()', sb.ctx);
    expect(sb.events.size).toBe(0);
    expect(sb.logs.join('\n')).toContain('To create: ');
    vm.runInContext('syncNow()', sb.ctx);
    expect(sb.events.size).toBeGreaterThan(0);
    expect([...sb.events.values()].some((e) => String(e.summary).includes('Analysis'))).toBe(true);
    vm.runInContext('syncNow()', sb.ctx);
    expect(sb.logs.at(-1)).toMatch(/No changes/);
    expect(sb.logs.join('\n')).not.toContain('pToken');
  });

  it('deleteEverythingInCalendar refuses without the confirmation text', () => {
    const sb = sandbox();
    vm.runInContext(code, sb.ctx);
    expect(() => vm.runInContext('deleteEverythingInCalendar()', sb.ctx)).toThrow(/CONFIRM/);
  });
});
