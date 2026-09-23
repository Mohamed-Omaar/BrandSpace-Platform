import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * PHASE 6 · P6-04 — THE RAIL SAYS WHAT ITS PARTS ARE FOR.
 *
 * The customer dashboard passed all twenty-two navigation entries to `AppShell`
 * as ONE unnamed section, so a member arriving at a workspace met an
 * undifferentiated list and had to already know the product to find anything.
 * The Control Center had been rendering grouped, titled sections since Phase 2C
 * using the same component.
 *
 * SO THIS IS A DATA CHANGE, NOT A DESIGN ONE, and that is what the first group
 * of tests pins: no new component, no new visual treatment, the same geometry
 * and the same collapse behaviour. The brief locks the visual system; grouping
 * an existing list is the kind of change it explicitly asks for.
 *
 * THE TWO INVARIANTS THAT CAN ACTUALLY BREAK:
 *
 *   1. an entry placed in NO group, which vanishes from the rail silently —
 *      the opposite failure from a dead link, and harder to notice because
 *      nothing is broken, something is just missing;
 *   2. a group whose entries are all permission-filtered rendering an empty
 *      titled heading, which is dead navigation wearing a label.
 *
 * Both are enforced in `navSections` itself and asserted here.
 */

const SHELL = readFileSync('apps/dashboard/src/components/workspace-shell.tsx', 'utf8');
const MESSAGES = readFileSync('apps/dashboard/src/i18n/messages.ts', 'utf8');

/** Strip comments, for the reason `phase6-control-consistency.test.ts` records. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));
}

/** Every `href:` in the NAV array — the entries the rail can show. */
function navHrefs(): readonly string[] {
  const body = code(SHELL);
  const start = body.indexOf('const NAV: readonly NavEntry[] = [');
  const end = body.indexOf('const NAV_GROUPS');
  expect(start, 'the NAV array is gone').toBeGreaterThan(-1);
  expect(end, 'the NAV_GROUPS table is gone').toBeGreaterThan(start);
  return [...body.slice(start, end).matchAll(/href:\s*'([^']+)'/g)].map((m) => m[1] as string);
}

/** Every href placed into a group, in order. */
function groupedHrefs(): readonly string[] {
  const body = code(SHELL);
  const start = body.indexOf('const NAV_GROUPS');
  const end = body.indexOf('function navSections');
  expect(end, 'navSections is gone').toBeGreaterThan(start);
  return [...body.slice(start, end).matchAll(/'(\/[a-z-]+)'/g)].map((m) => m[1] as string);
}

describe('P6-04 · every navigation entry is placed exactly once', () => {
  it('places every NAV entry in a group', () => {
    const missing = navHrefs().filter((href) => !groupedHrefs().includes(href));
    expect(
      missing,
      `These routes are in NAV but in no group, so they would disappear from the ` +
        `rail without anything looking broken:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('places nothing twice, and nothing that is not in NAV', () => {
    const grouped = groupedHrefs();
    const duplicates = grouped.filter((href, index) => grouped.indexOf(href) !== index);
    expect(duplicates, 'a route appears in two groups').toEqual([]);

    const unknown = grouped.filter((href) => !navHrefs().includes(href));
    expect(unknown, 'a group names a route NAV does not define').toEqual([]);
  });

  it('keeps all twenty-two entries — grouping is not a cull', () => {
    // The count is asserted so that "tidying" the rail by dropping routes the
    // brief's list does not name shows up as a failure rather than as a
    // quieter sidebar. /permissions, /notifications, /plan and /onboarding are
    // real screens.
    //
    // TWENTY-TWO, and the number is here because I got it wrong: the Phase 6
    // audit said twenty-one, counted by eye. This test is the thing that
    // counts, and it disagreed on the first run.
    expect(navHrefs()).toHaveLength(22);
    expect(groupedHrefs()).toHaveLength(22);
  });
});

describe('P6-04 · the groups are the ones the brief names, in work order', () => {
  it('declares exactly seven groups', () => {
    const titles = [...code(SHELL).matchAll(/titleKey:\s*'(nav\.group\.[a-z]+)'/g)].map(
      (m) => m[1] as string,
    );
    expect(titles).toEqual([
      'nav.group.core',
      'nav.group.plan',
      'nav.group.create',
      'nav.group.publish',
      'nav.group.improve',
      'nav.group.automate',
      'nav.group.workspace',
    ]);
  });

  it('has an Arabic and an English string for every group title', () => {
    // CLAUDE.md §4: both languages are first-class, and a group heading is
    // user-facing copy like any other.
    for (const group of ['core', 'plan', 'create', 'publish', 'improve', 'automate', 'workspace']) {
      const occurrences = [...MESSAGES.matchAll(new RegExp(`'nav\\.group\\.${group}':`, 'g'))];
      expect(occurrences, `nav.group.${group} is not in both message tables`).toHaveLength(2);
    }
  });

  it('opens with the Command Center and closes with the workspace itself', () => {
    const grouped = groupedHrefs();
    expect(grouped[0]).toBe('/overview');
    expect(grouped[grouped.length - 1]).toBe('/settings');
  });
});

describe('P6-04 · grouping did not become a way to leak an entry', () => {
  it('still filters every item by the permission its route requires', () => {
    const builder = code(SHELL).slice(code(SHELL).indexOf('function navSections'));
    expect(builder).toContain('permissionKeys.includes(item.permission)');
    expect(builder).toContain('item.permission === null');
  });

  it('renders no heading for a group whose items are all filtered out', () => {
    // A Viewer holds `workspace.read` and nothing else (D-62, D-130), so most
    // groups are empty for them. An empty titled group is dead navigation
    // wearing a label.
    const builder = code(SHELL).slice(code(SHELL).indexOf('function navSections'));
    expect(builder).toMatch(/if \(items\.length > 0\)/);
  });

  it('keeps the testId convention the end-to-end suite depends on', () => {
    expect(code(SHELL)).toContain('testId: `nav-${item.href.slice(1)}`');
  });
});

describe('P6-04 · no new navigation UI was introduced', () => {
  const APP_SHELL = readFileSync('packages/ui/src/app-shell.tsx', 'utf8');

  it('uses the section title the shell has always supported', () => {
    // The whole point: `ShellNavSection.title` and its rendering predate this
    // change. If grouping had needed a new component, the brief's "the visual
    // system is LOCKED" would have been the thing to raise, not to work around.
    expect(APP_SHELL).toContain('readonly title?: string | undefined;');
    expect(APP_SHELL).toContain('.nav-group-title');
  });

  it('still replaces a heading with a divider when the rail is collapsed', () => {
    // Existing behaviour, asserted because seven groups exercise it far more
    // than one did: a heading next to unlabelled icons means nothing.
    expect(APP_SHELL).toMatch(/collapsed \? \(\s*<div\s+aria-hidden="true"/);
  });
});
