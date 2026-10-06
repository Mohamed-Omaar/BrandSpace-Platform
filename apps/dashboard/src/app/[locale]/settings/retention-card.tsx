import { inWorkspace } from '../../../server/customer-context';
import { inContentStudio } from '../../../server/content-context';
import { translator } from '../../../i18n/messages';
import { requestMessageLocale } from '../../../server/message-locale';
import { saveRetentionAction } from '../content/actions';

/**
 * D-117 — THE CUSTOMER'S OWN RETENTION CONTROL, in Settings → Data, where the
 * prototype states retention (`Main.dc.html` line 1373, review of #67). It
 * moved here from General unchanged: the same form, the same action, the same
 * floor read from the activated `content` configuration (CLAUDE.md §2.2) and
 * enforced server-side by `saveRetentionAction`, by `resolveContentExpiry`
 * and by a CHECK constraint in the database.
 */
export async function RetentionCard({
  locale,
  workspaceId,
}: {
  readonly locale: string;
  readonly workspaceId: string;
}) {
  const t = translator(requestMessageLocale(locale));
  const [row, retentionFloor] = await Promise.all([
    inWorkspace(workspaceId, async ({ db }) =>
      db.workspace.findUniqueOrThrow({
        where: { id: workspaceId },
        select: { aiContentRetentionDays: true },
      }),
    ),
    inContentStudio(
      workspaceId,
      async ({ policy }) => (await policy()).retention.minCustomerRetentionDays,
    ),
  ]);
  return (
    <>
      {/*
          THE D-117 CONTROL, IN ITS OWN CARD.

          Separate from the workspace form on purpose: it is a different kind of
          promise. Renaming a workspace is cosmetic; shortening a retention
          window deletes the customer's own generated content on a schedule, so
          it gets its own explanation, its own save and its own audit event —
          and the sentence naming what it can NEVER delete is part of the
          control rather than a footnote somewhere else.
        */}
      {/*
        Round 4, Gate 2b — the prototype's retention card (`Main.dc.html` line
        1378): an `xcard` with the title at 14px / 600 over its 12px line; the
        product's own control (D-117) under it.
      */}
      <section className="bsp-xcard bsp-dt-ret" data-testid="retention-card">
        <form action={saveRetentionAction} className="bsp-dt-ret-form">
          <input type="hidden" name="locale" value={locale} />
          <span className="bsp-dt-title">{t('content.retention.title')}</span>
          <span className="bsp-dt-sub">{t('content.retention.body')}</span>
          <label className="bsp-dt-ret-field" htmlFor="retentionDays">
            <span className="bsp-lbl">{t('content.retention.label')}</span>
            <span className="bsp-dt-ret-row">
              <input
                className="bs-control bsp-dt-input"
                id="retentionDays"
                name="retentionDays"
                type="number"
                inputMode="numeric"
                min={retentionFloor}
                step={1}
                data-testid="retention-days"
                defaultValue={row.aiContentRetentionDays ?? ''}
                placeholder={t('content.retention.placeholder')}
                aria-describedby="retention-note"
              />
              <button type="submit" data-testid="retention-save" className="bsp-btn bsp-sm bsp-pur">
                {t('content.retention.save')}
              </button>
            </span>
          </label>
          <span id="retention-note" className="bsp-dt-sub">
            {t('content.retention.min')}: {retentionFloor}. {t('content.retention.excluded')}
          </span>
        </form>
      </section>
    </>
  );
}
