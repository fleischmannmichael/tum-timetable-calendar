# TUM Timetable → Google Calendar

Turn your **TUMonline timetable** into a clean, colour-coded **Google Calendar** that keeps
itself up to date. It works for any TUM course of study.

- Courses and event types (Vorlesung, Zentralübung, Übung, Tutorium, Praktikum, Seminar, …,
  in German or English) are **detected automatically** from your timetable.
- You choose **names, colours and labels**, e.g. `ZÜ · Analysis` instead of
  `Zentralübung zu Analysis 1 (EI) [MA9411] UE, Standardgruppe`.
- A **calendar preview** shows the result before anything is written. Click any event to fix
  its title, colour, location or type, for one date or for all dates like it.
- A small script in **your own Google account** copies the timetable and updates it every
  hour, so room changes, moved lectures and cancellations arrive on their own.

> Not an official TUM tool. Nothing you load into the web page leaves your browser.

## How it works

```
TUMonline iCal ──► web tool (in your browser) ──► your personal Apps Script ──► Google Calendar
                   detect · customise · preview     runs in YOUR Google account
                   (nothing uploaded)                downloads TUMonline hourly, syncs changes
```

The web tool generates a Google Apps Script with your settings inside. You paste it into
[script.google.com](https://script.google.com) once. There is no server, no account with us, and
no app that needs Google's approval: the script runs as you, for you.

## Setup (about 10 minutes, no coding)

### 1. Get your timetable from TUMonline
In TUMonline, open your personal calendar and use its **export / subscribe (iCal)** function.
You get a personal link. **Treat it like a password**: anyone with it can see your timetable.
Open the link in a new browser tab; it downloads a `.ics` file.

### 2. Customise it in the web tool
1. Open the web tool and choose your `.ics` file (or try the anonymised demo first).
2. **Courses**: rename courses, pick colours (Google Calendar only offers 11 event colours;
   the tool shows exactly those), turn off courses, change or hide labels per event type,
   and edit the title template (e.g. `{type} · {course}`).
3. **Preview & edit**: check the week and month views. Events marked ⚠ need attention
   (course or type not recognised). Click an event to fix it. Use *"All dates like this"*
   to fix every date of the same course on the same weekday and time, e.g. when TUMonline
   doesn't say that the Thursday slot is a Zentralübung.
4. **Get script**: choose the target calendar (a new one is recommended), then copy the script.

Your choices are saved in your browser. Use **Export settings** to back them up or to move
them to another device.

### 3. Install the script in your Google account
1. Go to [script.google.com](https://script.google.com/home/projects/create) → **New project**.
2. Delete the example code, paste your script, click 💾 **Save**.
3. On the left, next to **Services**, click **+** → **Google Calendar API** → **Add**.
   *(Without this, the first run fails with error 403.)*
4. In the code, paste your TUMonline link into `setLink` between the quotes. Select
   `setLink` in the toolbar and click ▶ **Run**.
5. Google asks for permission. Because this is your own script, it shows *"Google hasn't verified
   this app"*: click **Advanced** → **Go to … (unsafe)** → **Allow**. See
   [what the script can access](#what-the-script-can-access).
6. Delete the link from the code again and save. It is now stored privately in your account.
7. Run `previewSync`. The log (bottom of the screen) lists what would be created, changed and
   deleted. If it looks right, run `syncNow`.
8. Run `setupAutoSync` to update automatically every hour.

**Changing settings later:** edit them in the web tool, generate the script again and replace the
whole code in your Apps Script project. The saved link and target calendar stay.

### Functions in the script

| Function | What it does |
|---|---|
| `previewSync` | Shows what would change. Changes nothing. |
| `syncNow` | Syncs now. Skips quickly if nothing changed since the last run. |
| `forceSync` | Syncs even if nothing seems to have changed (e.g. after you deleted events by hand). |
| `setupAutoSync` / `stopAutoSync` | Turns the automatic hourly update on or off. |
| `checkSetup` | Shows whether the link, calendar and automatic update are set up. |
| `listMyCalendars` | Lists your calendars with their IDs. |
| `removeMyEvents` | Deletes all events this tool created (and only those). |
| `deleteEverythingInCalendar` | Deletes **every** event in the target calendar, also events from older scripts without a marker. Needs a confirmation text in the code; never runs on your main calendar. |

## Privacy and security

- **The web tool runs only in your browser.** Your timetable is read locally and never uploaded.
  Only your settings (names, colours, fixes) are saved, in your browser's local storage. The
  timetable and the iCal link are not stored. *Reset all settings* (Courses → Advanced) deletes them.
- **The iCal link** is never written into the generated script. You paste it into `setLink` once;
  it is then stored in your Google account's **User Properties** for this script (readable only
  by your Google account, not by other people with access to the script). Delete it from the code afterwards.
  The script never logs it.
- If your link ever leaks, create a new one in TUMonline and run `setLink` again.
- The script only changes events that carry its private marker (`tumcal` extended property).
  Your own events, even in the same calendar, are never touched.

### What the script can access

When you run it the first time, Google asks you to allow:

| Permission | Why |
|---|---|
| See, edit, share and permanently delete all calendars you can access (`calendar`) | Create the timetable calendar and write its events. This is the scope the Google Calendar API service always requests; the script only writes to the target calendar and only changes its own marked events. |
| Connect to an external service (`script.external_request`) | Download your TUMonline iCal link, and send batch requests to the Calendar API. |
| Allow this application to run when you are not present (`script.scriptapp`) | The hourly automatic update. |

The script runs in your account only. Nobody else, including the authors of this tool, can see
your data or run it.

## Safety features

- If TUMonline is unreachable, returns an error page, or the calendar has 0 events, the run stops
  and **nothing is changed**. Automatic runs tolerate short outages quietly and report an error if
  TUMonline fails for more than 24 hours.
- Changes are written in batches of 50 (one hourly run with nothing new costs one download).
- New and changed events are written first, deletions last, so a failed run never leaves the
  calendar half empty. Temporary errors (rate limits) are retried; anything that still fails is
  listed and the run is marked as failed, so Google emails you. It never reports success when
  something failed.
- An automatic run that would delete more than half of the timetable stops (safety stop). Run
  `syncNow` by hand if that is really intended (e.g. a new semester).
- Runs stop safely before Apps Script's 6-minute limit; the next run continues.
- Each date is identified by its TUMonline `UID` (plus `RECURRENCE-ID` for repeating events), so
  your per-event fixes survive updates, moved lectures are updated in place, and dates removed
  from TUMonline are deleted.

## Known limitations

- **Colours:** Google Calendar events can only use its 11 fixed colours. With more than 11 courses,
  some share a colour (the tool warns you).
- **Loading the link in the web tool** usually fails because TUMonline does not allow other websites
  to read it. Use the downloaded `.ics` file instead (the script reads the link itself).
- **Detection** is based on real TUMonline titles from one study programme. Other programmes may use
  title patterns it doesn't know: such events are shown as ⚠ *needs attention*, never silently guessed.
  You can add your own words for event types under Courses → Advanced. If you find a pattern it
  misses, please open an issue with an **anonymised** example title.
- **Repeating events:** TUMonline currently sends one event per date. Other repeat rules are
  supported for common cases (daily/weekly/monthly/yearly, `INTERVAL`, `COUNT`, `UNTIL`,
  `BYDAY`, `EXDATE`, `RECURRENCE-ID`). Unsupported rules import only the first date and are
  flagged with a warning; repeats without an end are imported for 550 days.
- **Per-date fixes** are keyed by TUMonline's UID. If TUMonline gives a date a new UID, a fix for
  that single date is lost; "all dates like this" rules (course + weekday + time) still apply.
- **Changing settings** means generating the script again and pasting it into Apps Script.
- The Google "unverified app" warning appears because every user runs their own copy of the script.

## Development

Requires Node.js 20.19+ (22 or 24 recommended).

```bash
npm install
npm run dev      # web tool at http://localhost:5173
npm test         # builds the Apps Script engine, then runs all tests
npm run build    # production build into dist/
```

| Folder | Contents |
|---|---|
| `src/core/` | Shared logic, no browser or Google APIs: iCal parser, time zones, repeat rules, detection, settings, resolve (settings → events), diff |
| `src/gas/` | Apps Script engine: sync, batching, retries, safety checks. `env.ts` is the only file that touches Apps Script APIs |
| `src/web/` | The web tool (plain TypeScript + FullCalendar) and the script generator |
| `tests/` | Vitest tests, including a fake Google Calendar and a sandbox run of the generated script |
| `tests/fixtures/` | An **anonymised** TUMonline feed (invented course names, rooms, people and IDs) |

Pushing to `main` runs the tests and deploys the web tool to GitHub Pages
(`.github/workflows/deploy.yml`). In the repository settings, set *Pages → Source* to *GitHub Actions*.

Never commit real `.ics` files, iCal links or exported settings; `.gitignore` excludes them.

## Licence

MIT, see [LICENSE](LICENSE).
