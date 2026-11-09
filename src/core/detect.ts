/**
 * Course and event-type detection from TUMonline titles. Generic: no course list.
 *
 * Title structure seen in TUMonline feeds:
 *   [type word + "zu"] <course> [(faculty)] [[module code]] [type word] <LV code>, <group>
 * e.g. "Zentralübung zu Analysis 1 (EI) [MA9411] UE, Standardgruppe"
 *      "Digitaltechnik - Tutorien TT, Gruppe 6 - Name"
 *      "Übungen zu Analysis 1 G12"
 *
 * Type priority: type word in title → type word in description note → LV code → unknown.
 * Unknown course or type is never guessed; resolve.ts marks it "needs attention".
 */
import type { SourceEvent } from './calendar';
import type { Settings, TypeDef } from './settings';
import { findPhrase, normalize, tokenize } from './text';

export type TypeSource = 'title' | 'description' | 'code';

export interface TitleInfo {
  courseName: string | null;
  moduleCode?: string;
  lvCode?: string;
  group?: string;
  typeId: string | null;
}

export interface DetectedEvent extends SourceEvent {
  courseId: string | null;
  courseName: string | null;
  moduleCode?: string;
  lvCode?: string;
  group?: string;
  /** The free-text part of the description (after "fix; Abhaltung;"). */
  note: string;
  typeId: string | null;
  typeSource: TypeSource | null;
  /** Cancel word found in title/description, if any. */
  cancelWord?: string;
}

export interface DetectedCourse {
  id: string;
  name: string;
  moduleCode?: string;
  eventCount: number;
  /** Number of events per type id. */
  types: Record<string, number>;
  untyped: number;
}

export interface Detection {
  events: DetectedEvent[];
  /** Ordered by number of events, descending. */
  courses: DetectedCourse[];
}

const LEADING_CONNECTORS = /^(?:zu|zur|zum|für|fuer|for|of|to|in|im)\s+/i;
const GROUP_TAIL = /^(?:standardgruppe|standard group|gruppe\b|group\b|tutorium\s*\d|tutorial\s*\d|g\s?\d+$|\d+$)/;
const TRIM_CHARS = /^[\s\-–—:,;/|·.]+|[\s\-–—:,;/|·]+$/g;

function allCodes(types: TypeDef[]): Set<string> {
  const s = new Set<string>();
  types.forEach((t) => t.codes.forEach((c) => s.add(c.toUpperCase())));
  return s;
}

/** Finds the highest-priority type mentioned as whole words in `text`. */
export function findTypeWord(text: string, types: TypeDef[]): { typeId: string | null; spans: Array<[number, number]>; tokens: ReturnType<typeof tokenize> } {
  const tokens = tokenize(text);
  const spans: Array<[number, number]> = [];
  let typeId: string | null = null;
  for (const t of types) {
    for (const w of t.words) {
      const hits = findPhrase(tokens, w);
      if (hits.length) {
        if (typeId === null) typeId = t.id;
        spans.push(...hits);
      }
    }
  }
  return { typeId, spans, tokens };
}

/** Splits a TUMonline title into course name, codes, group and type. */
export function parseTitle(summary: string, types: TypeDef[]): TitleInfo {
  let s = summary.replace(/\s+/g, ' ').trim();
  const codes = allCodes(types);
  const info: TitleInfo = { courseName: null, typeId: null };

  // 1. ", <group>" at the end. The LV code (VO, UE, ...) always comes right before it.
  const comma = s.lastIndexOf(',');
  if (comma > 0) {
    const head = s.slice(0, comma).trim();
    const tail = s.slice(comma + 1).trim();
    const codeMatch = /\s([A-Z]{2})$/.exec(head);
    const hasCode = !!codeMatch && codes.has(codeMatch[1]);
    if (hasCode || GROUP_TAIL.test(normalize(tail))) {
      info.group = tail;
      s = head;
      if (hasCode) {
        info.lvCode = codeMatch![1];
        s = head.slice(0, -3).trim();
      }
    }
  }
  // 2. Group token like "G12" at the end.
  if (!info.group) {
    const g = /\s(G\d{1,3})$/.exec(s);
    if (g) {
      info.group = g[1];
      s = s.slice(0, -g[0].length).trim();
    }
  }
  // 3. Module code "[MA9411]" and faculty tag "(EI)".
  s = s.replace(/\s*\[([^\]]+)\]/g, (all, code: string) => {
    if (/^[A-Z]{2,5}\s?\d[\w.-]*$/.test(code.trim())) {
      info.moduleCode = code.trim();
      return ' ';
    }
    return all;
  });
  s = s.replace(/\s*\(([A-Z]{2,4})\)(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();

  // 4. Type words: remove them, plus a connector right after a leading type word.
  const tw = findTypeWord(s, types);
  info.typeId = tw.typeId;
  if (tw.spans.length) {
    const remove = new Array<boolean>(tw.tokens.length).fill(false);
    tw.spans.forEach(([a, b]) => { for (let i = a; i <= b; i++) remove[i] = true; });
    let out = '';
    let pos = 0;
    tw.tokens.forEach((tok, i) => {
      if (remove[i]) {
        out += s.slice(pos, tok.start);
        pos = tok.end;
      }
    });
    out += s.slice(pos);
    s = out;
  }
  s = s.replace(/\(\s*\)|\[\s*\]/g, ' ').replace(/\s+/g, ' ').replace(TRIM_CHARS, '');
  for (let i = 0; i < 3 && LEADING_CONNECTORS.test(s); i++) s = s.replace(LEADING_CONNECTORS, '').replace(TRIM_CHARS, '');
  s = s.replace(TRIM_CHARS, '').trim();
  info.courseName = /[\p{L}\p{N}]/u.test(s) ? s : null;
  return info;
}

/** Extracts the free-text note from TUMonline descriptions like "fix; Abhaltung; Zentralübung". */
export function descriptionNote(description: string): string {
  const m = /^\s*([^;\n]{1,20});\s*([^;\n]{1,40});\s*([\s\S]*)$/.exec(description);
  return (m ? m[3] : description).trim();
}

export function typeFromCode(code: string | undefined, types: TypeDef[]): string | null {
  if (!code) return null;
  return types.find((t) => t.codes.map((c) => c.toUpperCase()).includes(code.toUpperCase()))?.id ?? null;
}

export function findCancelWord(e: SourceEvent, note: string, settings: Settings): string | undefined {
  const title = normalize(e.summary);
  const desc = settings.cancelWordsInDescription ? normalize(note) : '';
  return settings.cancelWords.find((w) => {
    const n = normalize(w);
    return !!n && (title.includes(n) || desc.includes(n));
  });
}

/** Id used for rules: the course id, or the raw title for events without a course. */
export function groupIdOf(e: DetectedEvent): string {
  return e.courseId ?? 'raw:' + normalize(e.summary);
}

export function detect(events: SourceEvent[], settings: Settings): Detection {
  const types = settings.types;
  const parsed = events.map((e) => ({ e, t: parseTitle(e.summary, types) }));

  // Courses with the same module code are one course; titles without a code join the coded
  // course with the same name (e.g. "Übungen zu Analysis 1 G12" → MA9411).
  const codeByName = new Map<string, string>();
  for (const { t } of parsed) {
    if (t.courseName && t.moduleCode) codeByName.set(normalize(t.courseName), t.moduleCode);
  }

  const out: DetectedEvent[] = parsed.map(({ e, t }) => {
    const note = descriptionNote(e.description);
    let typeId = t.typeId;
    let typeSource: TypeSource | null = typeId ? 'title' : null;
    if (!typeId) {
      typeId = findTypeWord(note, types).typeId;
      if (typeId) typeSource = 'description';
    }
    if (!typeId) {
      typeId = typeFromCode(t.lvCode, types);
      if (typeId) typeSource = 'code';
    }
    const code = t.moduleCode ?? (t.courseName ? codeByName.get(normalize(t.courseName)) : undefined);
    const courseId = code ? 'm:' + code : t.courseName ? 'n:' + normalize(t.courseName) : null;
    return {
      ...e,
      courseId,
      courseName: t.courseName,
      moduleCode: code,
      lvCode: t.lvCode,
      group: t.group,
      note,
      typeId,
      typeSource,
      cancelWord: findCancelWord(e, note, settings),
    };
  });

  const byId = new Map<string, { events: DetectedEvent[]; names: Map<string, number> }>();
  for (const e of out) {
    if (!e.courseId) continue;
    const g = byId.get(e.courseId) ?? { events: [] as DetectedEvent[], names: new Map<string, number>() };
    g.events.push(e);
    g.names.set(e.courseName!, (g.names.get(e.courseName!) ?? 0) + 1);
    byId.set(e.courseId, g);
  }
  const courses: DetectedCourse[] = [];
  for (const [id, g] of byId) {
    const name = [...g.names.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0][0];
    const typesCount: Record<string, number> = {};
    let untyped = 0;
    for (const e of g.events) {
      if (e.typeId) typesCount[e.typeId] = (typesCount[e.typeId] ?? 0) + 1;
      else untyped++;
    }
    courses.push({ id, name, moduleCode: g.events[0].moduleCode, eventCount: g.events.length, types: typesCount, untyped });
  }
  courses.sort((a, b) => b.eventCount - a.eventCount || a.name.localeCompare(b.name));
  return { events: out, courses };
}
