/**
 * Compares the events that should exist with the events this tool created earlier, and
 * decides what to create, update and delete. Only events carrying the tool's private
 * marker are ever passed in here, so events the user made themselves are never touched.
 */
import type { DesiredEvent } from './resolve';

/** Private extended-property names written on every event this tool creates. */
export const MARKER = 'tumcal';
export const KEY_PROP = 'tumcalKey';
export const HASH_PROP = 'tumcalHash';

/** An event in Google Calendar that carries our marker. */
export interface ManagedEvent {
  id: string;
  key?: string;
  hash?: string;
  summary?: string;
}

export interface DiffResult {
  create: DesiredEvent[];
  update: Array<{ id: string; event: DesiredEvent }>;
  remove: ManagedEvent[];
  unchanged: number;
}

export function diffEvents(desired: DesiredEvent[], existing: ManagedEvent[]): DiffResult {
  const byKey = new Map<string, ManagedEvent>();
  const remove: ManagedEvent[] = [];
  for (const ev of existing) {
    if (!ev.key || byKey.has(ev.key)) remove.push(ev); // no key, or a duplicate → clean up
    else byKey.set(ev.key, ev);
  }
  const create: DesiredEvent[] = [];
  const update: Array<{ id: string; event: DesiredEvent }> = [];
  let unchanged = 0;
  const wanted = new Set<string>();
  for (const d of desired) {
    if (wanted.has(d.key)) continue;
    wanted.add(d.key);
    const cur = byKey.get(d.key);
    if (!cur) create.push(d);
    else if (cur.hash !== d.hash) update.push({ id: cur.id, event: d });
    else unchanged++;
  }
  for (const [key, ev] of byKey) if (!wanted.has(key)) remove.push(ev);
  return { create, update, remove, unchanged };
}

/** The request body sent to the Calendar API for a create (POST) or full update (PUT). */
export function toGoogleBody(d: DesiredEvent): Record<string, unknown> {
  const body: Record<string, unknown> = {
    summary: d.summary,
    description: d.description,
    location: d.location,
    start: d.start,
    end: d.end,
    extendedProperties: { private: { [MARKER]: '1', [KEY_PROP]: d.key, [HASH_PROP]: d.hash } },
  };
  if (d.colorId) body.colorId = d.colorId;
  return body;
}
