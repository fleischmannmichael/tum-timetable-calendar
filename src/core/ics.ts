/**
 * Low-level iCalendar (RFC 5545) reader: line unfolding, content lines with (quoted)
 * parameters, nested components (VEVENT, VALARM, VTIMEZONE, ...) and text unescaping.
 * It knows nothing about TUMonline; see calendar.ts for the event model.
 */

export interface IcsProperty {
  name: string;
  params: Record<string, string>;
  value: string;
}

export interface IcsComponent {
  name: string;
  properties: IcsProperty[];
  components: IcsComponent[];
}

export class IcsError extends Error {}

/** Joins folded lines (CRLF/LF followed by a space or tab) and splits into logical lines. */
export function unfoldLines(text: string): string[] {
  return text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n');
}

/**
 * Parses one content line, e.g. `DTSTART;TZID="Europe/Berlin":20261020T100000`.
 * Quoted parameter values may contain `:`, `;` and `,`. Returns null for junk lines.
 */
export function parseContentLine(line: string): IcsProperty | null {
  const m = /^[A-Za-z0-9-]+/.exec(line);
  if (!m) return null;
  const name = m[0].toUpperCase();
  let i = m[0].length;
  const params: Record<string, string> = {};
  while (line[i] === ';') {
    i++;
    const eq = line.indexOf('=', i);
    if (eq < 0) return null;
    const pname = line.slice(i, eq).toUpperCase();
    i = eq + 1;
    const values: string[] = [];
    for (;;) {
      if (line[i] === '"') {
        const close = line.indexOf('"', i + 1);
        if (close < 0) return null;
        values.push(line.slice(i + 1, close));
        i = close + 1;
      } else {
        let j = i;
        while (j < line.length && line[j] !== ';' && line[j] !== ':' && line[j] !== ',') j++;
        values.push(line.slice(i, j));
        i = j;
      }
      if (line[i] === ',') { i++; continue; }
      break;
    }
    params[pname] = values.join(',');
  }
  if (line[i] !== ':') return null;
  return { name, params, value: line.slice(i + 1) };
}

/** Parses iCalendar text and returns the first VCALENDAR. Throws IcsError if there is none. */
export function parseIcs(text: string): IcsComponent {
  const root: IcsComponent = { name: 'ROOT', properties: [], components: [] };
  const stack: IcsComponent[] = [root];
  for (const raw of unfoldLines(text)) {
    const line = raw.replace(/\s+$/, '');
    if (!line) continue;
    const p = parseContentLine(line);
    if (!p) continue;
    const top = stack[stack.length - 1];
    if (p.name === 'BEGIN') {
      const c: IcsComponent = { name: p.value.trim().toUpperCase(), properties: [], components: [] };
      top.components.push(c);
      stack.push(c);
    } else if (p.name === 'END') {
      const want = p.value.trim().toUpperCase();
      // Tolerate missing END lines: close up to the matching component.
      let k = stack.length - 1;
      while (k > 0 && stack[k].name !== want) k--;
      if (k > 0) stack.length = k;
    } else {
      top.properties.push(p);
    }
  }
  const cal = root.components.find((c) => c.name === 'VCALENDAR');
  if (!cal) {
    throw new IcsError(
      'This is not an iCalendar file (no BEGIN:VCALENDAR). The download probably returned an error page.',
    );
  }
  return cal;
}

/** Undoes iCalendar TEXT escaping: \n, \N, \, \; \\ */
export function unescapeText(v: string): string {
  return v.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

export function getProp(c: IcsComponent, name: string): IcsProperty | undefined {
  return c.properties.find((p) => p.name === name);
}

export function getProps(c: IcsComponent, name: string): IcsProperty[] {
  return c.properties.filter((p) => p.name === name);
}

export function getText(c: IcsComponent, name: string): string {
  const p = getProp(c, name);
  return p ? unescapeText(p.value).trim() : '';
}
