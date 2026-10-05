import {
  Card,
  Field,
  buttonStyle,
  colorTokens,
  inputStyle,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';
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
      <Card testId="retention-card">
        <form action={saveRetentionAction} style={{ display: 'grid', gap: spacingTokens.md }}>
          <input type="hidden" name="locale" value={locale} />
          <div>
            <b>{t('content.retention.title')}</b>
            <p style={{ ...typographyTokens.bodySm, color: colorTokens.textMuted }}>
              {t('content.retention.body')}
            </p>
          </div>

          <Field label={t('content.retention.label')} htmlFor="retentionDays">
            <input
              className="bs-control"
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
              style={inputStyle()}
            />
          </Field>

          <p
            id="retention-note"
            style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}
          >
            {t('content.retention.min')}: {retentionFloor}. {t('content.retention.excluded')}
          </p>

          <div>
            <button type="submit" data-testid="retention-save" style={buttonStyle('primary')}>
              {t('content.retention.save')}
            </button>
          </div>
        </form>
      </Card>
    </>
  );
}
