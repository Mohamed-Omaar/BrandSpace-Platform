import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { withPlatformPrisma } from './platform-prisma';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';

/**
 * PHASE 6 FINAL · D-277 §8-§9, D-295 — "BRANDSPACE NOTICED A PREFERENCE".
 *
 * The suite writes the audited edits a person would have made (Shorten, or a
 * tone change, on generated words, across four posts), sees Home notice the
 * habit, makes it a default, sees the composer say so, and stops using it.
 * Each project owns its own key — desktop a Shorten, mobile a tone — so the
 * two parallel projects never decide each other's suggestion. Its own
 * decisions are removed before and after.
 */

function credentials(): E2eAdminCredentials {
  return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
}

async function signIn(page: Page): Promise<void> {
  const loaded = credentials();
  const { customer } = loaded;
  await useBrand(page, customer.workspaceId, brandFixtures(loaded).primaryBrandId);
  await page.goto(`${DASHBOARD_BASE_URL}/en/sign-in`);
  await page.fill('#email', customer.email);
  await page.fill('#password', customer.password);
  await page.click('[data-testid="signin-submit"]');
  await page.waitForURL(
    (url) => !url.pathname.endsWith('/sign-in') || url.searchParams.has('error'),
  );
  await page.click(`[data-testid="choose-workspace-${customer.workspaceSlug}"]`);
  await page.waitForURL(/\/en\/overview$/);
}

interface Habit {
  readonly key: string;
  readonly action: 'content.variant.shorten' | 'content.variant.tone';
  readonly after: Readonly<Record<string, string | boolean>>;
}

const HABITS: Record<string, Habit> = {
  desktop: {
    key: 'shorter:linkedin',
    action: 'content.variant.shorten',
    after: { platformKey: 'linkedin', afterGeneration: true },
  },
  mobile: {
    key: 'tone:professional:linkedin',
    action: 'content.variant.tone',
    after: { platformKey: 'linkedin', afterGeneration: true, tone: 'professional' },
  },
};
const habitFor = (project: string): Habit =>
  project.includes('mobile') ? HABITS['mobile']! : HABITS['desktop']!;

async function reset(habit: Habit): Promise<{ userId: string }> {
  const loaded = credentials();
  return withPlatformPrisma(async (prisma) => {
    const user = await prisma.user.findFirstOrThrow({
      where: { email: loaded.customer.email },
      select: { id: true },
    });
    await prisma.memberSuggestion.deleteMany({
      where: { workspaceId: loaded.customer.workspaceId, userId: user.id, key: habit.key },
    });
    return { userId: user.id };
  });
}

test.describe('D-295 · a noticed preference becomes a default only when chosen', () => {
  test('Home notices the habit; the person makes it a default; the composer says so', async ({
    page,
  }) => {
    const habit = habitFor(test.info().project.name);
    const { userId } = await reset(habit);
    const loaded = credentials();
    await withPlatformPrisma(async (prisma) => {
      for (let post = 0; post < 4; post += 1) {
        await prisma.auditEvent.create({
          data: {
            workspaceId: loaded.customer.workspaceId,
            actorType: 'USER',
            actorId: userId,
            action: habit.action,
            resourceType: 'ContentVariant',
            resourceId: randomUUID(),
            brandId: brandFixtures(loaded).primaryBrandId,
            after: habit.after,
          },
        });
      }
    });

    await signIn(page);
    const row = page.getByTestId(`home-preference-${habit.key}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText('after BrandSpace writes them');
    // The audit trail is append-only, so earlier runs' edits may add to the count.
    await expect(row).toContainText(/\d+ edits across \d+ posts/);

    await page.getByTestId(`home-preference-accept-${habit.key}`).click();
    await page.waitForURL((url) => url.searchParams.get('ok') === 'PREFERENCE_ACCEPT');
    await expect(page.getByTestId(`home-preference-${habit.key}`)).toHaveCount(0);

    await page.goto(`${DASHBOARD_BASE_URL}/en/content/compose?mode=ai`);
    const stated = page.getByTestId(`content-default-${habit.key}`);
    await expect(stated).toBeVisible();
    await stated.getByRole('button').click();
    await page.waitForURL(/\/en\/content\/compose\?ok=PREFERENCE_DISMISS/);
    await page.goto(`${DASHBOARD_BASE_URL}/en/content/compose?mode=ai`);
    await expect(page.getByTestId('content-composer')).toBeVisible();
    await expect(page.getByTestId(`content-default-${habit.key}`)).toHaveCount(0);

    const decision = await withPlatformPrisma((prisma) =>
      prisma.memberSuggestion.findFirst({
        where: { workspaceId: loaded.customer.workspaceId, userId, key: habit.key },
        select: { status: true },
      }),
    );
    expect(decision?.status).toBe('DISMISSED');
    await reset(habit);
  });
});
