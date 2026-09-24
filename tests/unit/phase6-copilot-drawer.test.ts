import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COPILOT_SUBJECT_TYPES, copilotSubjectType } from '@brandspace/copilot';
import { messages } from '../../apps/dashboard/src/i18n/messages';
import {
  COPILOT_SUBJECT_KINDS,
  copilotSubjectForPath,
} from '../../apps/dashboard/src/server/copilot-surface';

/**
 * PHASE 6 FINAL · D-277 §37, D-280 — THE GLOBAL COPILOT AND ITS CONTEXT.
 *
 * The top bar's Copilot opens over the current screen and knows the object the
 * address names. The subject is read from the ADDRESS, from a closed set of
 * kinds, and the server admits it again — these tests pin the parsing and the
 * wiring; the admission itself is `tests/isolation/phase6-copilot-subject`.
 */

const ROOT = path.resolve(__dirname, '../..');
const read = (relative: string) => readFileSync(path.join(ROOT, relative), 'utf8');
const ID = '0b8a2f5e-4d2c-4c1b-9e0a-2d7f6c5b4a31';

describe('D-280 · the subject kinds are one closed list', () => {
  it('the dashboard’s copy matches the Copilot package', () => {
    expect([...COPILOT_SUBJECT_KINDS].sort()).toEqual([...COPILOT_SUBJECT_TYPES].sort());
  });

  it('a stored kind outside the list is no kind', () => {
    expect(copilotSubjectType('CAMPAIGN')).toBe('CAMPAIGN');
    expect(copilotSubjectType('WORKSPACE')).toBeNull();
    expect(copilotSubjectType(null)).toBeNull();
  });

  it('the database enforces the same list, both-or-neither', () => {
    const migration = read(
      'packages/database/prisma/migrations/20260924120000_phase_6_copilot_subject/migration.sql',
    );
    expect(migration).toMatch(/"subjectType" IS NULL AND "subjectId" IS NULL/);
    expect(migration).toMatch(/IN \('CAMPAIGN', 'CONTENT_ITEM', 'INSIGHT'\)/);
  });
});

describe('D-280 · the subject is read from the address', () => {
  it('a campaign page, a post in the composer, an insight', () => {
    expect(copilotSubjectForPath(`/en/campaigns/${ID}`)).toEqual({ type: 'CAMPAIGN', id: ID });
    expect(copilotSubjectForPath(`/ar/content/compose?item=${ID}`)).toEqual({
      type: 'CONTENT_ITEM',
      id: ID,
    });
    expect(copilotSubjectForPath(`/en/intelligence?insight=${ID}&tab=x`)).toEqual({
      type: 'INSIGHT',
      id: ID,
    });
  });

  it('anything else, or a malformed id, is no subject', () => {
    expect(copilotSubjectForPath('/en/campaigns')).toBeNull();
    expect(copilotSubjectForPath('/en/campaigns/new')).toBeNull();
    expect(copilotSubjectForPath(`/en/campaigns/${ID}/edit`)).toBeNull();
    expect(copilotSubjectForPath('/en/content/compose?item=<script>')).toBeNull();
    expect(copilotSubjectForPath(`/en/analytics?insight=${ID}`)).toBeNull();
    expect(copilotSubjectForPath(null)).toBeNull();
  });
});

describe('D-277 §37 · the drawer', () => {
  const shell = read('apps/dashboard/src/components/workspace-shell.tsx');
  const drawer = read('apps/dashboard/src/components/global-copilot.tsx');
  const orchestrator = read('packages/copilot/src/orchestrator.ts');

  it('the top bar’s Copilot link opens the drawer, and stays a link without script', () => {
    expect(shell).toMatch(/<GlobalCopilot/);
    expect(drawer).toMatch(/onClickCapture=\{intercept\}/);
    expect(drawer).toMatch(/event\.metaKey \|\| event\.ctrlKey/);
    expect(drawer).toMatch(/data-testid="global-copilot-full"/);
  });

  it('the drawer runs the SAME conversation component, with its confirmation ceremony', () => {
    expect(drawer).toMatch(/<CopilotView/);
    expect(drawer).not.toMatch(/\/api\/copilot\/confirm/);
  });

  it('the subject title reaches the model only fenced', () => {
    expect(orchestrator).toMatch(/fenceUntrusted\(\s*'CURRENT SUBJECT'/);
    expect(orchestrator).toMatch(
      /THE CUSTOMER IS LOOKING AT ONE \$\{SUBJECT_NOUN\[subjectKind\]\}/,
    );
  });

  it('says what it is looking at, in both languages', () => {
    for (const locale of ['en', 'ar'] as const) {
      const dictionary = messages[locale] as Record<string, string>;
      expect(dictionary['copilot.contextSubject']).toContain('{subject}');
      expect(dictionary['copilot.openFull']).toBeTruthy();
    }
  });
});
