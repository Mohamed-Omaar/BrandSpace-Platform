import { describe, expect, it } from 'vitest';

/**
 * Q1 / Q2 (D-326) — THE RAIL'S BUSINESS SWITCHER: what it offers at its foot,
 * decided from the same `WorkspaceAllowance` the server enforces.
 */

describe('Q1 · what the business switcher offers at its foot', () => {
  it('offers nothing to a person who owns no workspace, or whose plans allow only one', async () => {
    const { switcherFoot } =
      await import('../../apps/dashboard/src/server/business-switcher-model');
    expect(switcherFoot({ used: 0, allowed: 0, canCreate: true })).toEqual({ kind: 'none' });
    expect(switcherFoot({ used: 1, allowed: 1, canCreate: false })).toEqual({ kind: 'none' });
  });

  it('offers "+ New workspace" with the usage below the allowance, and an upgrade note at it', async () => {
    const { switcherFoot } =
      await import('../../apps/dashboard/src/server/business-switcher-model');
    expect(switcherFoot({ used: 1, allowed: 2, canCreate: true })).toEqual({
      kind: 'create',
      used: 1,
      allowed: 2,
    });
    expect(switcherFoot({ used: 2, allowed: null, canCreate: true })).toEqual({
      kind: 'create',
      used: 2,
      allowed: null,
    });
    expect(switcherFoot({ used: 2, allowed: 2, canCreate: false })).toEqual({
      kind: 'limit',
      used: 2,
      allowed: 2,
    });
  });

  it('owner decision (PR #47): an allowance of 0 never reads "N of 0" and offers no new workspace', async () => {
    const { switcherFoot } =
      await import('../../apps/dashboard/src/server/business-switcher-model');
    // Plan-less (or cancelled-plan) workspaces add no allowance (D-326).
    for (const used of [1, 2, 5]) {
      expect(switcherFoot({ used, allowed: 0, canCreate: false })).toEqual({
        kind: 'unavailable',
      });
    }
    // Display only: the allowance itself is untouched, so every other case stands.
    expect(switcherFoot({ used: 2, allowed: 2, canCreate: false }).kind).toBe('limit');
    expect(switcherFoot({ used: 1, allowed: 2, canCreate: true }).kind).toBe('create');

    const { readFileSync } = await import('node:fs');
    const shell = readFileSync(
      `${__dirname}/../../apps/dashboard/src/components/workspace-shell.tsx`,
      'utf8',
    );
    // No usage line and no "+ New workspace" for it; the second line links to the plans page.
    // D-468: the usage now sits in the menu heading ("Workspaces · 1/2"), computed once.
    expect(shell).toContain(
      "switcher && switcher.foot.kind !== 'none' && switcher.foot.kind !== 'unavailable'",
    );
    const block = shell.slice(
      shell.indexOf("switcher.foot.kind === 'unavailable' ? ("),
      shell.indexOf("switcher.foot.kind === 'limit' ? ("),
    );
    expect(block).toContain('href={`/${locale}/plan`}');
    expect(block).toContain("t('ws.unavailable')");
    expect(block).toContain("t('ws.unavailableUpgrade')");
    expect(block).not.toContain('ws.new');
    expect(block).not.toContain('ws.usage');
  });

  it('the owner’s words, in both languages', async () => {
    const { optionalMessage } = await import('../../apps/dashboard/src/i18n/messages');
    expect(optionalMessage('en', 'ws.unavailable')).toBe('Additional workspaces unavailable');
    expect(optionalMessage('en', 'ws.unavailableUpgrade')).toBe(
      'Upgrade to add another workspace.',
    );
    expect(optionalMessage('ar', 'ws.unavailable')).toBe('مساحات عمل إضافية غير متاحة');
    expect(optionalMessage('ar', 'ws.unavailableUpgrade')).toBe(
      'قم بالترقية لإضافة مساحة عمل أخرى.',
    );
  });

  it('the rail offers the switcher, the new-workspace page and the server all read one allowance', async () => {
    const { readFileSync } = await import('node:fs');
    const read = (file: string) => readFileSync(`${__dirname}/../../${file}`, 'utf8');
    expect(read('apps/dashboard/src/server/business-switcher.ts')).toContain(
      'switcherFoot(workspaceAllowance(owned, plans))',
    );
    expect(read('apps/dashboard/src/app/[locale]/onboarding/workspace/page.tsx')).toContain(
      "if (switcher?.foot.kind !== 'create') redirect(`/${locale}/onboarding`);",
    );
    expect(read('packages/onboarding/src/workspace.ts')).toContain(
      'const allowance = workspaceAllowance(facts, plans);',
    );
  });
});
