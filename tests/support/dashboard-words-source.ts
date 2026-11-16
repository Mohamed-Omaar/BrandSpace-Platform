import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * THE DASHBOARD'S WORDS, AS SOURCE TEXT (B2).
 *
 * Since B2 ("one language per page") the dictionaries live in
 * `apps/dashboard/src/i18n/dict/{en,ar,both}.ts` and `messages.ts` gathers
 * them for the server. A test that reads the words as text reads all four,
 * in this order, so it finds a sentence wherever it now lives.
 */
export function dashboardWordsSource(): string {
  const root = path.resolve(__dirname, '../..');
  return [
    'apps/dashboard/src/i18n/messages.ts',
    'apps/dashboard/src/i18n/dict/en.ts',
    'apps/dashboard/src/i18n/dict/ar.ts',
    'apps/dashboard/src/i18n/dict/both.ts',
  ]
    .map((file) => readFileSync(path.join(root, file), 'utf8'))
    .join('\n');
}
