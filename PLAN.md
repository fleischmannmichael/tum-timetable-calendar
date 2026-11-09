# TUM Timetable → Google Calendar: build plan

Decisions (agreed): **Option B** (static web configurator that generates a personalised
Google Apps Script), **Vite + TypeScript + Vitest + FullCalendar**, hosted on **GitHub Pages**.
Built so that option A (Google sign-in, Calendar API from the browser) can reuse the same core later.

## 0. What a real TUMonline feed looks like (one ETIT semester, 296 events)

- One `VEVENT` per date. **No `RRULE`, no `TZID`, no all-day events, no `VALARM`, no cancelled
  events** in this sample. All times are UTC (`...Z`). `X-WR-TIMEZONE:Europe/Vienna`.
  The parser still supports all of those (other feeds or other semesters may use them).
- `UID` is unique per date (`893303561@tum.de`) → **stable key = UID**.
- `X-CO-RECURRINGID` groups dates into a series (23 series); 74 events have it empty.
- `LOCATION` like `0980, Audimax (0509.EG.980)`; room code in brackets. 32 events have no
  LOCATION (they come from group/tutorial systems and put the room in the description instead).
- `DESCRIPTION` is usually `fix; Abhaltung; <note>`. The note is free text, but sometimes it
  names the type: **`Zentralübung` / `Vorlesung`**. This is exactly what the prototype's
  `TYPE_OVERRIDES` faked for Digitaltechnik: TUMonline already says it in the description.
- `SUMMARY` patterns (all of them in the sample):

  | Title | Course | Type from | Group |
  |---|---|---|---|
  | `Analysis 1 (EI) [MA9411] VO, Standardgruppe` | Analysis 1 (module MA9411) | code `VO` | Standardgruppe |
  | `Zentralübung zu Analysis 1 (EI) [MA9411] UE, Standardgruppe` | Analysis 1 | word *Zentralübung* (beats `UE`) | |
  | `Übungen zu Analysis 1 G12` | Analysis 1 | word *Übungen* | G12 |
  | `Lineare Algebra Tutorium G4` | Lineare Algebra | word *Tutorium* | G4 |
  | `Tutorium Schaltungstheorie UE, Standardgruppe` | Schaltungstheorie | word *Tutorium* | |
  | `Digitaltechnik - Tutorien TT, Gruppe 6 - <tutor>` | Digitaltechnik | word *Tutorien* / `TT` | Gruppe 6 |
  | `Programmierpraktikum (Übung) UE, Standardgruppe` | Programmierpraktikum | *(Übung)* / `UE` | |
  | `Digitaltechnik VI, Standardgruppe` | Digitaltechnik | description note, else code `VI` | |

  Structure: `[type word + "zu"] <course> [(faculty)] [[module code]] [type word] <LV code>, <group>`.
- Daylight saving: the same "Thursday 15:00" is `13:00Z` in October and `14:00Z` in November,
  so weekday/time rules always use **Europe/Berlin local time**.
- Personal data in a feed: calendar name (student's full name), contact persons and tutor names in
  descriptions/groups. The anonymised test fixture replaces all of them.

### Detection rules (generic, no course list)

1. Split off the group after the last comma (`Standardgruppe`, `Gruppe 6 - …`, `Tutorium 5`)
   and a trailing `G<n>` token.
2. Take a trailing TUMonline LV code (`VO`, `VI`, `UE`, `TT`, `PR`, `SE`, `PS`, `HS`, `KO`, `PJ`,
   `VU`, …). Unknown 2-letter codes are kept and flagged.
3. Take `[MODULE]` and a trailing `(EI)`-style faculty tag.
4. Remove type words (whole words only after umlaut normalisation, so *Programmierpraktikum* is
   **not** a Praktikum) plus connectors (`zu`, `-`, brackets). What remains is the course name.
5. Courses with the same module code are merged; otherwise the normalised name is the course id.
6. Type priority: type word in title → type word in description note → LV code → **needs attention**.
   `VI` ("Vorlesung mit integrierten Übungen") is its own type, default label `VL`. The user can
   reassign one series (e.g. the Thursday slot) to `ZÜ` from the preview with "all like this".
7. Cancel words are checked in the title and the description note (configurable).

## 1. Architecture

```
src/
  core/            pure TypeScript, no DOM, no Apps Script APIs → runs in browser, Apps Script and tests
    ics.ts         tokenizer: line unfolding, params (quoted values), escapes, nested blocks (VALARM, VTIMEZONE)
    time.ts        DTSTART/DTEND → instant; UTC, TZID (IANA + Windows names), floating, all-day (DATE)
    recurrence.ts  RRULE expansion (FREQ DAILY/WEEKLY/MONTHLY, INTERVAL, COUNT, UNTIL, BYDAY), EXDATE,
                   RECURRENCE-ID overrides. Anything unsupported → event flagged + warning, never silently cut
    detect.ts      normalise (lowercase, ä→ae, ö→oe, ü→ue, ß→ss), detect event type, extract course name
    types.ts       event-type dictionary (DE + EN synonyms, priority order), editable in settings
    settings.ts    settings schema with a version number, defaults, validation, migration, JSON import/export
    resolve.ts     source events + settings → "desired" calendar events (title template, colour, skips,
                   per-event edits, weekday/time rules, needs-attention flags)
    diff.ts        desired vs. existing managed events → create / update / delete / unchanged
    colors.ts      Google's 11 event colours (id, name, hex) + default assignment
  web/             the configurator UI (import → detect → customise → preview/edit → generate script)
  gas/             Apps Script adapter: UrlFetchApp, batch requests, PropertiesService, triggers, time budget
                   bundled together with core/ into ONE file the user pastes into script.google.com
tests/             Vitest: parser, detection, recurrence, resolve, diff (sample .ics + hand-written edge cases)
```

**Easy to adjust:** every rule the prototype hard-coded (courses, keywords, colours, type labels,
type synonyms, cancel words, skip rules, weekday/time overrides, title template, date window) lives
in one settings JSON. The generated script contains that JSON in a clearly marked block at the top,
so a user can tweak it in the script editor *or* re-import it into the web tool, edit, and regenerate.

## 2. Data flow

1. **Import**: upload `.ics` (always works) or paste the iCal link (the browser tries to fetch it; if
   TUMonline blocks it via CORS, the tool says so and asks for the file). The link stays in memory only.
2. **Detect**: parse → expand repeats → group into courses × event types. Unknown type or course →
   "needs attention" list, shown in red in the preview. No guessing.
3. **Customise**: per course: display name, colour (11 Google colours with real names + swatches),
   on/off, per-type label or hide. One title template, e.g. `{type} · {course}`, with live example.
   Placeholders: `{course}`, `{type}`, `{original}`, `{room}`.
4. **Preview & edit**: FullCalendar week + month view. Click an event → edit title / colour / location,
   remove it, fix its type; checkbox "apply to all events like this one" (same course + weekday + start time).
5. **Generate**: download/copy the personalised script + step-by-step setup instructions.
6. **In Apps Script**: `previewSync()` logs what *would* be created / changed / deleted; `syncNow()`
   applies it; `setupHourlySync()` installs the hourly trigger.

Settings auto-save in the browser (localStorage, **without** the iCal link) and export/import as JSON.

## 3. Stable keys, edits and the diff

- Key per source occurrence: `UID` + (`RECURRENCE-ID` or occurrence start). If the sample shows that
  TUMonline gives every single date its own unique UID, the key is the UID alone, so a moved lecture
  updates in place instead of being deleted and re-created. (To confirm with the sample file.)
- Per-event edits are stored by key → survive re-syncs. "Like this one" rules are stored as
  `{course, weekday, startTime}` → also apply to future dates.
- Every event the tool creates carries private extended properties `tumcal=1`, `tumcalKey=<key>`,
  `tumcalHash=<content hash>`. The script only lists events with `privateExtendedProperty=tumcal=1`;
  it never reads, changes or deletes anything else.
- Diff: key missing in Google → create; key present but hash differs → patch; key no longer in feed →
  delete; duplicate keys → delete extras; same hash → untouched.
- Whole-result hash stored in Script Properties → if feed + settings are unchanged, the run stops early.

## 4. Apps Script safety

- Abort and change nothing if: download fails, HTTP ≠ 200, body isn't `BEGIN:VCALENDAR`, 0 events,
  or the target calendar can't be read.
- Mass-deletion guard: an automatic (hourly) run that would delete more than 50 % of managed events
  aborts and logs why; `syncNow()` run by hand is allowed.
- Batch requests of 50 to `/batch/calendar/v3`; per-item status parsing by Content-ID; retry 429 / 403
  rate-limit / 5xx with exponential backoff; final report lists exactly what failed. Success is only
  reported when every item succeeded.
- Time budget: stops cleanly after ~4.5 min; the diff is idempotent, so the next run finishes the rest.
- iCal link stored in **Script Properties** (only readable by the user's own Google account), not in
  the code. Setup: paste it once into `setLink()`, run it, delete it from the code.
- Target calendar: choose an existing one by ID, or `createTimetableCalendar()` makes a fresh one.
- Cleanup: `removeMyEvents()` (only tool-marked events) and `deleteEverythingInCalendar("YES DELETE ALL")`
  with a loud warning, for leftovers from the old prototype.
- `setupHourlySync()` replaces only its own trigger, not the user's other triggers.

## 5. What the prototype gets wrong (fixed by the above)

| Prototype | Problem | New version |
|---|---|---|
| iCal token + calendar ID in source code | anyone who sees the script gets the token | Script Properties |
| Empties the whole target calendar on every change | deletes events it didn't create; IDs change; slow | marked events + diff |
| Delete all, then create all | a failed create leaves the calendar half empty | create/patch first, delete last |
| RRULE → first date only; EXDATE / RECURRENCE-ID ignored | missing lectures | proper expansion or explicit warning |
| One value per property name | multiple `EXDATE` lines overwrite each other | properties kept as lists |
| `line.indexOf(":")` split | breaks on quoted params containing `:` | quote-aware tokenizer |
| Substring keywords, first match wins (`"praktikum"`) | any Praktikum becomes "Programmierpraktikum" | detected courses, exact grouping, user renames |
| Unknown course/type → written uncoloured, no warning | silent mistakes | "needs attention" in preview |
| `setupTrigger` deletes all project triggers | removes unrelated triggers | only its own |
| No backoff on 429/403, no time limit guard | partial runs, 6-min kill | backoff + time budget |

## 6. Public GitHub project: nothing personal, nothing hard-coded

- **No course, colour, calendar ID, link or study programme in the code.** Courses are detected
  from whatever feed the user loads. The only built-in knowledge is generic: the event-type
  dictionary (Vorlesung/Lecture, Übung/Exercise, ...), the default cancel words, Google's 11
  colours and the default title template. All of these are defaults the user can change in settings.
- **The generated script contains only that user's settings**, made in their own browser. The
  repo itself ships the generator, never a filled-in script.
- **No personal data in the repo.** The real sample `.ics` is used only locally to design the parser.
  Tests use an **anonymised fixture** derived from it: same structure and title patterns, but
  invented course names, rooms, UIDs and descriptions, and no tokens or student IDs. A test also
  checks that fixtures contain no `pToken=` / `pStud=`.
- `.gitignore` excludes `*.ics` (except `tests/fixtures/`), `tum_timetable_final.gs` (it contains
  a real token), `settings*.json` exports and `.env*`.
- Deploy: GitHub Actions workflow builds the site and publishes it to GitHub Pages on push to `main`.
- Repo basics: README (EN), MIT licence (changeable), issue template asking for an *anonymised*
  title example when detection fails.

## 7. Build order

1. Parser + detection + tests (needs the real sample `.ics` first).
2. Preview & editing screen.
3. Apps Script generator + sync logic (+ diff tests with a fake Calendar API).
4. README (setup for non-coders incl. enabling the Calendar API service, privacy, limitations) and
   a list of what needs manual testing with a real Google account / live TUMonline.

## 8. Google permissions (option B)

The script runs under the user's own account with: Calendar (read/write events in the chosen calendar,
`https://www.googleapis.com/auth/calendar`; needed for batch requests and creating a calendar),
external requests (`script.external_request`, to download TUMonline) and triggers
(`script.scriptapp`). Declared explicitly in `appsscript.json` so nothing else is requested.
The web tool itself needs no Google access at all.
