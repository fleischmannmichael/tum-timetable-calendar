/**
 * Builds the personalised Google Apps Script: a readable header with setup steps, the
 * user's settings as JSON, small wrapper functions to run, and the bundled engine.
 * The iCal link is NOT put into the script; the user pastes it into setLink() once.
 */
import { serializeSettings, type Settings } from '../core/settings';
import { DELETE_ALL_CONFIRMATION } from '../gas/engine';

export interface GenerateOptions {
  engineSource: string;
  toolUrl?: string;
  generatedAt?: Date;
}

export function generateScript(settings: Settings, opts: GenerateOptions): string {
  const date = (opts.generatedAt ?? new Date()).toISOString().slice(0, 10);
  const calendarLine = settings.target.calendarId
    ? `Target calendar: ${settings.target.calendarId}`
    : `Target calendar: a new calendar "${settings.target.newCalendarName}" is created on the first syncNow.`;
  const json = serializeSettings(settings)
    .split('\n')
    .map((l, i) => (i === 0 ? l : '  ' + l))
    .join('\n');

  return `/**
 * TUM timetable → Google Calendar   (generated ${date}${opts.toolUrl ? ' with ' + opts.toolUrl : ''})
 *
 * Copies your TUMonline timetable into Google Calendar with your names and colours,
 * and keeps it up to date. It only ever changes events it created itself (they carry
 * a hidden marker), never your own events.
 *
 * ${calendarLine}
 *
 * SETUP (once):
 *   1. Editor left side: "Services" (+) → "Google Calendar API" → Add.
 *   2. Paste your TUMonline iCal link into setLink() below, select "setLink" in the
 *      toolbar and press Run. Allow the permissions Google asks for.
 *      Then DELETE the link from the code again (it is now stored privately).
 *   3. Run "previewSync": the log shows what would be created/changed/deleted.
 *   4. Run "syncNow" to write your calendar.
 *   5. Optional: run "setupAutoSync" to update automatically every ${settings.autoSync.everyHours} hour(s).
 *
 * FUNCTIONS you can run (pick in the toolbar, press Run):
 *   previewSync        show what would change, change nothing
 *   syncNow            sync now (skips if nothing changed)
 *   forceSync          sync even if nothing seems changed
 *   setupAutoSync      turn on automatic updates      stopAutoSync   turn them off
 *   checkSetup         show what is configured
 *   listMyCalendars    list your calendars and their IDs
 *   removeMyEvents     delete all events this script created
 *   deleteEverythingInCalendar   delete ALL events in the target calendar (see below)
 *
 * To change names/colours: edit SETTINGS below, or import them into the web tool,
 * change them there and generate a new script.
 */

// ============================== YOUR SETTINGS ==============================
const SETTINGS = ${json};

// ============================== FUNCTIONS TO RUN ===========================
function setLink() {
  // Paste your TUMonline iCal link between the quotes, run setLink once, then delete it again.
  const LINK = "PASTE_YOUR_TUMONLINE_ICAL_LINK_HERE";
  TumCal.setLink(LINK);
}
function previewSync()   { TumCal.previewSync(SETTINGS); }
function syncNow()       { TumCal.syncNow(SETTINGS); }
function forceSync()     { TumCal.forceSync(SETTINGS); }
function autoSync()      { TumCal.autoSync(SETTINGS); }   // used by the automatic trigger
function setupAutoSync() { TumCal.setupAutoSync(SETTINGS); }
function stopAutoSync()  { TumCal.stopAutoSync(); }
function checkSetup()    { TumCal.checkSetup(SETTINGS); }
function listMyCalendars() { TumCal.listMyCalendars(); }
function createTimetableCalendar() { TumCal.createTimetableCalendar(SETTINGS); }
function removeMyEvents() { TumCal.removeMyEvents(SETTINGS); }
function deleteEverythingInCalendar() {
  // WARNING: deletes EVERY event in the target calendar, also ones this script didn't make
  // (e.g. leftovers from older scripts). Never runs on your main calendar.
  // To confirm, change the text to "${DELETE_ALL_CONFIRMATION}".
  const CONFIRM = "no";
  TumCal.deleteEverythingInCalendar(SETTINGS, CONFIRM);
}

// ============================== ENGINE (generated, do not edit) =============
${opts.engineSource.trim()}
`;
}
