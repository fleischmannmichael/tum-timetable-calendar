/**
 * Browser storage. Only settings are saved (names, colours, rules); never the iCal link and
 * never the timetable itself. Every access is wrapped: private windows may block storage.
 */
import { defaultSettings, parseSettings, serializeSettings, type Settings } from '../core/settings';

const KEY = 'tumcal.settings.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return parseSettings(raw);
  } catch {
    /* ignore: corrupt or blocked storage → defaults */
  }
  return defaultSettings();
}

let timer: ReturnType<typeof setTimeout> | undefined;

export function saveSettings(s: Settings): void {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, serializeSettings(s));
    } catch {
      /* storage unavailable: settings live only in this tab; export still works */
    }
  }, 300);
}

export function forgetSettings(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export function downloadText(filename: string, text: string, type = 'text/plain'): void {
  const url = URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
