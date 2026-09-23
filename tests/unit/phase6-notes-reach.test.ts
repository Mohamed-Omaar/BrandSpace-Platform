import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * PHASE 6 · P6-08 / P6-09 — THE CONVERSATION REACHES EVERY SUBJECT THE DOMAIN
 * SUPPORTS.
 *
 * `NoteSubjectType` has three members, and a capability that exists in the
 * schema but is mounted on one screen is a capability most of the product does
 * not have. The panel now renders on all three:
 *
 *   CONTENT_ITEM  the composer — where a "needs work" verdict lands (P6-06)
 *   CAMPAIGN      the campaign room (P6-08)
 *   BRAND         Brand Brain (P6-07)
 *
 * WHY A SOURCE TEST RATHER THAN A RENDER. What is being asserted is that a
 * mounting exists at all, on server components that read a session and a
 * database. Rendering them would need the whole request pipeline to prove a
 * fact that is visible in one line of each file — and the failure this catches
 * is somebody adding a fourth subject type to the domain and mounting it
 * nowhere, which no render test would notice either.
 */

const PAGES = {
  CONTENT_ITEM: 'apps/dashboard/src/app/[locale]/content/compose/page.tsx',
  CAMPAIGN: 'apps/dashboard/src/app/[locale]/campaigns/[campaignId]/page.tsx',
  BRAND: 'apps/dashboard/src/app/[locale]/brand-brain/page.tsx',
} as const;

/** The subject types the domain declares. One list, read from the source. */
function declaredSubjectTypes(): readonly string[] {
  const source = readFileSync('packages/collaboration/src/notes.ts', 'utf8');
  const match = source.match(/export type NoteSubjectType =([^;]+);/);
  expect(match, 'NoteSubjectType is gone').not.toBeNull();
  return [...(match?.[1] ?? '').matchAll(/'([A-Z_]+)'/g)].map((m) => m[1] as string);
}

describe('P6-08/09 · every subject the domain supports has a screen', () => {
  it('declares exactly the three subjects the panel is mounted for', () => {
    // If a fourth arrives, this fails and the next test says where to mount it.
    expect([...declaredSubjectTypes()].sort()).toEqual(['BRAND', 'CAMPAIGN', 'CONTENT_ITEM']);
  });

  it.each(Object.entries(PAGES))('mounts the panel on the %s screen', (subject, path) => {
    const source = readFileSync(path, 'utf8');
    expect(source, `${path} does not import NotesPanel`).toContain('NotesPanel');
    expect(source, `${path} does not pass subject type ${subject}`).toContain(`'${subject}'`);
  });

  it('gives every panel a return path, so posting does not lose the page', () => {
    // `revalidatePath` needs somewhere to refresh. A panel without one refreshes
    // `/` and the reader loses the draft they were writing about.
    for (const path of Object.values(PAGES)) {
      expect(readFileSync(path, 'utf8'), `${path} has no returnPath`).toContain('returnPath=');
    }
  });

  it('only offers the composer panel once a draft exists', () => {
    /*
     * There is nothing to discuss before the item has an id, and a panel
     * offering to comment on a thing that has not been created would be a
     * control that cannot work — the service would answer 404 and the panel
     * would render nothing, which looks like a bug rather than a state.
     */
    const source = readFileSync(PAGES.CONTENT_ITEM, 'utf8');
    expect(source).toMatch(/\{draft \? \(\s*<NotesPanel/);
  });
});

describe('P6-07 · mounting notes on Brand Brain did not merge the two', () => {
  it('collaboration still depends on nothing from brand-brain', () => {
    /*
     * THE SEPARATION IS STRUCTURAL, AND MOUNTING THE PANEL BESIDE THE FOUR
     * MEMORIES IS EXACTLY WHEN IT WOULD START TO ERODE.
     *
     * A note about a brand now renders on the same screen as the brand's
     * governed knowledge. That is the right place for the conversation and the
     * wrong place to relax the rule: brand knowledge carries provenance and an
     * authority level and is what every AI surface generates from; a note is an
     * opinion in a thread. The dependency graph is what keeps them apart.
     */
    const manifest = JSON.parse(readFileSync('packages/collaboration/package.json', 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain('@brandspace/brand-brain');
  });

  it('and brand-brain depends on nothing from collaboration', () => {
    // The other direction, which is the one that would let a knowledge write
    // quietly open a thread — or read one as evidence.
    const manifest = JSON.parse(readFileSync('packages/brand-brain/package.json', 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain('@brandspace/collaboration');
  });
});
