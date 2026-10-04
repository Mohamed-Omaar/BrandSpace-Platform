import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { messages } from '../../apps/dashboard/src/i18n/messages';

/**
 * PHASE 6 FINAL · D-277 §12, §37, D-294.
 */

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

describe('D-294 · Brand Brain says what it knows, in counts', () => {
  const view = read('apps/dashboard/src/app/[locale]/brand-brain/brand-brain-view.tsx');
  const page = read('apps/dashboard/src/app/[locale]/brand-brain/page.tsx');

  it('the understanding line is counts, never a readiness score', () => {
    for (const locale of ['en', 'ar'] as const) {
      const line = (messages[locale] as Record<string, string>)['bb.understands.some'] ?? '';
      expect(line).toContain('{facts}');
      expect(line).toContain('{sources}');
      expect(line).not.toMatch(/%|ready|readiness|جاهز/i);
    }
  });

  /*
   * REPLACED (Phase 2C, D4 — owner decision on the Phase 2C report, D-358).
   * Old rule: only a MEASURED (analytics) learning showed a confidence.
   * New rule: every candidate in the one review inbox shows a confidence LABEL
   * from the configured thresholds together with WHY — the reason recorded at
   * extraction, or "not recorded" when nothing was.
   */
  it('every inbox candidate shows a confidence label and the recorded reason for it', () => {
    const inbox = read('apps/dashboard/src/app/[locale]/brand-brain/review-inbox.tsx');
    // D-468: the label sits in the prototype's confidence pill, with the reason.
    expect(inbox).toMatch(
      /data-testid=\{`intel-confidence-\$\{current\.id\}`\}\s*>\s*\{current\.confidenceLabel\}[\s\S]{0,160}?\{current\.confidenceWhy\}\s*<\/span>/,
    );
  });

  it('every value carries its provenance from real columns', () => {
    for (const column of ['updatedAt: true', 'createdByUserId: true', 'sourceDocumentId: true']) {
      expect(page).toContain(column);
    }
  });

  it('every new string exists in both languages', () => {
    const keys = [
      ...`${view}\n${page}`.matchAll(
        /'(bb\.(?:understands|askAboutBrand|layer|layersTitle|layerPending|gapsTitle|gapAdd|provenance|learning)[\w.]*)'/g,
      ),
    ].map((match) => match[1]!);
    for (const memory of ['CANONICAL', 'STRATEGY', 'CONTENT', 'LEARNING']) {
      keys.push(`bb.layer.${memory}`, `bb.layer.${memory}.desc`);
    }
    expect(keys.length).toBeGreaterThan(15);
    for (const key of keys) {
      expect((messages.en as Record<string, string>)[key], key).toBeTruthy();
      expect((messages.ar as Record<string, string>)[key], key).toBeTruthy();
    }
  });
});

describe('D-294 · "Give to Copilot" opens the one Copilot where you are', () => {
  it('the drawer listens for the request, and the link still works without script', () => {
    const link = read('apps/dashboard/src/components/copilot-link.tsx');
    const drawer = read('apps/dashboard/src/components/global-copilot.tsx');
    expect(link).toMatch(/<Link\s+href=\{/);
    expect(link).toContain('OPEN_COPILOT_EVENT');
    expect(drawer).toContain('window.addEventListener(OPEN_COPILOT_EVENT');
  });

  it('no in-page Copilot entry navigates away with a plain Link any more', () => {
    for (const route of ['overview', 'strategy', 'analytics', 'intelligence', 'automations']) {
      const source = read(`apps/dashboard/src/app/[locale]/${route}/page.tsx`);
      expect(source, route).not.toMatch(/<Link\s+href=\{copilotHref\(/);
    }
  });
});
