/**
 * Entry point of the Apps Script engine. Built into a single `TumCal` object that the
 * generated script calls, e.g. `TumCal.syncNow(SETTINGS)`.
 */
import { parseSettings } from '../core/settings';
import { setOffsetProvider } from '../core/time';
import * as engine from './engine';
import { realEnv, utilitiesOffset } from './env';

function init() {
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', hour: '2-digit' }).formatToParts(new Date());
    if (!p.length) throw new Error('no Intl');
  } catch {
    setOffsetProvider(utilitiesOffset);
  }
  return realEnv();
}

const settingsOf = (s: unknown) => parseSettings(s);

export const VERSION = '0.1.0';

export function setLink(link: string) { engine.setLink(init(), link); }
export function previewSync(s: unknown) { return engine.run(init(), settingsOf(s), { dryRun: true, manual: true }); }
export function syncNow(s: unknown) { return engine.run(init(), settingsOf(s), { manual: true }); }
export function forceSync(s: unknown) { return engine.run(init(), settingsOf(s), { manual: true, force: true }); }
export function autoSync(s: unknown) { return engine.run(init(), settingsOf(s), { manual: false }); }
export function setupAutoSync(s: unknown) { engine.setupAutoSync(init(), settingsOf(s)); }
export function stopAutoSync() { engine.stopAutoSync(init()); }
export function createTimetableCalendar(s: unknown) { engine.createCalendar(init(), settingsOf(s)); }
export function listMyCalendars() { engine.listCalendars(init()); }
export function checkSetup(s: unknown) { engine.checkSetup(init(), settingsOf(s)); }
export function removeMyEvents(s: unknown) { return engine.removeMyEvents(init(), settingsOf(s)); }
export function deleteEverythingInCalendar(s: unknown, confirmation: string) {
  return engine.deleteEverythingInCalendar(init(), settingsOf(s), confirmation);
}
