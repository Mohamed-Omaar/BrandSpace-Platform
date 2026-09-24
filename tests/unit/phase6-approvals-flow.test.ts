import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { messages } from '../../apps/dashboard/src/i18n/messages';

/**
 * PHASE 6 FINAL · D-277 §29, D-288 — APPROVALS AS ONE FLOW, NOT A SECOND ONE.
 */

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

describe('D-288', () => {
  it('resubmitting after changes uses the one approval service, not a new workflow', () => {
    const actions = read('apps/dashboard/src/app/[locale]/content/actions.ts');
    const flow = actions.slice(actions.indexOf('export async function resubmitAfterChangesAction'));
    expect(flow).toMatch(/\(await approvals\(\)\)\.submit\(/);
    expect(flow).toMatch(/service\.resolve\(\{ actor, threadId \}\)/);
    expect(flow).toMatch(/requireWorkspace\(locale, 'content\.submit'\)/);
  });

  it('the next step is chosen by the brand policy, and scheduling needs its own permission', () => {
    const editor = read('apps/dashboard/src/app/[locale]/content/compose/draft-editor.tsx');
    expect(editor).toMatch(/review\?\.requiresApproval \? 'cs-dark-button'/);
    expect(editor).toMatch(/can\.schedule &&/);
    const page = read('apps/dashboard/src/app/[locale]/content/compose/page.tsx');
    expect(page).toMatch(/schedule: workspace\.permissionKeys\.includes\('content\.schedule'\)/);
  });

  it('no multi-step chain and no guest approval were added', () => {
    const approvals = read('packages/content/src/approvals.ts');
    expect(approvals).not.toMatch(/step(s)?Index|approvalChain|guestApprov/i);
  });

  it('the changes-requested copy exists in both languages', () => {
    for (const locale of ['en', 'ar'] as const) {
      const dictionary = messages[locale] as Record<string, string>;
      for (const key of [
        'editor.changes.by',
        'editor.changes.reply',
        'editor.changes.resubmit',
        'editor.next.schedule',
        'editor.next.needsApproval',
      ]) {
        expect(dictionary[key], `${locale} ${key}`).toBeTruthy();
      }
    }
  });
});
