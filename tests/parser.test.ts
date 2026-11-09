import { describe, expect, it } from 'vitest';
import { parseCalendar, parseFeedStrict } from '../src/core/calendar';
import { parseContentLine, parseIcs, unescapeText } from '../src/core/ics';
import { localParts } from '../src/core/time';
import { ics, SAMPLE } from './helpers';

const berlin = (ms: number) => {
  const p = localParts(ms, 'Europe/Berlin');
  return `${p.date} ${p.time}`;
};

describe('iCal tokenizer', () => {
  it('unfolds lines, including folds inside multi-byte text', () => {
    const cal = parseIcs('BEGIN:VCALENDAR\r\nX-TEST:Zentral\r\n übung zu A\r\n\tnalysis\r\nEND:VCALENDAR');
    expect(cal.properties[0].value).toBe('Zentralübung zu Analysis');
  });

  it('reads quoted parameters containing : ; ,', () => {
    const p = parseContentLine('DTSTART;TZID="GMT+01:00; Berlin, Rome":20261020T100000')!;
    expect(p.params.TZID).toBe('GMT+01:00; Berlin, Rome');
    expect(p.value).toBe('20261020T100000');
  });

  it('unescapes text', () => {
    expect(unescapeText('a\\, b\\; c\\nd\\\\e')).toBe('a, b; c\nd\\e');
  });

  it('rejects error pages and empty feeds', () => {
    expect(() => parseFeedStrict('<html>Service Unavailable</html>')).toThrow(/did not return a calendar/);
    expect(() => parseFeedStrict(ics([]))).toThrow(/0 events/);
  });
});

describe('sample TUMonline feed (anonymised)', () => {
  const r = parseCalendar(SAMPLE);

  it('reads all 296 events with unique stable keys', () => {
    expect(r.veventCount).toBe(296);
    expect(r.events).toHaveLength(296);
    expect(new Set(r.events.map((e) => e.key)).size).toBe(296);
    expect(r.warnings).toEqual([]);
  });

  it('converts UTC to Munich time across the DST change', () => {
    // Same Thursday 15:00 slot: 13:00Z in October (CEST), 14:00Z in November (CET)
    const zue = r.events.filter((e) => e.summary.startsWith('Logikentwurf VI') && e.description.endsWith('Zentralübung'));
    expect(zue.length).toBe(14);
    expect(new Set(zue.map((e) => berlin(e.startMs).slice(11)))).toEqual(new Set(['15:00']));
  });

  it('keeps escaped commas, series ids and descriptions', () => {
    const e = r.events.find((x) => x.summary.startsWith('Mathematik 1 (EI)'))!;
    expect(e.summary).toBe('Mathematik 1 (EI) [MA9001] VO, Standardgruppe');
    expect(e.location).toContain('Hörsaal');
    expect(e.seriesId).toMatch(/^\d+$/);
    expect(e.description.startsWith('fix; Abhaltung;')).toBe(true);
  });

  it('uses the feed time zone', () => {
    expect(r.timeZone).toBe('Europe/Vienna');
    expect(r.calendarName).toBe('Max Mustermann');
  });
});

describe('edge cases', () => {
  it('skips events marked STATUS:CANCELLED but lists them', () => {
    const r = parseCalendar(ics([
      ['UID:a', 'SUMMARY:Analysis VO', 'DTSTART:20261020T080000Z', 'DTEND:20261020T093000Z', 'STATUS:CANCELLED'],
      ['UID:b', 'SUMMARY:Analysis VO', 'DTSTART:20261021T080000Z', 'DTEND:20261021T093000Z'],
    ]));
    expect(r.events.map((e) => e.uid)).toEqual(['b']);
    expect(r.cancelled.map((e) => e.uid)).toEqual(['a']);
  });

  it('handles all-day events (end exclusive, default one day)', () => {
    const r = parseCalendar(ics([
      ['UID:d1', 'SUMMARY:Dies Academicus', 'DTSTART;VALUE=DATE:20261203'],
      ['UID:d2', 'SUMMARY:Exkursion', 'DTSTART;VALUE=DATE:20261210', 'DTEND;VALUE=DATE:20261212'],
    ]));
    expect(r.events[0]).toMatchObject({ allDay: true, startDate: '2026-12-03', endDate: '2026-12-04' });
    expect(r.events[1]).toMatchObject({ allDay: true, startDate: '2026-12-10', endDate: '2026-12-12' });
  });

  it('ignores VALARM blocks inside events', () => {
    const r = parseCalendar(ics([[
      'UID:x', 'SUMMARY:Lecture Physics', 'DTSTART:20261020T080000Z', 'DTEND:20261020T093000Z',
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'TRIGGER:-PT15M', 'END:VALARM',
      'LOCATION:Room 1',
    ]]));
    expect(r.events[0].description).toBe('');
    expect(r.events[0].location).toBe('Room 1');
  });

  it('reads TZID times, including Windows zone names', () => {
    const r = parseCalendar(ics([
      ['UID:t1', 'SUMMARY:A', 'DTSTART;TZID=Europe/Berlin:20261020T100000', 'DTEND;TZID=Europe/Berlin:20261020T113000'],
      ['UID:t2', 'SUMMARY:B', 'DTSTART;TZID="W. Europe Standard Time":20261120T100000', 'DURATION:PT90M'],
      ['UID:t3', 'SUMMARY:C', 'DTSTART;TZID=Mars/Olympus:20261120T100000', 'DTEND;TZID=Mars/Olympus:20261120T110000'],
    ]));
    expect(new Date(r.events[0].startMs).toISOString()).toBe('2026-10-20T08:00:00.000Z');
    expect(new Date(r.events[1].startMs).toISOString()).toBe('2026-11-20T09:00:00.000Z');
    expect(r.events[1].endMs - r.events[1].startMs).toBe(90 * 60000);
    expect(r.events[2].warnings[0]).toMatch(/Unknown time zone/);
  });

  it('expands weekly RRULE with EXDATE, a moved date and a cancelled date (wall clock across DST)', () => {
    const r = parseCalendar(ics([
      [
        'UID:series1', 'SUMMARY:Vorlesung Physik', 'DTSTART;TZID=Europe/Berlin:20261015T150000',
        'DTEND;TZID=Europe/Berlin:20261015T163000', 'RRULE:FREQ=WEEKLY;COUNT=6',
        'EXDATE;TZID=Europe/Berlin:20261022T150000',
      ],
      [ // moved: 29 Oct → 30 Oct 10:00
        'UID:series1', 'RECURRENCE-ID;TZID=Europe/Berlin:20261029T150000', 'SUMMARY:Vorlesung Physik',
        'DTSTART;TZID=Europe/Berlin:20261030T100000', 'DTEND;TZID=Europe/Berlin:20261030T113000',
      ],
      [ // cancelled date
        'UID:series1', 'RECURRENCE-ID;TZID=Europe/Berlin:20261105T150000', 'SUMMARY:Vorlesung Physik',
        'DTSTART;TZID=Europe/Berlin:20261105T150000', 'DTEND;TZID=Europe/Berlin:20261105T163000', 'STATUS:CANCELLED',
      ],
    ]));
    expect(r.events.map((e) => berlin(e.startMs))).toEqual([
      '2026-10-15 15:00', // CEST
      '2026-10-30 10:00', // moved
      '2026-11-12 15:00', // CET: still 15:00
      '2026-11-19 15:00',
    ]);
    expect(r.cancelled.map((e) => berlin(e.startMs))).toEqual(['2026-11-05 15:00']);
    // keys are UID + original date, so a moved date keeps its key
    expect(r.events[1].key).toBe('series1#20261029T140000Z');
    expect(r.events.every((e) => e.seriesId === 'series1')).toBe(true);
  });

  it('expands UNTIL, INTERVAL, BYDAY and all-day repeats', () => {
    const r = parseCalendar(ics([
      ['UID:w', 'SUMMARY:Tutorium', 'DTSTART:20261019T120000Z', 'DTEND:20261019T130000Z',
        'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20261104T235959Z'],
      ['UID:m', 'SUMMARY:Sprechstunde', 'DTSTART;VALUE=DATE:20261102', 'RRULE:FREQ=MONTHLY;BYDAY=1MO;COUNT=3'],
    ]));
    const w = r.events.filter((e) => e.uid === 'w').map((e) => berlin(e.startMs).slice(0, 10));
    expect(w).toEqual(['2026-10-19', '2026-10-21', '2026-11-02', '2026-11-04']);
    const m = r.events.filter((e) => e.uid === 'm').map((e) => e.startDate);
    expect(m).toEqual(['2026-11-02', '2026-12-07', '2027-01-04']);
  });

  it('does not silently drop dates of unsupported rules: imports the first and warns', () => {
    const r = parseCalendar(ics([
      ['UID:u', 'SUMMARY:Seminar', 'DTSTART:20261019T120000Z', 'DTEND:20261019T130000Z', 'RRULE:FREQ=MONTHLY;BYSETPOS=-1;BYDAY=MO,TU'],
    ]));
    expect(r.events).toHaveLength(1);
    expect(r.events[0].warnings[0]).toMatch(/Repeat rule not supported/);
  });

  it('cuts open-ended repeats at the horizon and says so', () => {
    const r = parseCalendar(ics([['UID:o', 'SUMMARY:X', 'DTSTART:20261019T120000Z', 'DTEND:20261019T130000Z', 'RRULE:FREQ=DAILY']]), { horizonDays: 10 });
    expect(r.events.length).toBe(11);
    expect(r.warnings[0]).toMatch(/repeats without end/);
  });

  it('imports orphan RECURRENCE-ID events and generates keys for missing UIDs', () => {
    const r = parseCalendar(ics([
      ['UID:orphan', 'RECURRENCE-ID:20261020T080000Z', 'SUMMARY:A', 'DTSTART:20261020T090000Z', 'DTEND:20261020T100000Z'],
      ['SUMMARY:No UID', 'DTSTART:20261021T090000Z', 'DTEND:20261021T100000Z'],
    ]));
    expect(r.events.map((e) => e.key)).toEqual(['orphan#20261020T080000Z', expect.stringMatching(/^nouid-/)]);
  });

  it('handles LF-only line endings and a BOM', () => {
    const text = '﻿' + ics([['UID:lf', 'SUMMARY:Übung', 'DTSTART:20261020T080000Z', 'DTEND:20261020T090000Z']]).replace(/\r\n/g, '\n');
    expect(parseCalendar(text).events[0].summary).toBe('Übung');
  });
});
