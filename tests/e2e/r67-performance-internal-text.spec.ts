import { expect, test } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { enter, ownWorkspace } from './own-workspace';
import { withPlatformPrisma } from './platform-prisma';

/**
 * REVIEW OF #67 — RAW INTERNAL TEXT NEVER RENDERS TO A CUSTOMER.
 *
 * Performance's "Why might this matter?" printed the platform's own evidence
 * record: `e | METRIC | metric.total | metric=clicks | value= | unit=COUNT |
 * from=-- | to=--`. The grounding gate now refuses such a generation; this
 * suite proves the screens hold even for a row stored before it did — the
 * explanation is written straight to the database, record lines and all, in a
 * workspace of the suite's own, beside one real sentence that must still show.
 */

const RECORD = 'e | METRIC | metric.total | metric=clicks | value= | unit=COUNT | from=-- | to=--';
const SENTENCE = 'Saves rose in the same weeks the educational posts went out.';

test.describe('review of #67 · Performance shows prose, never the evidence record', () => {
  for (const locale of ['en', 'ar'] as const) {
    test(`the explanation's record lines are not shown (${locale})`, async ({ page }, testInfo) => {
      test.skip(
        testInfo.project.name.includes('mobile'),
        'one run creates its own workspace; the desktop run covers it',
      );
      const own = await ownWorkspace(`r67-pf-${locale}`);
      const insightId = await withPlatformPrisma(async (prisma) => {
        const now = new Date();
        const row = await prisma.insight.create({
          data: {
            workspaceId: own.workspaceId,
            brandId: own.brandId,
            type: 'ANALYTICS_EXPLANATION',
            status: 'NEW',
            basis: 'OWN_PERFORMANCE',
            title: { en: 'Why this period moved', ar: 'لماذا تحركت هذه الفترة' },
            body: {
              summary: { en: RECORD, ar: RECORD },
              notableChanges: [],
              claims: [
                { evidenceRefs: [1], text: { en: RECORD, ar: RECORD } },
                { evidenceRefs: [1], text: { en: SENTENCE, ar: SENTENCE } },
              ],
              recommendations: [{ evidenceRefs: [1], text: { en: RECORD, ar: RECORD } }],
            },
            periodStart: new Date(now.getTime() - 28 * 86_400_000),
            periodEnd: now,
            idempotencyKey: `r67-pf-${locale}-${own.slug}`,
          },
          select: { id: true },
        });
        await prisma.insightEvidence.create({
          data: {
            workspaceId: own.workspaceId,
            brandId: own.brandId,
            insightId: row.id,
            ordinal: 1,
            kind: 'ABSENCE',
            labelKey: 'content.top_performer',
          },
        });
        return row.id;
      });

      await enter(page, own.slug, locale);

      // Performance: the real sentence is there; the record is not, anywhere.
      await page.goto(
        `${DASHBOARD_BASE_URL}/${locale}/analytics?brand=${own.brandId}&range=90&view=insights`,
      );
      await expect(page.getByTestId('analytics-why')).toContainText(SENTENCE);
      const performance = await page.locator('main').innerText();
      expect(performance).not.toContain('unit=');
      expect(performance).not.toContain('| METRIC |');
      expect(performance).not.toContain('metric.total');

      // Marketing Intelligence, the same finding opened on its own.
      await page.goto(`${DASHBOARD_BASE_URL}/${locale}/intelligence?insight=${insightId}`);
      await expect(page.getByTestId('intelligence-narrative')).toContainText(SENTENCE);
      const intelligence = await page.locator('main').innerText();
      expect(intelligence).not.toContain('unit=');
      expect(intelligence).not.toContain('| METRIC |');
    });
  }
});
