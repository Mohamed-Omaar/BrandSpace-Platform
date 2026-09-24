import type { ConfigDomain } from '@brandspace/config';
import {
  Card,
  Field,
  buttonClass,
  buttonStyle,
  colorTokens,
  inputStyle,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';
import { fill, simpleCopy } from '../../i18n/simple';
import type { OpenDraft } from '../../server/simple-config';
import { discardOpenDraftsAction } from '../../app/[locale]/console/drafts/actions';
import { AdvancedLink } from '../mode-switch';
import { pendingLabel } from './home';
import { formatWhen } from '../simple-ui';

/**
 * AN UNFINISHED CHANGE, SHOWN BEFORE IT BLOCKS ANYTHING (D-312).
 *
 * A Simple change never runs over somebody's open draft of the same setting.
 * This says so up front — what was saved, when, and why — and offers the two
 * honest ways forward: review it in Advanced, or discard it deliberately
 * (reason + confirmation, audited as `config.draft.discarded`).
 */
export function OpenDraftNotice({
  locale,
  drafts,
  next,
  advancedHref,
  mayDiscard,
}: {
  readonly locale: string;
  readonly drafts: readonly OpenDraft[];
  /** This screen's path, to come back to. */
  readonly next: string;
  /** The Advanced screen that can finish it, after `/console`. */
  readonly advancedHref: string;
  readonly mayDiscard: boolean;
}) {
  if (drafts.length === 0) return null;
  const copy = simpleCopy(locale);
  const domains = [...new Set(drafts.map((draft) => draft.domain))] as ConfigDomain[];
  return (
    <Card tone="warm" testId="open-draft-notice" title={copy('draft.title')}>
      <div style={{ display: 'grid', gap: spacingTokens.sm }}>
        {drafts.map((draft) => (
          <div key={draft.id} style={{ display: 'grid', gap: '2px', ...typographyTokens.bodySm }}>
            <span>
              {fill(copy('draft.body'), {
                what: pendingLabel(locale, draft.domain),
                when: formatWhen(locale, draft.createdAt),
              })}
            </span>
            {draft.changeReason ? (
              <span style={{ color: colorTokens.textSecondary }}>
                {fill(copy('draft.reason'), { reason: draft.changeReason })}
              </span>
            ) : null}
          </div>
        ))}
        <div>
          <AdvancedLink
            locale={locale}
            href={advancedHref}
            label={copy('draft.review')}
            testId="open-draft-review"
          />
        </div>
        {mayDiscard ? (
          <form action={discardOpenDraftsAction} style={{ display: 'grid', gap: spacingTokens.xs }}>
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="next" value={next} />
            {domains.map((domain) => (
              <input key={domain} type="hidden" name="domain" value={domain} />
            ))}
            <Field
              label={copy('common.reason')}
              htmlFor="draft-discard-reason"
              hint={copy('common.reasonHint')}
            >
              <input
                id="draft-discard-reason"
                name="reason"
                required
                minLength={8}
                className="bs-control"
                style={{ ...inputStyle(), maxInlineSize: '28rem' }}
                data-testid="open-draft-reason"
              />
            </Field>
            <label
              style={{
                display: 'flex',
                gap: spacingTokens.xs,
                alignItems: 'start',
                ...typographyTokens.bodySm,
              }}
            >
              <input
                type="checkbox"
                name="confirm"
                value="yes"
                required
                data-testid="open-draft-confirm"
              />
              {copy('draft.discardConfirm')}
            </label>
            <div>
              <button
                type="submit"
                className={buttonClass('neutral')}
                style={buttonStyle('neutral')}
                data-testid="open-draft-discard"
              >
                {copy('draft.discard')}
              </button>
            </div>
          </form>
        ) : null}
      </div>
    </Card>
  );
}
