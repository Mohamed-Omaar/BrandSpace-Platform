/**
 * MO12 (Phase 2B-2b) — READING A KPI'S NUMBER OUT OF ITS FORMATTED TEXT, so it
 * can count up WITHOUT CHANGING ITS FORMAT: the same prefix and suffix
 * (currency, `%`, units), the same decimals, the same thousands separator. The
 * server formatted it; this only has to reproduce that shape for the numbers
 * in between. Pure, so every shape is tested.
 *
 * NOT COUNTED: text with no number ("DEVELOPMENT", "—"), zero ("0" has
 * nowhere to count from), and a zero-padded label such as "01" — §8 says so,
 * because "00 → 01" is a label changing, not a quantity growing.
 */
export interface CountFormat {
  readonly prefix: string;
  readonly suffix: string;
  readonly target: number;
  readonly decimals: number;
  readonly group: string | null;
  readonly decimalMark: string;
}

// A grouped number (1,234; or grouped by a narrow no-break space, a no-break
// space, a space or the Arabic thousands separator), optionally with a
// fraction; or a plain one, optionally with a fraction.
const NUMBER = new RegExp(
  '\\d{1,3}(?:([,\\u066C\\u202F\\u00A0 ])\\d{3})+(?:([.\\u066B])(\\d+))?' +
    '|\\d+(?:([.,\\u066B])(\\d+))?',
);

export function parseCount(text: string): CountFormat | null {
  const match = NUMBER.exec(text);
  if (!match) return null;
  const token = match[0];
  const group = match[1] ?? null;
  const decimalMark = match[2] ?? match[4] ?? '.';
  const fraction = match[3] ?? match[5] ?? '';
  const whole = (fraction ? token.slice(0, token.length - fraction.length - 1) : token)
    .split(group ?? '\u0000')
    .join('');
  if (whole.length > 1 && whole.startsWith('0') && fraction === '') return null;
  const target = Number(fraction ? `${whole}.${fraction}` : whole);
  if (!Number.isFinite(target) || target === 0) return null;
  return {
    prefix: text.slice(0, match.index),
    suffix: text.slice(match.index + token.length),
    target,
    decimals: fraction.length,
    group,
    decimalMark,
  };
}

/** `value` in `format`'s shape. At `format.target` it is the original text again. */
export function formatCount(format: CountFormat, value: number): string {
  const [whole = '0', fraction] = value.toFixed(format.decimals).split('.');
  const grouped = format.group ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, format.group) : whole;
  return `${format.prefix}${grouped}${fraction ? `${format.decimalMark}${fraction}` : ''}${format.suffix}`;
}

/** §8's "ease-out cubic". */
export function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}
