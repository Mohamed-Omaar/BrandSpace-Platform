import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROLE_DEFINITIONS, maySpendCredits } from '@brandspace/shared';
import { mayApproveForBrand } from '@brandspace/content';
import { NOTE_MANAGE_PERMISSION, NOTE_PERMISSION } from '@brandspace/collaboration';
import { homeSectionsFor } from '../../apps/dashboard/src/server/home';
import { KNOWN_PAGE_PERMISSIONS } from '../../apps/dashboard/src/server/known-routes';

/**
 * Q12, SECOND RELEASE — WHAT `content.read` OPENS FOR THE REAL VIEWER, AND
 * WHAT STAYS SHUT.
 *
 * The grant only activates paths Phase 2A already built. This pins both halves
 * against the role definition itself, not a literal: the pages the Viewer now
 * opens, and the server-action gates it still fails. The service-level refusals
 * (decide, withdraw, archive, campaigns, note triage) are proven against
 * PostgreSQL with the role's real grants in tests/isolation.
 */

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const viewer = ROLE_DEFINITIONS.find((r) => r.key === 'client_viewer')?.permissionKeys ?? [];

/** The body of one exported server action, to its closing export. */
function action(file: string, name: string): string {
  const source = read(file);
  const start = source.indexOf(`export async function ${name}(`);
  expect(start, `${file} exports ${name}`).toBeGreaterThanOrEqual(0);
  const next = source.indexOf('\nexport async function', start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

const CONTENT = 'apps/dashboard/src/app/[locale]/content/actions.ts';
const CALENDAR = 'apps/dashboard/src/app/[locale]/calendar/actions.ts';

describe('Q12 · the real Viewer reads content', () => {
  it('holds exactly workspace.read and content.read', () => {
    expect(viewer).toEqual(['workspace.read', 'content.read']);
  });

  it('opens Content, the Studio, the Calendar, Approvals and Notes', () => {
    for (const route of ['/content', '/content/compose', '/calendar', '/approvals', '/notes']) {
      const needed = KNOWN_PAGE_PERMISSIONS[route as keyof typeof KNOWN_PAGE_PERMISSIONS];
      expect(needed, route).toBe('content.read');
      expect(viewer, route).toContain(needed);
    }
  });

  it('gets the E7 feedback section on Home, and nothing that creates, approves or analyses', () => {
    expect(homeSectionsFor(viewer)).toEqual({
      reviewQueue: false,
      myWork: false,
      topPosts: false,
      feedback: true,
    });
    const home = read('apps/dashboard/src/app/[locale]/overview/page.tsx');
    expect(home).toContain('data-testid="home-feedback-calendar"');
  });
});

describe('Q12 · and every mutation stays behind a permission it does not hold', () => {
  it.each([
    [CONTENT, 'createManualDraftAction', 'content.create'],
    [CONTENT, 'duplicateContentAction', 'content.create'],
    [CONTENT, 'saveVariantAction', 'content.edit'],
    [CONTENT, 'submitForReviewAction', 'content.submit'],
    [CONTENT, 'transitionItemAction', 'content.archive'],
    [CALENDAR, 'scheduleContentAction', 'content.schedule'],
    [CALENDAR, 'rescheduleContentAction', 'content.schedule'],
    [CALENDAR, 'cancelScheduleAction', 'content.schedule'],
  ])('%s › %s is gated on %s, which the Viewer lacks', (file, name, permission) => {
    expect(action(file, name)).toContain(`requireWorkspaceAction(locale, '${permission}')`);
    expect(viewer).not.toContain(permission);
  });

  it('may not approve, spend credits or triage notes', () => {
    expect(mayApproveForBrand({ permissionKeys: viewer })).toBe(false);
    expect(maySpendCredits(viewer, 'content.create')).toBe(false);
    expect(viewer).toContain(NOTE_PERMISSION);
    expect(viewer).not.toContain(NOTE_MANAGE_PERMISSION);
  });
});
