/**
 * All user choices live in one Settings object. It is saved in the browser, exported/imported
 * as JSON, and embedded in the generated Apps Script. Nothing about a specific course or
 * study programme is built in: the defaults below are generic.
 */
import { isColorId } from './colors';

export const SETTINGS_VERSION = 1;

/** One kind of event (Vorlesung, Übung, ...). Order in the list = detection priority. */
export interface TypeDef {
  id: string;
  /** Full name shown in the UI. */
  name: string;
  /** Default short label used in titles, e.g. "VL". Can be overridden per course. */
  label: string;
  /** Whole words/phrases that identify the type in a title or description (any language). */
  words: string[];
  /** TUMonline course-type codes at the end of a title, e.g. "VO", "UE". */
  codes: string[];
}

export interface CourseSettings {
  /** Display name; empty = detected name. */
  name?: string;
  /** Google colorId "1"–"11". */
  color?: string;
  /** false = don't copy this course at all. */
  enabled?: boolean;
  /** Label per type id for this course; "" = no label. Missing = the type's default label. */
  typeLabels?: Record<string, string>;
  /** Type ids not copied for this course. */
  hiddenTypes?: string[];
}

/** A change to one event, or to all events like it. Empty fields = no change. */
export interface EventChange {
  typeId?: string;
  title?: string;
  colorId?: string;
  location?: string;
  remove?: boolean;
}

/** "All events like this one": same course (or same raw title) + weekday + start time. */
export interface SlotRule {
  /** Course id, or "raw:<normalised title>" for events without a detected course. */
  groupId: string;
  /** 1 = Monday ... 7 = Sunday */
  weekday: number;
  /** Local start time "HH:MM" (in settings.timeZone), or "all-day". */
  time: string;
  set: EventChange;
}

export interface Settings {
  version: number;
  /** Placeholders: {type} {course} {group} {code} {original} {location} */
  titleTemplate: string;
  types: TypeDef[];
  /** Keyed by course id (see detect.ts). */
  courses: Record<string, CourseSettings>;
  rules: SlotRule[];
  /** Keyed by the event's stable key. Wins over rules. */
  eventEdits: Record<string, EventChange>;
  /** Words that mark an event as cancelled, matched after umlaut normalisation. */
  cancelWords: string[];
  /** Also look for cancel words in the description (TUMonline puts notes there). */
  cancelWordsInDescription: boolean;
  /** Which dates to copy: from `daysBack` days ago; `daysAhead` null = everything in the feed. */
  window: { daysBack: number; daysAhead: number | null };
  /** Zone for weekday/time rules and the calendar. */
  timeZone: string;
  /** Add a nav.tum.de room link to the description when the location has a room code. */
  addRoomLink: boolean;
  /** Target calendar. Empty id = the script creates a new calendar named `newCalendarName`. */
  target: { calendarId: string; newCalendarName: string };
  autoSync: { enabled: boolean; everyHours: number };
  /** Automatic runs abort if they would delete more than this share of the managed events. */
  safety: { maxDeleteFraction: number };
}

export const DEFAULT_TYPES: TypeDef[] = [
  {
    id: 'zue', name: 'Zentralübung', label: 'ZÜ',
    words: ['zentraluebung', 'zentraluebungen', 'grossuebung', 'grossuebungen', 'central exercise', 'central exercises', 'zue'],
    codes: [],
  },
  {
    id: 'tut', name: 'Tutorium', label: 'Tut',
    words: ['tutorium', 'tutorien', 'tutorial', 'tutorials', 'repetitorium'],
    codes: ['TT'],
  },
  {
    id: 'prak', name: 'Praktikum', label: 'Prak',
    words: ['praktikum', 'praktika', 'lab', 'labs', 'laboratory', 'lab course', 'practical course'],
    codes: ['PR'],
  },
  {
    id: 'sem', name: 'Seminar', label: 'Sem',
    words: ['seminar', 'seminare', 'proseminar', 'hauptseminar'],
    codes: ['SE', 'PS', 'HS'],
  },
  {
    id: 'ue', name: 'Übung', label: 'Üb',
    words: ['uebung', 'uebungen', 'gruppenuebung', 'gruppenuebungen', 'tutoruebung', 'tutoruebungen', 'exercise', 'exercises', 'exercise session', 'exercise class'],
    codes: ['UE'],
  },
  {
    id: 'exam', name: 'Prüfung', label: 'Prüfung',
    words: ['pruefung', 'klausur', 'probeklausur', 'exam', 'examination', 'midterm', 'endterm', 'retake'],
    codes: [],
  },
  {
    id: 'proj', name: 'Projekt', label: 'Projekt',
    words: ['projekt', 'project', 'projektarbeit'],
    codes: ['PJ'],
  },
  {
    id: 'vi', name: 'Vorlesung mit Übung', label: 'VL',
    words: ['vorlesung mit integrierten uebungen', 'lecture with integrated exercises'],
    codes: ['VI', 'VU'],
  },
  {
    id: 'vl', name: 'Vorlesung', label: 'VL',
    words: ['vorlesung', 'vorlesungen', 'lecture', 'lectures'],
    codes: ['VO'],
  },
];

export const DEFAULT_CANCEL_WORDS = [
  'entfaellt', 'faellt aus', 'abgesagt', 'storniert', 'ausfall',
  'cancelled', 'canceled', 'no lecture', 'no class',
];

export function defaultSettings(): Settings {
  return {
    version: SETTINGS_VERSION,
    titleTemplate: '{type} · {course}',
    types: DEFAULT_TYPES.map((t) => ({ ...t, words: [...t.words], codes: [...t.codes] })),
    courses: {},
    rules: [],
    eventEdits: {},
    cancelWords: [...DEFAULT_CANCEL_WORDS],
    cancelWordsInDescription: true,
    window: { daysBack: 14, daysAhead: null },
    timeZone: 'Europe/Berlin',
    addRoomLink: true,
    target: { calendarId: '', newCalendarName: 'TUM Stundenplan' },
    autoSync: { enabled: true, everyHours: 1 },
    safety: { maxDeleteFraction: 0.5 },
  };
}

export class SettingsError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d);
const strList = (v: unknown, d: string[]) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : d;
const num = (v: unknown, d: number, min: number, max: number) =>
  typeof v === 'number' && isFinite(v) ? Math.min(max, Math.max(min, v)) : d;

function parseChange(v: unknown): EventChange {
  if (!isObj(v)) return {};
  const c: EventChange = {};
  if (typeof v.typeId === 'string') c.typeId = v.typeId;
  if (typeof v.title === 'string') c.title = v.title;
  if (isColorId(v.colorId)) c.colorId = v.colorId;
  if (typeof v.location === 'string') c.location = v.location;
  if (v.remove === true) c.remove = true;
  return c;
}

/**
 * Validates imported settings (from a JSON file, the browser or the script) and fills in
 * defaults for anything missing. Throws SettingsError for files that aren't settings at all.
 */
export function parseSettings(input: unknown): Settings {
  const raw = typeof input === 'string' ? safeJson(input) : input;
  if (!isObj(raw)) throw new SettingsError('Settings must be a JSON object.');
  if (typeof raw.version === 'number' && raw.version > SETTINGS_VERSION) {
    throw new SettingsError(`These settings are from a newer version (${raw.version}) of the tool.`);
  }
  if (!('titleTemplate' in raw) && !('courses' in raw) && !('types' in raw)) {
    throw new SettingsError('This file does not look like settings from this tool.');
  }
  const d = defaultSettings();
  const s: Settings = { ...d, version: SETTINGS_VERSION };
  s.titleTemplate = str(raw.titleTemplate, d.titleTemplate);

  if (Array.isArray(raw.types)) {
    const types: TypeDef[] = [];
    for (const t of raw.types) {
      if (!isObj(t) || typeof t.id !== 'string' || !t.id) continue;
      if (types.some((x) => x.id === t.id)) continue;
      types.push({
        id: t.id,
        name: str(t.name, t.id),
        label: str(t.label, ''),
        words: strList(t.words, []),
        codes: strList(t.codes, []).map((c) => c.toUpperCase()),
      });
    }
    if (types.length) s.types = types;
  }

  s.courses = {};
  if (isObj(raw.courses)) {
    for (const [id, c] of Object.entries(raw.courses)) {
      if (!isObj(c)) continue;
      const cs: CourseSettings = {};
      if (typeof c.name === 'string') cs.name = c.name;
      if (isColorId(c.color)) cs.color = c.color;
      if (c.enabled === false) cs.enabled = false;
      if (isObj(c.typeLabels)) {
        cs.typeLabels = {};
        for (const [k, v] of Object.entries(c.typeLabels)) if (typeof v === 'string') cs.typeLabels[k] = v;
      }
      const hidden = strList(c.hiddenTypes, []);
      if (hidden.length) cs.hiddenTypes = hidden;
      s.courses[id] = cs;
    }
  }

  s.rules = [];
  if (Array.isArray(raw.rules)) {
    for (const r of raw.rules) {
      if (!isObj(r) || typeof r.groupId !== 'string' || typeof r.time !== 'string') continue;
      const weekday = num(r.weekday, 0, 0, 7);
      if (weekday < 1) continue;
      s.rules.push({ groupId: r.groupId, weekday, time: r.time, set: parseChange(r.set) });
    }
  }

  s.eventEdits = {};
  if (isObj(raw.eventEdits)) {
    for (const [k, v] of Object.entries(raw.eventEdits)) s.eventEdits[k] = parseChange(v);
  }

  s.cancelWords = strList(raw.cancelWords, d.cancelWords);
  s.cancelWordsInDescription = typeof raw.cancelWordsInDescription === 'boolean' ? raw.cancelWordsInDescription : d.cancelWordsInDescription;
  if (isObj(raw.window)) {
    s.window = {
      daysBack: num(raw.window.daysBack, d.window.daysBack, 0, 3650),
      daysAhead: raw.window.daysAhead === null ? null : num(raw.window.daysAhead, 365, 1, 3650),
    };
  }
  s.timeZone = str(raw.timeZone, d.timeZone) || d.timeZone;
  s.addRoomLink = typeof raw.addRoomLink === 'boolean' ? raw.addRoomLink : d.addRoomLink;
  if (isObj(raw.target)) {
    s.target = {
      calendarId: str(raw.target.calendarId, '').trim(),
      newCalendarName: str(raw.target.newCalendarName, d.target.newCalendarName) || d.target.newCalendarName,
    };
  }
  if (isObj(raw.autoSync)) {
    s.autoSync = {
      enabled: raw.autoSync.enabled !== false,
      everyHours: Math.round(num(raw.autoSync.everyHours, 1, 1, 24)),
    };
  }
  if (isObj(raw.safety)) {
    s.safety = { maxDeleteFraction: num(raw.safety.maxDeleteFraction, d.safety.maxDeleteFraction, 0, 1) };
  }
  return s;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    throw new SettingsError('The file is not valid JSON.');
  }
}

export function serializeSettings(s: Settings): string {
  return JSON.stringify(s, null, 2);
}
