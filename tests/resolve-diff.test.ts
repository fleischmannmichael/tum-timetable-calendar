import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseCalendar } from '../src/core/calendar';
import { detect } from '../src/core/detect';
import { diffEvents, toGoogleBody, type ManagedEvent } from '../src/core/diff';
import { ensureCourseColors, renderTemplate, resolve, resultHash } from '../src/core/resolve';
import { defaultSettings, parseSettings, serializeSettings, type Settings } from '../src/core/settings';
import { suggestColors } from '../src/core/colors';
import { ics, NOW, SAMPLE, tumEvent } from './helpers';

function run(settings: Settings, text = SAMPLE, now = NOW) {
  const d = detect(parseCalendar(text).events, settings);
  ensureCourseColors(d, settings);
  return { d, r: resolve(d, settings, now) };
}

describe('title template', () => {
  it('fills placeholders and drops dangling separators', () => {
    expect(renderTemplate('{type} · {course}', { type: 'VL', course: 'Analysis' })).toBe('VL · Analysis');
    expect(renderTemplate('{type} · {course}', { type: '', course: 'Analysis' })).toBe('Analysis');
    expect(renderTemplate('{course} ({type})', { type: '', course: 'Analysis' })).toBe('Analysis');
    expect(renderTemplate('{course} - {type} · {group}', { type: 'Tut', course: 'LA', group: '' })).toBe('LA - Tut');
  });
});

describe('colours', () => {
  it('suggests all-different colours and reports reuse beyond 11', () => {
    const ids = Array.from({ length: 13 }, (_, i) => 'c' + i);
    const { colors, reused } = suggestColors(ids, {});
    expect(new Set(Object.values(colors).slice(0, 11)).size).toBe(11);
    expect(reused).toBe(true);
    expect(suggestColors(['a', 'b'], { a: '9' }).colors).toEqual({ b: '11' });
  });
});

describe('resolve on the sample', () => {
  it('writes short coloured titles and keeps the original title in the description', () => {
    const s = defaultSettings();
    const { d, r } = run(s);
    expect(r.desired).toHaveLength(296);
    const colors = d.courses.map((c) => s.courses[c.id].color);
    expect(new Set(colors).size).toBe(colors.length);
    const zue = r.desired.find((e) => e.source.summary.startsWith('Zentralübung zu Mathematik 1'))!;
    expect(zue.summary).toBe('ZÜ · Mathematik 1');
    expect(zue.colorId).toBe(s.courses['m:MA9001'].color);
    expect(zue.description).toContain('TUMonline: Zentralübung zu Mathematik 1 (EI) [MA9001] UE, Standardgruppe');
    expect(zue.description).toContain('https://nav.tum.de/room/');
    expect(zue.start.timeZone).toBe('Europe/Berlin');
    expect(r.desired.filter((e) => e.attention.length)).toEqual([]);
  });

  it('applies renames, per-course type labels, hidden types and disabled courses', () => {
    const s = defaultSettings();
    s.courses['m:MA9001'] = { name: 'Analysis', typeLabels: { vl: 'Lecture' } };
    s.courses['n:netzwerktheorie'] = { hiddenTypes: ['tut'] };
    s.courses['n:softwarepraktikum'] = { enabled: false };
    const { r } = run(s);
    expect(r.desired.find((e) => e.source.summary.startsWith('Mathematik 1 (EI)'))!.summary).toBe('Lecture · Analysis');
    const reasons = r.skipped.reduce<Record<string, number>>((a, x) => ({ ...a, [x.reason]: (a[x.reason] ?? 0) + 1 }), {});
    expect(reasons).toEqual({ 'type-hidden': 14, 'course-off': 15 });
  });

  it('"all like this" rule uses Munich weekday + time (same rule before and after DST)', () => {
    const s = defaultSettings();
    // Netzwerktheorie Thursday 09:45 is a VI slot; say it is really a Zentralübung
    s.rules.push({ groupId: 'n:netzwerktheorie', weekday: 4, time: '09:45', set: { typeId: 'zue' } });
    const { r } = run(s);
    const thu = r.desired.filter((e) => e.groupId === 'n:netzwerktheorie' && e.weekday === 4 && e.time === '09:45');
    expect(thu.length).toBe(17); // 14 in the series + 3 single dates in the same slot
    expect(new Set(thu.map((e) => e.summary))).toEqual(new Set(['ZÜ · Netzwerktheorie']));
    expect(thu.some((e) => e.source.startMs < Date.UTC(2026, 9, 25)) && thu.some((e) => e.source.startMs > Date.UTC(2026, 9, 26))).toBe(true);
  });

  it('single-event edits win over rules and can remove one date', () => {
    const s = defaultSettings();
    const first = run(s).r.desired.find((e) => e.groupId === 'm:MA9001')!;
    s.rules.push({ groupId: 'm:MA9001', weekday: first.weekday, time: first.time, set: { colorId: '8', location: 'Online' } });
    s.eventEdits[first.key] = { title: 'Special lecture', location: 'Hörsaal X' };
    const { r } = run(s);
    const e = r.desired.find((x) => x.key === first.key)!;
    expect(e).toMatchObject({ summary: 'Special lecture', location: 'Hörsaal X', colorId: '8' });
    s.eventEdits[first.key] = { remove: true };
    expect(run(s).r.skipped.find((x) => x.source.key === first.key)?.reason).toBe('removed');
  });

  it('skips cancel-word events and flags unknown course/type instead of guessing', () => {
    const s = defaultSettings();
    const { r } = run(s, ics([
      tumEvent('1', 'Analysis VO, Standardgruppe', '20261020T080000Z', '20261020T093000Z'),
      tumEvent('2', 'Analysis VO abgesagt, Standardgruppe', '20261021T080000Z', '20261021T093000Z'),
      tumEvent('3', 'Kolloquium Robotik', '20261022T080000Z', '20261022T093000Z'),
      tumEvent('4', '???', '20261023T080000Z', '20261023T093000Z'),
    ]));
    expect(r.skipped.map((x) => x.reason)).toEqual(['cancel-word']);
    expect(r.desired.map((e) => [e.summary, e.attention])).toEqual([
      ['VL · Analysis', []],
      ['Kolloquium Robotik', ['Event type not recognised']],
      ['???', ['Course not recognised', 'Event type not recognised']],
    ]);
  });

  it('respects the date window', () => {
    const s = defaultSettings();
    s.window = { daysBack: 0, daysAhead: 30 };
    const { r } = run(s, SAMPLE, Date.UTC(2026, 10, 1));
    expect(r.desired.every((e) => e.source.startMs >= Date.UTC(2026, 10, 1) - 86400000 * 1 && e.source.startMs <= Date.UTC(2026, 11, 1))).toBe(true);
    expect(r.skipped.filter((x) => x.reason === 'outside-window').length).toBeGreaterThan(100);
  });

  it('produces identical hashes for identical input, different after a change', () => {
    const s = defaultSettings();
    const a = run(s).r.desired;
    const b = run(s).r.desired;
    expect(resultHash(a, 'cal')).toBe(resultHash(b, 'cal'));
    s.titleTemplate = '{course} ({type})';
    expect(resultHash(run(s).r.desired, 'cal')).not.toBe(resultHash(a, 'cal'));
  });
});

describe('diff', () => {
  const s = defaultSettings();
  const desired = run(s, ics([
    tumEvent('a', 'Analysis VO, Standardgruppe', '20261020T080000Z', '20261020T093000Z'),
    tumEvent('b', 'Analysis VO, Standardgruppe', '20261027T090000Z', '20261027T103000Z'),
    tumEvent('c', 'Physik VO, Standardgruppe', '20261028T090000Z', '20261028T103000Z'),
  ])).r.desired;
  const [a, b, c] = desired;

  it('creates everything on the first run', () => {
    const r = diffEvents(desired, []);
    expect(r.create.map((e) => e.key)).toEqual(['a', 'b', 'c']);
    expect(r.update).toEqual([]);
    expect(r.remove).toEqual([]);
  });

  it('updates changed events in place, deletes vanished ones, leaves the rest', () => {
    const existing: ManagedEvent[] = [
      { id: 'g1', key: 'a', hash: a.hash },
      { id: 'g2', key: 'b', hash: 'old-hash' }, // e.g. room changed in TUMonline
      { id: 'g3', key: 'gone', hash: 'x' }, // disappeared from TUMonline
    ];
    const r = diffEvents([a, b, c], existing);
    expect(r.unchanged).toBe(1);
    expect(r.update).toEqual([{ id: 'g2', event: b }]);
    expect(r.create.map((e) => e.key)).toEqual(['c']);
    expect(r.remove.map((e) => e.id)).toEqual(['g3']);
  });

  it('cleans up duplicates and marked events without a key', () => {
    const r = diffEvents([a], [
      { id: 'g1', key: 'a', hash: a.hash },
      { id: 'g1-dup', key: 'a', hash: a.hash },
      { id: 'nokey' },
    ]);
    expect(r.remove.map((e) => e.id).sort()).toEqual(['g1-dup', 'nokey']);
    expect(r.unchanged).toBe(1);
  });

  it('marks every event body with the private extended property', () => {
    const body = toGoogleBody(a) as { extendedProperties: { private: Record<string, string> }; colorId?: string };
    expect(body.extendedProperties.private).toEqual({ tumcal: '1', tumcalKey: 'a', tumcalHash: a.hash });
    expect(body.colorId).toBe(a.colorId);
  });
});

describe('settings import/export', () => {
  it('round-trips through JSON', () => {
    const s = defaultSettings();
    s.courses['m:X'] = { name: 'X', color: '3', hiddenTypes: ['tut'], typeLabels: { vl: '' } };
    s.rules.push({ groupId: 'm:X', weekday: 4, time: '15:00', set: { typeId: 'zue' } });
    s.eventEdits['uid1'] = { remove: true };
    expect(parseSettings(serializeSettings(s))).toEqual(s);
  });

  it('fills defaults, drops invalid colours and rejects foreign files', () => {
    const s = parseSettings({ titleTemplate: '{course}', courses: { a: { color: '#ff0000' } } });
    expect(s.courses.a.color).toBeUndefined();
    expect(s.types.length).toBeGreaterThan(5);
    expect(() => parseSettings('{"foo":1}')).toThrow(/does not look like settings/);
    expect(() => parseSettings('not json')).toThrow(/not valid JSON/);
    expect(() => parseSettings({ version: 99, titleTemplate: '' })).toThrow(/newer version/);
  });
});

describe('privacy', () => {
  it('the test fixtures contain no TUMonline tokens', () => {
    for (const f of ['tumonline-sample.ics']) {
      const t = readFileSync(new URL('./fixtures/' + f, import.meta.url), 'utf8');
      expect(t).not.toMatch(/pToken|pStud/i);
    }
  });
});
