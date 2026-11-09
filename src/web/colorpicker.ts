/** A picker for Google's 11 event colours (no free colours: Google can't show them). */
import { colorById, GOOGLE_COLORS } from '../core/colors';
import { h } from './dom';

export interface ColorPickerOptions {
  value: string | undefined;
  onChange: (id: string | undefined) => void;
  /** Label for "no own colour" (e.g. "Course colour"); omit to require a colour. */
  noneLabel?: string;
  /** Colour ids already used elsewhere, marked in the list. */
  usedBy?: Record<string, string[]>;
}

export function colorPicker(opts: ColorPickerOptions): HTMLElement {
  const cur = colorById(opts.value);
  const details = h('details', { class: 'cpick' });
  const summary = h(
    'summary',
    { title: 'Choose colour' },
    h('span', { class: 'swatch', style: { background: cur?.hex ?? 'transparent' }, dataset: { none: cur ? '' : '1' } }),
    h('span', null, cur?.name ?? opts.noneLabel ?? 'Choose'),
  );
  const grid = h('div', { class: 'cpick-menu', role: 'listbox' });
  const pick = (id: string | undefined) => {
    details.open = false;
    opts.onChange(id);
  };
  if (opts.noneLabel) {
    grid.append(h('button', { type: 'button', class: 'cpick-item', onclick: () => pick(undefined) },
      h('span', { class: 'swatch', dataset: { none: '1' } }), opts.noneLabel));
  }
  for (const c of GOOGLE_COLORS) {
    const used = opts.usedBy?.[c.id]?.filter(Boolean) ?? [];
    grid.append(
      h('button', {
        type: 'button', class: 'cpick-item' + (c.id === opts.value ? ' active' : ''), role: 'option',
        'aria-selected': c.id === opts.value ? 'true' : 'false', onclick: () => pick(c.id),
        title: used.length ? 'Also used by: ' + used.join(', ') : c.name,
      },
      h('span', { class: 'swatch', style: { background: c.hex } }),
      c.name,
      used.length ? h('span', { class: 'cpick-used' }, '•') : null),
    );
  }
  details.append(summary, grid);
  return details;
}

// Close open pickers when clicking elsewhere.
document.addEventListener('click', (ev) => {
  document.querySelectorAll('details.cpick[open]').forEach((d) => {
    if (!d.contains(ev.target as Node)) (d as HTMLDetailsElement).open = false;
  });
});
