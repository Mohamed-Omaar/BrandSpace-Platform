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
    // A cancelled plan: the owner still sees what they have, and why they cannot add.
    expect(switcherFoot({ used: 1, allowed: 0, canCreate: false })).toMatchObject({
      kind: 'limit',
    });
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
