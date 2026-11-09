import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SAMPLE = readFileSync(fileURLToPath(new URL('./fixtures/tumonline-sample.ics', import.meta.url)), 'utf8');

/** Builds a calendar from VEVENT bodies (arrays of lines), joined with CRLF. */
export function ics(events: string[][], header: string[] = []): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//test//EN',
    ...header,
    ...events.flatMap((e) => ['BEGIN:VEVENT', ...e, 'END:VEVENT']),
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

/** A TUMonline-style event in UTC. */
export function tumEvent(uid: string, summary: string, start: string, end: string, extra: string[] = []): string[] {
  return [`UID:${uid}`, `SUMMARY:${summary}`, `DTSTART:${start}`, `DTEND:${end}`, 'STATUS:CONFIRMED', ...extra];
}

export const NOW = Date.UTC(2026, 9, 1); // 1 Oct 2026, before the sample semester
