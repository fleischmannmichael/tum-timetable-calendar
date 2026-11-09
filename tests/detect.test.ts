import { describe, expect, it } from 'vitest';
import { parseCalendar } from '../src/core/calendar';
import { detect, descriptionNote, parseTitle } from '../src/core/detect';
import { defaultSettings } from '../src/core/settings';
import { normalize } from '../src/core/text';
import { ics, SAMPLE, tumEvent } from './helpers';

const types = defaultSettings().types;

describe('normalize', () => {
  it('spells out umlauts in every form', () => {
    expect(normalize('Zentralübung')).toBe('zentraluebung');
    expect(normalize('ZENTRALÜBUNG')).toBe('zentraluebung');
    expect(normalize('Zentralübung')).toBe('zentraluebung'); // decomposed (macOS)
    expect(normalize('Großübung  Café')).toBe('grossuebung cafe');
  });
});

describe('parseTitle: every title pattern in the TUMonline sample', () => {
  const cases: Array<[string, Partial<ReturnType<typeof parseTitle>>]> = [
    ['Analysis 1 (EI) [MA9411] VO, Standardgruppe', { courseName: 'Analysis 1', moduleCode: 'MA9411', lvCode: 'VO', typeId: null, group: 'Standardgruppe' }],
    ['Zentralübung zu Analysis 1 (EI) [MA9411] UE, Standardgruppe', { courseName: 'Analysis 1', typeId: 'zue', lvCode: 'UE' }],
    ['Übungen zu Analysis 1 G12', { courseName: 'Analysis 1', typeId: 'ue', group: 'G12' }],
    ['Lineare Algebra Tutorium G4', { courseName: 'Lineare Algebra', typeId: 'tut', group: 'G4' }],
    ['Tutorium Schaltungstheorie UE, Standardgruppe', { courseName: 'Schaltungstheorie', typeId: 'tut', lvCode: 'UE' }],
    ['Digitaltechnik - Tutorien TT, Gruppe 6 - Name', { courseName: 'Digitaltechnik', typeId: 'tut', group: 'Gruppe 6 - Name' }],
    ['Computertechnik Tutorium TT, Tutorium 5', { courseName: 'Computertechnik', typeId: 'tut', group: 'Tutorium 5' }],
    ['Programmierpraktikum (Übung) UE, Standardgruppe', { courseName: 'Programmierpraktikum', typeId: 'ue' }],
    ['Digitaltechnik VI, Standardgruppe', { courseName: 'Digitaltechnik', lvCode: 'VI', typeId: null }],
    ['Fachschaftsvollversammlung - Computation, Information and Technology (EI) VO, Standardgruppe',
      { courseName: 'Fachschaftsvollversammlung - Computation, Information and Technology', lvCode: 'VO' }],
  ];
  it.each(cases)('%s', (title, expected) => {
    expect(parseTitle(title, types)).toMatchObject(expected);
  });
});

describe('parseTitle: English, umlaut spellings and tricky names', () => {
  it.each([
    ['Lecture: Introduction to Informatics', 'Introduction to Informatics', 'vl'],
    ['Exercise for Linear Algebra', 'Linear Algebra', 'ue'],
    ['Tutorial Discrete Structures', 'Discrete Structures', 'tut'],
    ['Lab Course Embedded Systems', 'Embedded Systems', 'prak'],
    ['Seminar Machine Learning', 'Machine Learning', 'sem'],
    ['Zentraluebung Physik', 'Physik', 'zue'],
    ['UEBUNG ZUR VORLESUNG Physik', 'Physik', 'ue'],
    ['Analysis II (Vorlesung)', 'Analysis II', 'vl'],
    ['Lineare Algebra II VO, Standardgruppe', 'Lineare Algebra II', 'vl'],
  ])('%s', (title, course, type) => {
    const t = parseTitle(title, types);
    expect(t.courseName).toBe(course);
    expect(t.typeId ?? (t.lvCode === 'VO' ? 'vl' : null)).toBe(type);
  });

  it('does not treat a compound word as a type (Programmierpraktikum is not a Praktikum)', () => {
    expect(parseTitle('Programmierpraktikum', types)).toMatchObject({ courseName: 'Programmierpraktikum', typeId: null });
  });

  it('keeps roman numerals that look like codes when no group follows', () => {
    expect(parseTitle('Mathematik VI', types)).toMatchObject({ courseName: 'Mathematik VI', typeId: null });
  });

  it('returns no course name if only a type word is left', () => {
    expect(parseTitle('Tutorium', types).courseName).toBeNull();
  });
});

describe('descriptionNote', () => {
  it('extracts the free text after "fix; Abhaltung;"', () => {
    expect(descriptionNote('fix; Abhaltung; Zentralübung')).toBe('Zentralübung');
    expect(descriptionNote('fix; Abhaltung; ')).toBe('');
    expect(descriptionNote('Gruppenübung G12 2100 Seminarraum')).toBe('Gruppenübung G12 2100 Seminarraum');
  });
});

describe('detect on the sample feed', () => {
  const d = detect(parseCalendar(SAMPLE).events, defaultSettings());
  const course = (name: string) => d.courses.find((c) => c.name === name)!;

  it('finds 7 courses and merges titles of the same module', () => {
    expect(d.courses.map((c) => c.name).sort()).toEqual([
      'Fachschaftsvollversammlung - Beispiel, Muster und Test',
      'Geometrie und Algebra', 'Logikentwurf', 'Mathematik 1', 'Netzwerktheorie',
      'Rechnerarchitektur', 'Softwarepraktikum',
    ]);
    // VO + Zentralübung + "Übungen zu Mathematik 1 G12" (no module code in the title)
    expect(course('Mathematik 1')).toMatchObject({ id: 'm:MA9001', eventCount: 63, types: { vl: 31, zue: 16, ue: 16 } });
    expect(course('Geometrie und Algebra')).toMatchObject({ id: 'm:MA9002', types: { vl: 32, zue: 14, tut: 16 } });
  });

  it('reads the type from the description when the title does not say it (Zentralübung)', () => {
    const lt = d.events.filter((e) => e.courseId === course('Logikentwurf').id);
    const zue = lt.filter((e) => e.typeId === 'zue');
    expect(zue).toHaveLength(14);
    expect(zue.every((e) => e.typeSource === 'description')).toBe(true);
    expect(course('Logikentwurf').types).toMatchObject({ zue: 14, tut: 12 });
  });

  it('falls back to the LV code and never leaves a sample event untyped', () => {
    expect(d.events.filter((e) => !e.courseId || !e.typeId)).toEqual([]);
    expect(course('Netzwerktheorie').types).toMatchObject({ vi: 46, tut: 14 });
  });

  it('marks nothing in the sample as cancelled', () => {
    expect(d.events.filter((e) => e.cancelWord)).toEqual([]);
  });
});

describe('detect: unknowns and cancel words', () => {
  const s = defaultSettings();
  const d = detect(parseCalendar(ics([
    tumEvent('1', 'Analysis VO, Standardgruppe', '20261020T080000Z', '20261020T093000Z'),
    tumEvent('2', 'Analysis VO - entfällt!, Standardgruppe', '20261021T080000Z', '20261021T093000Z'),
    tumEvent('3', 'Analysis VO, Standardgruppe', '20261022T080000Z', '20261022T093000Z', ['DESCRIPTION:fix\\; Abhaltung\\; Termin fällt aus']),
    tumEvent('4', 'Kolloquium Robotik', '20261023T080000Z', '20261023T093000Z'),
    tumEvent('5', '???', '20261024T080000Z', '20261024T093000Z'),
  ])).events, s);

  it('finds cancel words in the title and in the description note', () => {
    expect(d.events.map((e) => e.cancelWord)).toEqual([undefined, 'entfaellt', 'faellt aus', undefined, undefined]);
  });

  it('leaves unknown type / course as null (not guessed)', () => {
    expect(d.events[3]).toMatchObject({ courseName: 'Kolloquium Robotik', typeId: null });
    expect(d.events[4]).toMatchObject({ courseId: null, typeId: null });
  });

  it('respects the setting to ignore descriptions for cancel words', () => {
    const d2 = detect(parseCalendar(ics([
      tumEvent('3', 'Analysis VO, Standardgruppe', '20261022T080000Z', '20261022T093000Z', ['DESCRIPTION:fix\\; Abhaltung\\; fällt aus']),
    ])).events, { ...s, cancelWordsInDescription: false });
    expect(d2.events[0].cancelWord).toBeUndefined();
  });
});
