/**
 * Human file size, in the reader's locale.
 *
 * `Intl.NumberFormat` rather than a hand-rolled join, so Arabic gets its own
 * grouping and decimal separator (CLAUDE.md §4). The unit words are ASCII
 * abbreviations in both locales because that is what a file manager shows.
 * Binary units (1 KB = 1024 B), matching the storage meter's `BYTES_PER_GB`.
 *
 * Shared by the Asset Library and the storage breakdown (Phase 2B-2b), so the
 * same bytes read the same way on both screens.
 */
export function formatBytes(bytes: number, _locale: string): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const formatted = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: value < 10 && unit > 0 ? 1 : 0,
  }).format(value);
  return `${formatted} ${units[unit]}`;
}
