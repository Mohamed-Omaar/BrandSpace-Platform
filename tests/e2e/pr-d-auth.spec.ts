import { expect, test } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { enter, ownWorkspace, signIn } from './own-workspace';
import { withPlatformPrisma } from './platform-prisma';

/**
 * PR D — SIGN-IN, SIGN-UP, RESET AND THE WORKSPACE LIST (audit Auth 1–7).
 *
 *   1. The language button keeps the screen (it led every card to sign-in).
 *   2. "Check your email" shows the address in its box.
 *   3. "Wrong email?" goes back to sign-up with that address to correct.
 *   4. The forgot screen has "← Back to sign in".
 *   5. "Send me a link" lands on "The link is on its way", the same for every
 *      address.
 *   6. The workspace list offers "Create workspace" within the allowance.
 *   7. Teach keeps a decided fact with "Accepted" / "Rejected".
 */

for (const locale of ['en', 'ar'] as const) {
  const other = locale === 'ar' ? 'en' : 'ar';

  test(`the entry screens keep their place and say where the link went (${locale})`, async ({
    page,
  }) => {
    // 1. The language button keeps the screen, with its query.
    for (const path of ['sign-up', 'reset', 'sign-up/sent?email=a%40example.test']) {
      await page.goto(`${DASHBOARD_BASE_URL}/${locale}/${path}`);
      await expect(page.getByTestId('locale-switch')).toHaveAttribute('href', `/${other}/${path}`);
    }

    // 2 and 3. The address in its box; "Wrong email?" brings it back to correct.
    const address = `wrong-${Date.now().toString(36)}@example.test`;
    await page.goto(
      `${DASHBOARD_BASE_URL}/${locale}/sign-up/sent?email=${encodeURIComponent(address)}`,
    );
    await expect(page.getByTestId('signup-sent-address')).toHaveText(address);
    await page.getByTestId('signup-wrong-email').click();
    await page.waitForURL(new RegExp(`/${locale}/sign-up\\?email=`));
    await expect(page.locator('#email')).toHaveValue(address);

    // 4 and 5. Back to sign in; the link is on its way — for a stranger too.
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/reset`);
    await expect(page.getByTestId('reset-back')).toHaveAttribute('href', `/${locale}/sign-in`);
    await page.fill('#email', `nobody-${Date.now().toString(36)}@example.test`);
    await page.getByTestId('reset-request-submit').click();
    await page.waitForURL(new RegExp(`/${locale}/reset/sent$`));
    await expect(page.getByTestId('reset-sent')).toBeVisible();
    await expect(page.getByTestId('reset-back')).toHaveAttribute('href', `/${locale}/sign-in`);
  });

  test(`the workspace list offers no more than the rail's allowance (${locale})`, async ({
    page,
  }) => {
    // The e2e owner's own workspaces carry no plan, so their allowance is
    // "unavailable" — the rail says exactly that (prototype-v94-phase2b1). The
    // list then offers neither a create row nor a limit note. The create and
    // limit branches are pinned by unit/pr-d-workspaces-foot.
    await signIn(page, locale);
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/workspaces`);
    await expect(page.locator('.bsp-auth-wslist')).toBeVisible();
    await expect(page.getByTestId('workspaces-create')).toHaveCount(0);
    await expect(page.getByTestId('workspaces-limit')).toHaveCount(0);
  });

  test(`Teach keeps a decided fact with its decision (${locale})`, async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
    const own = await ownWorkspace(`pr-d-teach-${locale}`);
    const run = Date.now().toString(36);
    const ids = await withPlatformPrisma(async (prisma) => {
      const document = await prisma.brandSourceDocument.create({
        data: {
          workspaceId: own.workspaceId,
          brandId: own.brandId,
          fileName: `menu-${run}.txt`,
          mimeType: 'text/plain',
          byteSize: 10,
          checksum: `pr-d-${run}`,
          storageKey: `ws/${own.workspaceId}/brand-brain/pr-d-${run}`,
          status: 'READY',
          idempotencyKey: `pr-d-${run}`,
        },
        select: { id: true },
      });
      const made: string[] = [];
      for (const [index, text] of [`Cafe for students ${run}`, `Opens at 7 ${run}`].entries()) {
        const row = await prisma.brandKnowledgeCandidate.create({
          data: {
            workspaceId: own.workspaceId,
            brandId: own.brandId,
            sourceDocumentId: document.id,
            area: 'AUDIENCE',
            itemKey: `audience.pr-d-${run}-${index}`,
            extractedTitle: { en: text, ar: text },
            extractedBody: { en: text, ar: text },
            confidenceMilli: 900,
            evidence: [{ locator: 'page 1', quote: text, method: 'keyword', keywordHits: 2 }],
            status: 'PENDING',
          },
          select: { id: true },
        });
        made.push(row.id);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return made;
    });
    const [first, second] = ids as [string, string];
    await enter(page, own.slug, locale);
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/onboarding?step=learn`);
    await expect(page.getByTestId(`setup-candidate-${first}`)).toBeVisible();

    await page.getByTestId(`setup-accept-${first}`).click();
    await page.waitForURL(/ok=CANDIDATE_ACCEPTED/);
    await expect(page.getByTestId(`setup-decided-${first}`)).toHaveAttribute(
      'data-state',
      'accepted',
    );
    await expect(page.getByTestId(`setup-accept-${first}`)).toHaveCount(0);
    await expect(page.getByTestId(`setup-accept-${second}`)).toBeVisible();

    await page.getByTestId(`setup-reject-${second}`).click();
    await page.waitForURL(/ok=CANDIDATE_REJECTED|step=review/);
    await expect(page.getByTestId(`setup-decided-${second}`)).toHaveAttribute(
      'data-state',
      'rejected',
    );
    // Both stay; nothing is left to accept.
    await expect(page.getByTestId(`setup-candidate-${first}`)).toBeVisible();
    await expect(page.getByTestId('setup-accept-all')).toHaveCount(0);
  });
}
