/**
 * The web configurator: Import → Courses → Preview → Get script.
 * Everything runs in the browser. Only settings are stored (localStorage); the timetable and
 * the iCal link are kept in memory for this tab only.
 */
import './style.css';
import { Calendar, type EventInput } from '@fullcalendar/core';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import listPlugin from '@fullcalendar/list';
import engineSource from '../../dist-gas/tumcal-engine.js?raw';

import { parseCalendar, type ParseResult } from '../core/calendar';
import { colorById } from '../core/colors';
import { detect, type DetectedCourse, type Detection } from '../core/detect';
import { ensureCourseColors, findRule, resolve, resolveEvent, type DesiredEvent, type Resolution, type SkippedEvent } from '../core/resolve';
import { defaultSettings, parseSettings, serializeSettings, type EventChange, type Settings, type TypeDef } from '../core/settings';
import { normalize } from '../core/text';
import { localParts } from '../core/time';
import { colorPicker } from './colorpicker';
import { clear, h } from './dom';
import { generateScript } from './generate';
import { downloadText, forgetSettings, loadSettings, saveSettings } from './storage';

type Tab = 'import' | 'courses' | 'preview' | 'script';

interface State {
  settings: Settings;
  parse: ParseResult | null;
  sourceName: string;
  detection: Detection | null;
  resolution: Resolution | null;
  isDemo: boolean;
  tab: Tab;
  colorReuse: boolean;
  showHidden: boolean;
  message: { kind: 'error' | 'info'; text: string } | null;
  generated: string;
  calendarDate: Date | null;
}

const state: State = {
  settings: loadSettings(),
  parse: null,
  sourceName: '',
  detection: null,
  resolution: null,
  isDemo: false,
  tab: 'import',
  colorReuse: false,
  showHidden: false,
  message: null,
  generated: '',
  calendarDate: null,
};

const app = document.getElementById('app')!;
let calendar: Calendar | null = null;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const SKIP_LABEL: Record<string, string> = {
  'outside-window': 'outside the date range',
  'cancel-word': 'cancelled (word in title)',
  'course-off': 'course turned off',
  'type-hidden': 'type hidden',
  removed: 'removed by you',
};

// ------------------------------------------------------------------ data flow

function nowRef(): number {
  // The demo timetable is from a fixed semester; anchor its date window to its own start.
  if (state.isDemo && state.parse?.events.length) return state.parse.events[0].startMs;
  return Date.now();
}

function recompute(): void {
  if (!state.parse) return;
  state.detection = detect(state.parse.events, state.settings);
  state.colorReuse = ensureCourseColors(state.detection, state.settings).reused;
  state.resolution = resolve(state.detection, state.settings, nowRef());
  state.generated = '';
  saveSettings(state.settings);
}

/** Call after any settings change. `full` re-renders the page; otherwise only live parts. */
function changed(full = true): void {
  recompute();
  if (full) render();
  else refreshLive();
}

function loadFeed(text: string, name: string, isDemo = false): void {
  try {
    if (!text.includes('BEGIN:VCALENDAR')) throw new Error('This is not an iCalendar (.ics) file. If it came from a link, the link may have returned an error page.');
    const p = parseCalendar(text, { defaultTimeZone: state.settings.timeZone });
    if (p.veventCount === 0) throw new Error('The calendar contains no events.');
    state.parse = p;
    state.sourceName = name;
    state.isDemo = isDemo;
    state.message = null;
    state.calendarDate = null;
    recompute();
  } catch (e) {
    state.message = { kind: 'error', text: (e as Error).message };
  }
  render();
}

async function loadFromLink(link: string): Promise<void> {
  const l = link.trim();
  if (!/^https:\/\//i.test(l)) {
    state.message = { kind: 'error', text: 'Please paste the full link starting with https://' };
    return render();
  }
  state.message = { kind: 'info', text: 'Loading…' };
  render();
  try {
    const res = await fetch(l, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok) throw new Error(`TUMonline answered HTTP ${res.status}. Check the link or create a new one in TUMonline.`);
    loadFeed(await res.text(), 'your TUMonline link');
  } catch (e) {
    state.message = {
      kind: 'error',
      text:
        e instanceof TypeError
          ? 'Your browser was not allowed to read the link directly (TUMonline does not permit this for other websites). Open the link in a new browser tab: it downloads a .ics file. Then upload that file above.'
          : (e as Error).message,
    };
    render();
  }
}

// ------------------------------------------------------------------ helpers

const typeDef = (id: string | null | undefined): TypeDef | undefined => state.settings.types.find((t) => t.id === id);
const courseName = (c: DetectedCourse) => state.settings.courses[c.id]?.name || c.name;

function attentionEvents(): DesiredEvent[] {
  return state.resolution?.desired.filter((d) => d.attention.length) ?? [];
}

function allItems(): Array<{ event: DesiredEvent; skipped?: SkippedEvent }> {
  const r = state.resolution;
  if (!r) return [];
  return [
    ...r.desired.map((event) => ({ event })),
    ...r.skipped.filter((s) => s.preview).map((s) => ({ event: s.preview!, skipped: s })),
  ];
}

function wallClock(ms: number): string {
  const p = localParts(ms, state.settings.timeZone);
  return `${p.date}T${p.time}:00`;
}

function fmtWhen(e: DesiredEvent): string {
  const s = e.source;
  if (s.allDay) return `${WEEKDAYS[e.weekday - 1]} ${s.startDate} (all day)`;
  const a = localParts(s.startMs, state.settings.timeZone);
  const b = localParts(s.endMs, state.settings.timeZone);
  return `${WEEKDAYS[a.weekday - 1]} ${a.date.split('-').reverse().join('.')} ${a.time}–${b.time}`;
}

function note(kind: 'warn' | 'error' | 'info' | 'ok', ...children: Array<Node | string | null>): HTMLElement {
  return h('div', { class: `note note-${kind}`, role: kind === 'error' ? 'alert' : undefined }, ...children);
}

function goto(tab: Tab): void {
  state.tab = tab;
  render();
  window.scrollTo({ top: 0 });
}

// ------------------------------------------------------------------ layout

function render(): void {
  if (calendar) {
    state.calendarDate = calendar.getDate();
    calendar.destroy();
    calendar = null;
  }
  clear(app);
  const ready = !!state.parse;
  const tabs: Array<[Tab, string]> = [['import', '1 · Import'], ['courses', '2 · Courses'], ['preview', '3 · Preview & edit'], ['script', '4 · Get script']];
  app.append(
    h('header', { class: 'top' },
      h('div', { class: 'wrap' },
        h('h1', null, 'TUM Timetable ', h('span', { class: 'arrow' }, '→'), ' Google Calendar'),
        h('p', { class: 'muted' }, 'Runs entirely in your browser. Nothing is uploaded. Not an official TUM tool.'))),
    h('nav', { class: 'tabs', 'aria-label': 'Steps' },
      h('div', { class: 'wrap' },
        ...tabs.map(([id, label]) =>
          h('button', {
            type: 'button', class: 'tab' + (state.tab === id ? ' active' : ''), disabled: id !== 'import' && !ready,
            'aria-current': state.tab === id ? 'step' : undefined, onclick: () => goto(id),
          }, label)))),
  );
  const main = h('main', { class: 'wrap' });
  if (state.message) main.append(note(state.message.kind === 'error' ? 'error' : 'info', state.message.text));
  if (state.tab === 'import' || !ready) main.append(importTab());
  else if (state.tab === 'courses') main.append(coursesTab());
  else if (state.tab === 'preview') main.append(previewTab());
  else main.append(scriptTab());
  app.append(main, h('footer', { class: 'wrap muted' }, 'Open source · MIT licence · Settings are saved only in this browser.'));
  if (state.tab === 'preview' && ready) mountCalendar();
}

/** Updates the parts that depend on settings without rebuilding inputs (keeps focus). */
function refreshLive(): void {
  const ex = document.getElementById('template-example');
  if (ex) ex.textContent = exampleTitle();
  if (calendar) {
    calendar.removeAllEventSources();
    calendar.addEventSource(calendarEvents());
  }
  const tb = document.getElementById('preview-toolbar');
  if (tb) tb.replaceWith(previewToolbar());
}

// ------------------------------------------------------------------ 1. import

function importTab(): HTMLElement {
  const fileInput = h('input', {
    type: 'file', accept: '.ics,text/calendar', class: 'visually-hidden', id: 'ics-file',
    onchange: async (ev: Event) => {
      const f = (ev.target as HTMLInputElement).files?.[0];
      if (f) loadFeed(await f.text(), f.name);
    },
  });
  const drop = h('label', {
    class: 'drop', for: 'ics-file',
    ondragover: (ev: DragEvent) => { ev.preventDefault(); drop.classList.add('over'); },
    ondragleave: () => drop.classList.remove('over'),
    ondrop: async (ev: DragEvent) => {
      ev.preventDefault();
      drop.classList.remove('over');
      const f = ev.dataTransfer?.files?.[0];
      if (f) loadFeed(await f.text(), f.name);
    },
  }, h('strong', null, 'Choose your .ics file'), h('span', { class: 'muted' }, 'or drop it here'));

  const linkInput = h('input', { type: 'password', placeholder: 'https://campus.tum.de/…', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'TUMonline iCal link' });
  const show = h('button', { type: 'button', class: 'btn-ghost', onclick: () => { linkInput.type = linkInput.type === 'password' ? 'text' : 'password'; } }, 'Show');

  const card = h('section', { class: 'card' },
    h('h2', null, 'Your TUMonline timetable'),
    h('p', null, 'In TUMonline, open your personal calendar and use its export / subscribe (iCal) function. Copy the link it gives you. ',
      'Open that link in a new browser tab to download a ', h('code', null, '.ics'), ' file, then choose it here.'),
    fileInput, drop,
    h('details', { class: 'more' },
      h('summary', null, 'Or try loading the link directly'),
      h('p', { class: 'muted' }, 'This usually fails because TUMonline does not let other websites read it; then use the file. ',
        'The link contains a personal password-like token: it is used only in this tab and never stored or sent anywhere except to TUMonline.'),
      h('div', { class: 'row' }, linkInput, show,
        h('button', { type: 'button', class: 'btn', onclick: () => { const v = linkInput.value; linkInput.value = ''; void loadFromLink(v); } }, 'Load'))),
    h('p', null, h('button', { type: 'button', class: 'btn-ghost', onclick: () => void loadDemo() }, 'No timetable at hand? Try an anonymised demo')),
  );

  const parts: HTMLElement[] = [card];
  if (state.parse && state.detection && state.resolution) parts.unshift(importSummary());
  parts.push(settingsFileCard());
  return h('div', { class: 'stack' }, ...parts);
}

async function loadDemo(): Promise<void> {
  const mod = await import('../../tests/fixtures/tumonline-sample.ics?raw');
  loadFeed(mod.default, 'demo timetable', true);
}

function importSummary(): HTMLElement {
  const p = state.parse!, d = state.detection!, r = state.resolution!;
  const attn = attentionEvents().length;
  const counts = r.skipped.reduce<Record<string, number>>((a, s) => ({ ...a, [s.reason]: (a[s.reason] ?? 0) + 1 }), {});
  return h('section', { class: 'card card-ok' },
    h('h2', null, `Loaded ${state.sourceName}`),
    h('ul', { class: 'facts' },
      h('li', null, h('strong', null, String(p.events.length)), ' dates in ', h('strong', null, String(d.courses.length)), ' courses'),
      h('li', null, h('strong', null, String(r.desired.length)), ' will be copied with your current settings'),
      ...Object.entries(counts).map(([k, n]) => h('li', { class: 'muted' }, `${n} skipped: ${SKIP_LABEL[k] ?? k}`)),
      p.cancelled.length ? h('li', { class: 'muted' }, `${p.cancelled.length} marked as cancelled in TUMonline (not copied)`) : null,
      attn ? h('li', { class: 'attn' }, `${attn} need attention (course or type not recognised)`) : h('li', null, 'All courses and event types recognised ✓'),
    ),
    p.warnings.length || r.desired.some((x) => x.source.warnings.length)
      ? h('details', { class: 'more' }, h('summary', null, 'Notes from reading the file'),
        h('ul', null, ...p.warnings.map((w) => h('li', null, w))))
      : null,
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', onclick: () => goto('courses') }, 'Next: customise courses →')),
  );
}

function settingsFileCard(): HTMLElement {
  const input = h('input', {
    type: 'file', accept: '.json,application/json', class: 'visually-hidden', id: 'settings-file',
    onchange: async (ev: Event) => {
      const f = (ev.target as HTMLInputElement).files?.[0];
      if (!f) return;
      try {
        state.settings = parseSettings(await f.text());
        state.message = { kind: 'info', text: `Settings imported from ${f.name}.` };
        changed();
      } catch (e) {
        state.message = { kind: 'error', text: 'Could not import settings: ' + (e as Error).message };
        render();
      }
    },
  });
  return h('section', { class: 'card' },
    h('h2', null, 'Settings file'),
    h('p', { class: 'muted' }, 'Your names, colours and fixes are saved in this browser automatically. Export them to keep a backup or move to another device. The file contains no link and no timetable.'),
    input,
    h('div', { class: 'row' },
      h('label', { class: 'btn-ghost', for: 'settings-file' }, 'Import settings…'),
      h('button', { type: 'button', class: 'btn-ghost', onclick: exportSettings }, 'Export settings')),
  );
}

function exportSettings(): void {
  downloadText('tum-calendar-settings.json', serializeSettings(state.settings), 'application/json');
}

// ------------------------------------------------------------------ 2. courses

function exampleTitle(): string {
  const r = state.resolution;
  if (!r) return '';
  const pick = r.desired.find((d) => d.courseId && d.typeId) ?? r.desired[0];
  return pick ? `${pick.summary}    ← from “${pick.source.summary}”` : '(no events)';
}

function coursesTab(): HTMLElement {
  const s = state.settings, d = state.detection!;
  const attn = attentionEvents().length;
  const enabledCount = d.courses.filter((c) => s.courses[c.id]?.enabled !== false).length;

  const template = h('section', { class: 'card' },
    h('h2', null, 'Event titles'),
    h('label', { class: 'field' }, h('span', null, 'Title template'),
      h('input', {
        value: s.titleTemplate, spellcheck: 'false',
        oninput: (ev: Event) => { s.titleTemplate = (ev.target as HTMLInputElement).value; changed(false); },
      })),
    h('p', { class: 'muted small' }, 'Placeholders: {type} {course} {group} {code} {original} {location}. Separators next to an empty placeholder are removed.'),
    h('p', { class: 'example' }, h('span', { class: 'muted small' }, 'Example: '), h('span', { id: 'template-example' }, exampleTitle())),
    h('p', { class: 'muted small' }, 'The original TUMonline title is always kept in the event description.'),
  );

  const usedBy: Record<string, string[]> = {};
  for (const c of d.courses) {
    const cs = s.courses[c.id];
    if (cs?.color && cs.enabled !== false) (usedBy[cs.color] ??= []).push(courseName(c));
  }

  return h('div', { class: 'stack' },
    template,
    state.colorReuse ? note('warn', `You have ${enabledCount} courses but Google Calendar has only 11 colours, so some courses share a colour. Turn off courses you don't need or pick colours by hand.`) : null,
    attn ? note('warn', `${attn} dates need attention: their course or type was not recognised. `, h('button', { type: 'button', class: 'linklike', onclick: () => goto('preview') }, 'Fix them in the preview →')) : null,
    h('section', { class: 'card' },
      h('h2', null, `Courses (${d.courses.length})`),
      h('p', { class: 'muted small' }, 'Rename, colour, turn off, and set the label per event type. An empty label means no label; “hide” skips that type for this course.'),
      h('div', { class: 'courses' }, ...d.courses.map((c) => courseCard(c, usedBy)))),
    advancedCard(),
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', onclick: () => goto('preview') }, 'Next: preview →')),
  );
}

function courseCard(c: DetectedCourse, usedBy: Record<string, string[]>): HTMLElement {
  const s = state.settings;
  const cs = (s.courses[c.id] ??= {});
  const enabled = cs.enabled !== false;
  const others: Record<string, string[]> = {};
  for (const [col, names] of Object.entries(usedBy)) others[col] = names.filter((n) => n !== courseName(c));
  const typeIds = s.types.map((t) => t.id).filter((id) => c.types[id]);
  const unknownTypes = Object.keys(c.types).filter((id) => !typeIds.includes(id));

  return h('article', { class: 'course' + (enabled ? '' : ' off') },
    h('div', { class: 'course-head' },
      h('input', {
        type: 'checkbox', checked: enabled, title: 'Copy this course', 'aria-label': `Copy ${c.name}`,
        onchange: (ev: Event) => { if ((ev.target as HTMLInputElement).checked) delete cs.enabled; else cs.enabled = false; changed(); },
      }),
      h('input', {
        class: 'course-name', value: cs.name ?? '', placeholder: c.name, 'aria-label': `Name for ${c.name}`,
        onchange: (ev: Event) => {
          const v = (ev.target as HTMLInputElement).value.trim();
          if (v && v !== c.name) cs.name = v; else delete cs.name;
          changed();
        },
      }),
      colorPicker({ value: cs.color, usedBy: others, onChange: (id) => { if (id) cs.color = id; changed(); } }),
      h('span', { class: 'muted small' }, `${c.eventCount} dates${c.moduleCode ? ' · ' + c.moduleCode : ''}`),
    ),
    cs.name ? h('div', { class: 'muted small orig' }, `TUMonline: ${c.name}`) : null,
    h('div', { class: 'types' },
      ...[...typeIds, ...unknownTypes].map((tid) => typeChip(c, tid)),
      c.untyped ? h('span', { class: 'chip chip-attn' }, `${c.untyped} without type`) : null),
  );
}

function typeChip(c: DetectedCourse, typeId: string): HTMLElement {
  const cs = state.settings.courses[c.id];
  const t = typeDef(typeId);
  const def = t?.label ?? '';
  const hidden = !!cs.hiddenTypes?.includes(typeId);
  const value = cs.typeLabels?.[typeId] ?? def;
  return h('span', { class: 'chip' + (hidden ? ' chip-off' : '') },
    h('span', { class: 'chip-name' }, `${t?.name ?? typeId} (${c.types[typeId]})`),
    h('input', {
      class: 'chip-label', value, size: 6, placeholder: '(none)', 'aria-label': `Label for ${t?.name ?? typeId} in ${c.name}`,
      onchange: (ev: Event) => {
        const v = (ev.target as HTMLInputElement).value.trim();
        cs.typeLabels ??= {};
        if (v === def) delete cs.typeLabels[typeId]; else cs.typeLabels[typeId] = v;
        if (!Object.keys(cs.typeLabels).length) delete cs.typeLabels;
        changed();
      },
    }),
    h('label', { class: 'chip-hide' },
      h('input', {
        type: 'checkbox', checked: hidden,
        onchange: (ev: Event) => {
          const on = (ev.target as HTMLInputElement).checked;
          const set = new Set(cs.hiddenTypes ?? []);
          if (on) set.add(typeId); else set.delete(typeId);
          if (set.size) cs.hiddenTypes = [...set]; else delete cs.hiddenTypes;
          changed();
        },
      }), 'hide'),
  );
}

function advancedCard(): HTMLElement {
  const s = state.settings;
  const list = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);
  const typeRows = s.types.map((t, i) =>
    h('tr', null,
      h('td', null, h('input', { value: t.name, 'aria-label': 'Type name', onchange: (ev: Event) => { t.name = (ev.target as HTMLInputElement).value.trim() || t.id; changed(); } })),
      h('td', null, h('input', { value: t.label, size: 6, 'aria-label': 'Default label', onchange: (ev: Event) => { t.label = (ev.target as HTMLInputElement).value.trim(); changed(); } })),
      h('td', null, h('textarea', { rows: 2, 'aria-label': 'Words', onchange: (ev: Event) => { t.words = list((ev.target as HTMLTextAreaElement).value); changed(); } }, t.words.join(', '))),
      h('td', null, h('input', { value: t.codes.join(', '), size: 8, 'aria-label': 'Codes', onchange: (ev: Event) => { t.codes = list((ev.target as HTMLInputElement).value).map((c) => c.toUpperCase()); changed(); } })),
      h('td', null,
        h('button', { type: 'button', class: 'btn-icon', title: 'Higher priority', disabled: i === 0, onclick: () => { s.types.splice(i - 1, 0, s.types.splice(i, 1)[0]); changed(); } }, '↑'),
        h('button', { type: 'button', class: 'btn-icon', title: 'Remove type', onclick: () => { if (confirm(`Remove the type “${t.name}”?`)) { s.types.splice(i, 1); changed(); } } }, '×')),
    ));
  return h('details', { class: 'card more' },
    h('summary', null, h('h2', { class: 'inline' }, 'Advanced settings')),
    h('h3', null, 'Event types'),
    h('p', { class: 'muted small' }, 'Detection checks types from top to bottom (so “Zentralübung” wins over “Übung”). Words match whole words only, umlauts can be written as ae/oe/ue. Codes are TUMonline course-type codes at the end of a title (VO, UE, …).'),
    h('div', { class: 'table-wrap' },
      h('table', { class: 'types-table' },
        h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Label'), h('th', null, 'Words (comma-separated)'), h('th', null, 'Codes'), h('th', null, ''))),
        h('tbody', null, ...typeRows))),
    h('button', {
      type: 'button', class: 'btn-ghost', onclick: () => {
        const name = prompt('Name of the new event type (e.g. Sprechstunde):')?.trim();
        if (!name) return;
        let id = normalize(name).replace(/[^a-z0-9]+/g, '-') || 'type';
        while (s.types.some((t) => t.id === id)) id += '-2';
        s.types.push({ id, name, label: name, words: [normalize(name)], codes: [] });
        changed();
      },
    }, '+ Add type'),
    h('h3', null, 'Cancelled events'),
    h('label', { class: 'field' }, h('span', null, 'Words that mark an event as cancelled (comma-separated)'),
      h('textarea', { rows: 2, onchange: (ev: Event) => { s.cancelWords = list((ev.target as HTMLTextAreaElement).value); changed(); } }, s.cancelWords.join(', '))),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.cancelWordsInDescription, onchange: (ev: Event) => { s.cancelWordsInDescription = (ev.target as HTMLInputElement).checked; changed(); } }),
      'Also look for these words in the description (TUMonline puts notes there)'),
    h('h3', null, 'Dates and details'),
    h('div', { class: 'row' },
      h('label', { class: 'field' }, h('span', null, 'Copy dates from … days ago'),
        h('input', { type: 'number', min: 0, max: 365, value: String(s.window.daysBack), onchange: (ev: Event) => { s.window.daysBack = Math.max(0, +(ev.target as HTMLInputElement).value || 0); changed(); } })),
      h('label', { class: 'field' }, h('span', null, '… up to days ahead (empty = all)'),
        h('input', { type: 'number', min: 1, max: 3650, value: s.window.daysAhead === null ? '' : String(s.window.daysAhead), onchange: (ev: Event) => { const v = (ev.target as HTMLInputElement).value; s.window.daysAhead = v ? Math.max(1, +v) : null; changed(); } }))),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.addRoomLink, onchange: (ev: Event) => { s.addRoomLink = (ev.target as HTMLInputElement).checked; changed(); } }),
      'Add a NavigaTUM room link to the description'),
    h('p', null, h('button', {
      type: 'button', class: 'btn-danger', onclick: () => {
        if (!confirm('Reset ALL settings (names, colours, fixes) to defaults? Export them first if you want a backup.')) return;
        forgetSettings();
        state.settings = defaultSettings();
        changed();
      },
    }, 'Reset all settings')),
  );
}

// ------------------------------------------------------------------ 3. preview

function previewToolbar(): HTMLElement {
  const d = state.detection!, s = state.settings;
  const attn = attentionEvents();
  const hiddenCount = state.resolution!.skipped.filter((x) => x.preview).length;
  return h('div', { class: 'toolbar', id: 'preview-toolbar' },
    h('div', { class: 'legend' },
      ...d.courses.filter((c) => s.courses[c.id]?.enabled !== false).map((c) =>
        h('span', { class: 'legend-item' }, h('span', { class: 'swatch', style: { background: colorById(s.courses[c.id]?.color)?.hex ?? '#999' } }), courseName(c)))),
    h('div', { class: 'row' },
      attn.length
        ? h('button', {
            type: 'button', class: 'btn-warn', onclick: () => {
              const cur = calendar?.getDate().getTime() ?? 0;
              const next = attn.find((a) => a.source.startMs > cur + 7 * 86400000) ?? attn[0];
              calendar?.gotoDate(wallClock(next.source.startMs).slice(0, 10));
            },
          }, `⚠ ${attn.length} need attention: show next`)
        : h('span', { class: 'ok small' }, 'All events recognised ✓'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: state.showHidden, onchange: (ev: Event) => { state.showHidden = (ev.target as HTMLInputElement).checked; refreshLive(); } }),
        `Show skipped (${hiddenCount})`)),
  );
}

function previewTab(): HTMLElement {
  return h('div', { class: 'stack' },
    h('section', { class: 'card' },
      h('p', { class: 'muted small' }, 'This is how your Google Calendar will look. Click an event to change its title, colour, location or type, or to remove it, for this date or for all dates like it.'),
      previewToolbar(),
      h('div', { id: 'calendar' })),
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', onclick: () => goto('script') }, 'Next: get your script →')),
  );
}

function calendarEvents(): EventInput[] {
  const items = allItems().filter((i) => !i.skipped || state.showHidden);
  return items.map(({ event: e, skipped }) => {
    const col = colorById(e.colorId);
    const bg = col?.hex ?? '#9e9e9e';
    const s = e.source;
    return {
      id: e.key,
      title: (skipped ? '(skipped) ' : e.attention.length ? '⚠ ' : '') + e.summary,
      start: s.allDay ? s.startDate : wallClock(s.startMs),
      end: s.allDay ? s.endDate : wallClock(s.endMs),
      allDay: s.allDay,
      backgroundColor: bg,
      borderColor: e.attention.length ? '#d50000' : bg,
      textColor: e.colorId === '5' ? '#202124' : '#ffffff',
      classNames: [skipped ? 'ev-skipped' : '', e.attention.length ? 'ev-attn' : ''].filter(Boolean),
    };
  });
}

function mountCalendar(): void {
  const el = document.getElementById('calendar');
  if (!el || !state.resolution) return;
  const first = state.resolution.desired.find((d) => d.source.endMs >= Date.now()) ?? state.resolution.desired[0];
  const hasWeekend = state.resolution.desired.some((d) => d.weekday >= 6);
  calendar = new Calendar(el, {
    plugins: [timeGridPlugin, dayGridPlugin, listPlugin],
    // Events are given as Munich wall-clock times and shown "as UTC", so the preview shows
    // TUM times regardless of the viewer's computer time zone.
    timeZone: 'UTC',
    initialView: window.innerWidth < 700 ? 'listWeek' : 'timeGridWeek',
    initialDate: state.calendarDate ?? (first ? wallClock(first.source.startMs).slice(0, 10) : undefined),
    firstDay: 1,
    weekends: hasWeekend,
    locale: 'en-GB',
    headerToolbar: { left: 'prev,next today', center: 'title', right: 'timeGridWeek,dayGridMonth,listWeek' },
    buttonText: { today: 'Today', timeGridWeek: 'Week', dayGridMonth: 'Month', listWeek: 'List' },
    slotMinTime: '07:00:00',
    slotMaxTime: '21:00:00',
    allDaySlot: true,
    height: 'auto',
    expandRows: true,
    slotEventOverlap: false,
    dayMaxEvents: 4,
    eventTimeFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
    slotLabelFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
    events: calendarEvents(),
    eventClick: (info) => openEditor(info.event.id),
    eventDidMount: (info) => {
      const it = allItems().find((x) => x.event.key === info.event.id);
      if (it) info.el.title = [it.event.summary, it.event.location, ...it.event.attention.map((a) => '⚠ ' + a)].filter(Boolean).join('\n');
    },
  });
  calendar.render();
}

// ------------------------------------------------------------------ event editor

function openEditor(key: string): void {
  const s = state.settings;
  const item = allItems().find((x) => x.event.key === key);
  if (!item) return;
  const e = item.event;
  const src = e.source;
  const slotLabel = `${src.courseId ? state.settings.courses[src.courseId]?.name || src.courseName : src.summary} · ${WEEKDAYS[e.weekday - 1]} ${e.time}`;
  const likeThis = allItems().filter((x) => x.event.groupId === e.groupId && x.event.weekday === e.weekday && x.event.time === e.time).length;
  const rule = () => findRule(s.rules, e.groupId, e.weekday, e.time);

  let scope: 'this' | 'all' = s.eventEdits[key] ? 'this' : rule() ? 'all' : 'this';
  let colorValue: string | undefined;

  const titleIn = h('input', { 'aria-label': 'Title' });
  const locIn = h('input', { 'aria-label': 'Location' });
  const typeSel = h('select', { 'aria-label': 'Event type' });
  const removeCb = h('input', { type: 'checkbox' });
  const colorSlot = h('div');

  const fill = () => {
    const level: EventChange | undefined = scope === 'this' ? s.eventEdits[key] : rule()?.set;
    const base = resolveEvent(src, s, { ignoreEdit: true, ignoreRule: scope === 'all' }).event;
    titleIn.value = level?.title ?? '';
    titleIn.placeholder = base.summary;
    locIn.value = level?.location ?? '';
    locIn.placeholder = base.location || '(none)';
    clear(typeSel);
    typeSel.append(h('option', { value: '' }, `Automatic: ${typeDef(base.typeId)?.name ?? 'not recognised'}`));
    for (const t of s.types) typeSel.append(h('option', { value: t.id, selected: level?.typeId === t.id }, t.name));
    removeCb.checked = !!level?.remove;
    colorValue = level?.colorId;
    renderColor(base.colorId);
  };
  const renderColor = (baseColor: string | undefined) => {
    clear(colorSlot);
    colorSlot.append(colorPicker({
      value: colorValue,
      noneLabel: `Automatic (${colorById(baseColor)?.name ?? 'none'})`,
      onChange: (id) => { colorValue = id; renderColor(baseColor); },
    }));
  };

  const scopeRadio = (val: 'this' | 'all', label: string) =>
    h('label', { class: 'check' },
      h('input', { type: 'radio', name: 'scope', value: val, checked: scope === val, onchange: () => { scope = val; fill(); } }), label);

  const dlg = h('dialog', { class: 'editor', 'aria-labelledby': 'editor-title' });
  const close = () => dlg.close();
  const save = () => {
    const change: EventChange = {};
    if (titleIn.value.trim()) change.title = titleIn.value.trim();
    if (typeSel.value) change.typeId = typeSel.value;
    if (colorValue) change.colorId = colorValue;
    if (locIn.value.trim()) change.location = locIn.value.trim();
    if (removeCb.checked) change.remove = true;
    const empty = Object.keys(change).length === 0;
    if (scope === 'this') {
      if (empty) delete s.eventEdits[key]; else s.eventEdits[key] = change;
    } else {
      s.rules = s.rules.filter((r) => r !== rule());
      if (!empty) s.rules.push({ groupId: e.groupId, weekday: e.weekday, time: e.time, set: change });
    }
    close();
    changed(false);
  };

  dlg.append(
    h('form', { method: 'dialog', onsubmit: (ev: Event) => { ev.preventDefault(); save(); } },
      h('h2', { id: 'editor-title' }, e.summary),
      h('p', { class: 'muted small' }, `${fmtWhen(e)} · TUMonline: “${src.summary}”`),
      h('p', { class: 'muted small' },
        `Detected: ${src.courseName ?? 'no course'} · ${typeDef(src.typeId)?.name ?? 'no type'}` +
          (src.typeSource ? ` (from ${src.typeSource === 'code' ? 'TUMonline code ' + src.lvCode : src.typeSource})` : '')),
      e.attention.length ? note('warn', e.attention.join('. ') + '.') : null,
      item.skipped ? note('info', `Currently skipped: ${item.skipped.detail ?? SKIP_LABEL[item.skipped.reason]}.`) : null,
      h('fieldset', { class: 'scope' }, h('legend', null, 'Apply to'),
        scopeRadio('this', 'Only this date'),
        scopeRadio('all', `All ${likeThis} dates like this (${slotLabel})`)),
      h('label', { class: 'field' }, h('span', null, 'Title (empty = automatic)'), titleIn),
      h('div', { class: 'row' },
        h('label', { class: 'field' }, h('span', null, 'Type'), typeSel),
        h('div', { class: 'field' }, h('span', null, 'Colour'), colorSlot)),
      h('label', { class: 'field' }, h('span', null, 'Location (empty = from TUMonline)'), locIn),
      h('label', { class: 'check' }, removeCb, "Don't copy (remove from calendar)"),
      h('div', { class: 'row end' },
        s.eventEdits[key] ? h('button', { type: 'button', class: 'btn-ghost', onclick: () => { delete s.eventEdits[key]; close(); changed(false); } }, 'Reset this date') : null,
        rule() ? h('button', { type: 'button', class: 'btn-ghost', onclick: () => { s.rules = s.rules.filter((r) => r !== rule()); close(); changed(false); } }, 'Delete rule for all like this') : null,
        h('button', { type: 'button', class: 'btn-ghost', onclick: close }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn' }, 'Save'))),
  );
  fill();
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

// ------------------------------------------------------------------ 4. script

function scriptTab(): HTMLElement {
  const s = state.settings, r = state.resolution!;
  const attn = attentionEvents().length;
  const useExisting = !!s.target.calendarId;
  const out = h('textarea', { class: 'code', readonly: true, rows: 12, spellcheck: 'false', 'aria-label': 'Generated script' }, state.generated);
  const generate = () => {
    state.generated = generateScript(s, { engineSource, toolUrl: location.origin + location.pathname });
    out.value = state.generated;
    return state.generated;
  };
  if (!state.generated) generate();

  const copyBtn = h('button', {
    type: 'button', class: 'btn', onclick: async () => {
      try {
        await navigator.clipboard.writeText(generate());
        copyBtn.textContent = 'Copied ✓';
      } catch {
        out.select();
        copyBtn.textContent = 'Press Ctrl+C to copy';
      }
      setTimeout(() => { copyBtn.textContent = 'Copy script'; }, 2500);
    },
  }, 'Copy script');

  return h('div', { class: 'stack' },
    h('section', { class: 'card' },
      h('h2', null, 'Where should the timetable go?'),
      h('label', { class: 'check' }, h('input', { type: 'radio', name: 'target', checked: !useExisting, onchange: () => { s.target.calendarId = ''; changed(); } }),
        'Create a new calendar (recommended)'),
      !useExisting ? h('label', { class: 'field indent' }, h('span', null, 'Name'),
        h('input', { value: s.target.newCalendarName, onchange: (ev: Event) => { s.target.newCalendarName = (ev.target as HTMLInputElement).value.trim() || 'TUM Stundenplan'; changed(); } })) : null,
      h('label', { class: 'check' }, h('input', { type: 'radio', name: 'target', checked: useExisting, onchange: () => { s.target.calendarId = s.target.calendarId || 'paste-calendar-id-here'; changed(); } }),
        'Use one of my existing calendars'),
      useExisting ? h('label', { class: 'field indent' }, h('span', null, 'Calendar ID (Google Calendar → Settings → your calendar → “Integrate calendar”)'),
        h('input', { value: s.target.calendarId === 'paste-calendar-id-here' ? '' : s.target.calendarId, placeholder: 'xxxx@group.calendar.google.com', spellcheck: 'false',
          onchange: (ev: Event) => { s.target.calendarId = (ev.target as HTMLInputElement).value.trim() || 'paste-calendar-id-here'; changed(); } })) : null,
      h('p', { class: 'muted small' }, 'The script only changes events it created itself (they carry a hidden marker). Your own events in that calendar stay untouched. Don’t use your main calendar if you might ever want the clean-up function “delete everything”.'),
      h('h3', null, 'Keep it updated'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.autoSync.enabled, onchange: (ev: Event) => { s.autoSync.enabled = (ev.target as HTMLInputElement).checked; changed(); } }),
        'Update automatically every ',
        h('select', { onchange: (ev: Event) => { s.autoSync.everyHours = +(ev.target as HTMLSelectElement).value; changed(); } },
          ...[1, 2, 3, 6, 12, 24].map((n) => h('option', { value: String(n), selected: s.autoSync.everyHours === n }, String(n)))),
        ' hour(s), so room changes and cancellations arrive on their own'),
    ),
    h('section', { class: 'card' },
      h('h2', null, 'Summary'),
      h('ul', { class: 'facts' },
        h('li', null, h('strong', null, String(r.desired.length)), ' events will be in your calendar'),
        h('li', { class: 'muted' }, `${r.skipped.filter((x) => x.reason !== 'outside-window').length} skipped by your settings, ${r.skipped.filter((x) => x.reason === 'outside-window').length} outside the date range`),
        attn ? h('li', { class: 'attn' }, `${attn} still need attention; they are copied with their original title`) : null),
      h('p', { class: 'muted small' }, 'Before writing anything, the script’s “previewSync” shows exactly what it will create, change and delete in your Google Calendar.'),
    ),
    h('section', { class: 'card' },
      h('h2', null, 'Your personal script'),
      h('div', { class: 'row' }, copyBtn,
        h('button', { type: 'button', class: 'btn-ghost', onclick: () => downloadText('tum-calendar-sync.gs', generate(), 'text/javascript') }, 'Download .gs'),
        h('button', { type: 'button', class: 'btn-ghost', onclick: exportSettings }, 'Export settings')),
      out,
      h('h3', null, 'Set it up (about 5 minutes, once)'),
      h('ol', { class: 'steps' },
        h('li', null, 'Open ', h('a', { href: 'https://script.google.com/home/projects/create', target: '_blank', rel: 'noopener noreferrer' }, 'script.google.com → New project'), ' (signed in with the Google account whose calendar you want).'),
        h('li', null, 'Delete the example code, paste your script, and click 💾 Save. Name the project e.g. “TUM Calendar”.'),
        h('li', null, 'On the left, next to ', h('strong', null, 'Services'), ' click +, choose ', h('strong', null, 'Google Calendar API'), ', click Add. (Without this the first run fails with error 403.)'),
        h('li', null, 'In the code, paste your TUMonline iCal link into ', h('code', null, 'setLink'), ' between the quotes. Select ', h('code', null, 'setLink'), ' in the toolbar and click ▶ Run.'),
        h('li', null, 'Google asks for permission. Because this is your own script, it says “Google hasn’t verified this app”: click Advanced → “Go to … (unsafe)” → Allow. The script can then read/write your calendars, download the TUMonline link, and run on a timer, all only for your account.'),
        h('li', null, 'Delete the link from the code again and save. It is now stored privately in your account’s script properties.'),
        h('li', null, 'Run ', h('code', null, 'previewSync'), ' and read the log. If it looks right, run ', h('code', null, 'syncNow'), '.'),
        s.autoSync.enabled ? h('li', null, 'Run ', h('code', null, 'setupAutoSync'), ' once to turn on automatic updates.') : null,
      ),
      h('p', { class: 'muted small' }, 'To change names or colours later: edit here, generate again, and replace the whole code in your Apps Script project (the saved link and calendar stay).'),
    ),
  );
}

render();
