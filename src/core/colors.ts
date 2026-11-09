/**
 * Google Calendar's 11 fixed event colours. Events can only use these (colorId "1"–"11"),
 * so the tool never offers a free colour picker. Hex values approximate Google's display.
 */
export interface GoogleColor {
  id: string;
  name: string;
  hex: string;
}

export const GOOGLE_COLORS: GoogleColor[] = [
  { id: '1', name: 'Lavender', hex: '#7986cb' },
  { id: '2', name: 'Sage', hex: '#33b679' },
  { id: '3', name: 'Grape', hex: '#8e24aa' },
  { id: '4', name: 'Flamingo', hex: '#e67c73' },
  { id: '5', name: 'Banana', hex: '#f6bf26' },
  { id: '6', name: 'Tangerine', hex: '#f4511e' },
  { id: '7', name: 'Peacock', hex: '#039be5' },
  { id: '8', name: 'Graphite', hex: '#616161' },
  { id: '9', name: 'Blueberry', hex: '#3f51b5' },
  { id: '10', name: 'Basil', hex: '#0b8043' },
  { id: '11', name: 'Tomato', hex: '#d50000' },
];

/** Order used for suggestions: neighbours differ strongly in hue. */
export const SUGGESTION_ORDER = ['9', '11', '10', '6', '3', '7', '5', '4', '2', '1', '8'];

export function colorById(id: string | undefined): GoogleColor | undefined {
  return GOOGLE_COLORS.find((c) => c.id === id);
}

export function isColorId(v: unknown): v is string {
  return typeof v === 'string' && GOOGLE_COLORS.some((c) => c.id === v);
}

/**
 * Suggests colours for courses that don't have one yet, avoiding colours already taken.
 * `courseIds` should be ordered by importance (e.g. number of events, descending).
 * `reused` is true when there were more courses than colours.
 */
export function suggestColors(
  courseIds: string[],
  existing: Record<string, string | undefined>,
): { colors: Record<string, string>; reused: boolean } {
  const used = new Set(Object.values(existing).filter(isColorId));
  const colors: Record<string, string> = {};
  let reused = false;
  let cycle = 0;
  for (const id of courseIds) {
    if (isColorId(existing[id])) continue;
    let pick = SUGGESTION_ORDER.find((c) => !used.has(c));
    if (!pick) {
      reused = true;
      pick = SUGGESTION_ORDER[cycle++ % SUGGESTION_ORDER.length];
    }
    used.add(pick);
    colors[id] = pick;
  }
  return { colors, reused };
}
