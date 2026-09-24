import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { withPlatformPrisma } from './platform-prisma';
import { E2E_CREDENTIALS_FILE, type E2eAdminCredentials } from './env';

/**
 * PHASE 6 FINAL · D-277 §29, D-288 — APPROVALS AS ONE FLOW.
 *
 * The next step in the composer follows the brand's own policy; "changes
 * requested" shows the reviewer's reason and resolves-and-resubmits in one
 * action through the same approval service; the reviewer sees the post as it
 * will look, with its conversation. Each test builds its own brand and post.
 */

function credentials(): E2eAdminCredentials {
  return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
}

async function signIn(page: Page, brandId: string): Promise<void> {
  const { customer } = credentials();
  await useBrand(page, customer.workspaceId, brandId);
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

interface Fixture {
  readonly brandId: string;
  readonly itemId: string;
  readonly ownerId: string;
  readonly colleagueId: string;
  readonly colleagueName: string;
}

/** A fresh brand, a one-variant post in it, and a colleague who can review. */
async function fixture(
  status: 'DRAFT' | 'CHANGES_REQUESTED' | 'IN_REVIEW',
  requireApproval: boolean | null,
): Promise<Fixture> {
  const { customer } = credentials();
  const suffix = randomUUID().slice(0, 6);
  return withPlatformPrisma(async (prisma) => {
    const owner = await prisma.user.findFirstOrThrow({
      where: { email: customer.email },
      select: { id: true },
    });
    const colleague = await prisma.membership.findFirstOrThrow({
      where: {
        workspaceId: customer.workspaceId,
        status: 'ACTIVE',
        user: { email: { not: customer.email }, name: { not: null } },
      },
      select: { userId: true, user: { select: { name: true } } },
    });
    const brand = await prisma.brand.create({
      data: {
        workspaceId: customer.workspaceId,
        name: `Flow ${suffix}`,
        slug: `flow-${suffix}`,
        status: 'ACTIVE',
        defaultLocale: 'EN',
        supportedLocales: ['EN'],
      },
      select: { id: true },
    });
    if (requireApproval !== null) {
      await prisma.approvalPolicy.create({
        data: {
          workspaceId: customer.workspaceId,
          brandId: brand.id,
          requireApprovalBeforeScheduling: requireApproval,
        },
      });
    }
    const item = await prisma.contentItem.create({
      data: {
        workspaceId: customer.workspaceId,
        brandId: brand.id,
        title: `Flow post ${suffix}`,
        status,
        primaryLocale: 'EN',
        createdByUserId: owner.id,
      },
      select: { id: true },
    });
    await prisma.contentVariant.create({
      data: {
        workspaceId: customer.workspaceId,
        brandId: brand.id,
        contentItemId: item.id,
        platformKey: 'instagram',
        locale: 'EN',
        body: `The words under review, ${suffix}.`,
        characterCount: 30,
        validationState: 'VALID',
      },
    });
    return {
      brandId: brand.id,
      itemId: item.id,
      ownerId: owner.id,
      colleagueId: colleague.userId,
      colleagueName: colleague.user.name ?? '',
    };
  });
}

const compose = (itemId: string) => `${DASHBOARD_BASE_URL}/en/content/compose?item=${itemId}`;

test.describe('D-288 · the next step follows the brand policy', () => {
  test('no approval required: Schedule is the next step, review stays available', async ({
    page,
  }) => {
    const f = await fixture('DRAFT', false);
    await signIn(page, f.brandId);
    await page.goto(compose(f.itemId));
    await expect(page.getByTestId('editor-schedule')).toHaveAttribute(
      'href',
      `/en/calendar?item=${f.itemId}`,
    );
    await expect(page.getByTestId('submit-for-review')).toHaveClass(/cs-ghost-button/);
    await expect(page.getByTestId('editor-needs-approval')).toHaveCount(0);
  });

  test('approval required: review first, and no way to schedule before it', async ({ page }) => {
    const f = await fixture('DRAFT', true);
    await signIn(page, f.brandId);
    await page.goto(compose(f.itemId));
    await expect(page.getByTestId('editor-needs-approval')).toBeVisible();
    await expect(page.getByTestId('submit-for-review')).toHaveClass(/cs-dark-button/);
    await expect(page.getByTestId('editor-schedule')).toHaveCount(0);
  });
});

test.describe('D-288 · changes requested, then resubmitted in one action', () => {
  test('the reviewer’s reason is shown; answering resolves it and reopens review', async ({
    page,
  }) => {
    const f = await fixture('CHANGES_REQUESTED', true);
    const { customer } = credentials();
    const reason = `Please use the spring photo ${randomUUID().slice(0, 6)}.`;
    const threadId = await withPlatformPrisma(async (prisma) => {
      const decidedAt = new Date();
      await prisma.approval.create({
        data: {
          workspaceId: customer.workspaceId,
          brandId: f.brandId,
          contentItemId: f.itemId,
          requestedByUserId: f.ownerId,
          status: 'CHANGES_REQUESTED',
          decisionNote: reason,
          decidedByUserId: f.colleagueId,
          decidedAt,
          cycle: 1,
        },
      });
      const thread = await prisma.noteThread.create({
        data: {
          workspaceId: customer.workspaceId,
          brandId: f.brandId,
          subjectType: 'CONTENT_ITEM',
          contentItemId: f.itemId,
          createdByUserId: f.colleagueId,
          createdAt: new Date(decidedAt.getTime() + 1_000),
        },
        select: { id: true },
      });
      await prisma.note.create({
        data: {
          workspaceId: customer.workspaceId,
          threadId: thread.id,
          authorUserId: f.colleagueId,
          body: reason,
        },
      });
      return thread.id;
    });

    await signIn(page, f.brandId);
    await page.goto(compose(f.itemId));
    const panel = page.getByTestId('changes-requested-panel');
    await expect(panel).toContainText(`${f.colleagueName} requested changes`);
    await expect(page.getByTestId('changes-requested-note')).toHaveText(reason);

    await page.getByTestId('resubmit-reply').fill('Swapped in the spring photo.');
    await page.getByTestId('resubmit-submit').click();
    await page.waitForURL((url) => url.searchParams.get('ok') === 'SUBMITTED', {
      timeout: 60_000,
    });

    const after = await withPlatformPrisma(async (prisma) => ({
      item: await prisma.contentItem.findUniqueOrThrow({
        where: { id: f.itemId },
        select: { status: true },
      }),
      thread: await prisma.noteThread.findUniqueOrThrow({
        where: { id: threadId },
        select: { status: true, notes: { select: { body: true } } },
      }),
      open: await prisma.approval.findFirst({
        where: { contentItemId: f.itemId, status: 'PENDING' },
        select: { cycle: true, requestNote: true },
      }),
    }));
    expect(after.item.status).toBe('IN_REVIEW');
    expect(after.thread.status).toBe('RESOLVED');
    expect(after.thread.notes.map((note) => note.body)).toContain('Swapped in the spring photo.');
    expect(after.open?.requestNote).toBe('Swapped in the spring photo.');
    // Leave the shared queue as it was found.
    await withPlatformPrisma((prisma) =>
      prisma.approval.updateMany({
        where: { contentItemId: f.itemId, status: 'PENDING' },
        data: { status: 'CANCELLED' },
      }),
    );
  });
});

test.describe('D-288 · the reviewer sees the post and its conversation', () => {
  test('a review shows the platform preview and the notes beside the verdict', async ({ page }) => {
    const f = await fixture('IN_REVIEW', true);
    const { customer } = credentials();
    const approvalId = await withPlatformPrisma(
      async (prisma) =>
        (
          await prisma.approval.create({
            data: {
              workspaceId: customer.workspaceId,
              brandId: f.brandId,
              contentItemId: f.itemId,
              requestedByUserId: f.colleagueId,
              // ASSIGNED to the colleague: the signed-in owner may read the
              // review but it offers them no verdict, so no other suite's queue
              // ever finds a decision it did not create.
              assignedToUserId: f.colleagueId,
              status: 'PENDING',
              cycle: 1,
            },
            select: { id: true },
          })
        ).id,
    );
    try {
      await signIn(page, f.brandId);
      await page.goto(`${DASHBOARD_BASE_URL}/en/approvals?review=${approvalId}`);
      const subject = page.getByTestId('approvals-review-subject');
      await expect(subject.getByTestId('review-preview-instagram')).toContainText(
        'The words under review',
      );
      await expect(subject.getByTestId('notes-panel')).toBeVisible();
    } finally {
      // The queue is shared: a review left open would be a verdict another
      // suite finds in its own queue.
      await withPlatformPrisma((prisma) =>
        prisma.approval.update({ where: { id: approvalId }, data: { status: 'CANCELLED' } }),
      );
    }
  });
});
