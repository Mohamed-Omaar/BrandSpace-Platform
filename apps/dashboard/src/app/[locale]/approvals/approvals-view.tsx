import Link from 'next/link';
import {
  Card,
  Field,
  SectionHeader,
  Stack,
  StateMessage,
  StatusBadge,
  buttonStyle,
  inputStyle,
  CONTROL_CLASS,
  colorTokens,
  spacingTokens,
  typographyTokens,
  type BadgeTone,
} from '@brandspace/ui';
import type { MessageKey } from '../../../i18n/messages';

/**
 * The Approvals screen — Phase 5B-3, docs/PRODUCT.md §5 module 14.
 *
 * A DESIGN-SYSTEM EXTENSION, NOT A DEMO PORT (UI-FIDELITY-CONTRACT §6). The
 * approved demo routes `#customer/approvals` to `simpleFeaturePage('approvals')`
 * — a "Future product preview" placeholder with three identical cards and no
 * design behind it, exactly the case §6.1 was written for after the Asset
 * Library. So the screen is composed from what already ships: `Card`,
 * `SectionHeader`, `StateMessage`, `StatusBadge`, `Field` and the button and
 * spacing tokens, inside the shared dashboard shell. Nothing new was invented.
 *
 * A SERVER COMPONENT WITH FORMS, and no client JavaScript at all. Every control
 * is a `<form>` posting to a server action, so the screen works with scripting
 * unavailable and every decision is enforced where it must be.
 */

export interface ApprovalRow {
  readonly id: string;
  readonly itemId: string;
  readonly itemTitle: string;
  readonly brandName: string;
  readonly status: 'PENDING' | 'APPROVED' | 'CHANGES_REQUESTED' | 'REJECTED' | 'CANCELLED';
  readonly requestedByLabel: string;
  readonly requestedAtLabel: string;
  readonly cycle: number;
  readonly requestNote: string | null;
  /** Server-resolved. The button is hidden because this is false, never the reverse. */
  readonly mayDecide: boolean;
  /** True when the reader submitted it and the brand forbids self-approval. */
  readonly blockedAsSelf: boolean;
  readonly mayWithdraw: boolean;
}

export interface BrandPolicyRow {
  readonly brandId: string;
  readonly brandName: string;
  readonly requireApprovalBeforeScheduling: boolean;
  readonly allowSelfApproval: boolean;
  readonly clientApprovalEnabled: boolean;
}

const STATUS_TONE: Record<ApprovalRow['status'], BadgeTone> = {
  PENDING: 'warning',
  APPROVED: 'success',
  CHANGES_REQUESTED: 'warning',
  REJECTED: 'danger',
  CANCELLED: 'neutral',
};

export function ApprovalsView({
  locale,
  t,
  queue,
  mine,
  policies,
  mayReview,
  mayManagePolicy,
  actions,
}: {
  readonly locale: string;
  readonly t: (key: MessageKey) => string;
  readonly queue: readonly ApprovalRow[];
  readonly mine: readonly ApprovalRow[];
  readonly policies: readonly BrandPolicyRow[];
  readonly mayReview: boolean;
  readonly mayManagePolicy: boolean;
  readonly actions: {
    decide(formData: FormData): Promise<void>;
    withdraw(formData: FormData): Promise<void>;
    savePolicy(formData: FormData): Promise<void>;
  };
}) {
  return (
    <Stack>
      <Card testId="approvals-queue">
        <SectionHeader eyebrow={t('approvals.eyebrow')} title={t('approvals.queue')} />
        {!mayReview ? (
          <StateMessage
            title={t('approvals.noPermissionTitle')}
            description={t('approvals.noPermissionBody')}
          />
        ) : queue.length === 0 ? (
          <StateMessage
            title={t('approvals.queueEmptyTitle')}
            description={t('approvals.queueEmptyBody')}
          />
        ) : (
          <ul style={listStyle} data-testid="approvals-queue-list">
            {queue.map((row) => (
              <li key={row.id} style={rowStyle} data-testid={`approval-${row.itemId}`}>
                <ApprovalSummary locale={locale} t={t} row={row} />
                {row.mayDecide ? (
                  <form action={actions.decide} style={formStyle}>
                    <input type="hidden" name="locale" value={locale} />
                    <input type="hidden" name="approvalId" value={row.id} />
                    <Field label={t('approvals.decisionNote')} htmlFor={`note-${row.id}`}>
                      <input
                        id={`note-${row.id}`}
                        name="note"
                        type="text"
                        style={inputStyle()}
                        className={CONTROL_CLASS}
                        placeholder={t('approvals.notePlaceholder')}
                        maxLength={1000}
                      />
                    </Field>
                    <div style={buttonRowStyle}>
                      <button
                        type="submit"
                        name="verdict"
                        value="APPROVE"
                        style={buttonStyle('primary')}
                        data-testid={`approve-${row.itemId}`}
                      >
                        {t('approvals.approve')}
                      </button>
                      <button
                        type="submit"
                        name="verdict"
                        value="REQUEST_CHANGES"
                        style={buttonStyle('ghost')}
                        data-testid={`request-changes-${row.itemId}`}
                      >
                        {t('approvals.requestChanges')}
                      </button>
                      <button
                        type="submit"
                        name="verdict"
                        value="REJECT"
                        style={buttonStyle('ghost')}
                        data-testid={`reject-${row.itemId}`}
                      >
                        {t('approvals.reject')}
                      </button>
                    </div>
                  </form>
                ) : row.blockedAsSelf ? (
                  /*
                   * D-122. The reader submitted this and the brand forbids
                   * self-approval, so it says so rather than silently omitting
                   * the buttons — a control that vanishes without explanation
                   * reads as a bug. The server refuses it regardless.
                   */
                  <p style={noteStyle} data-testid={`self-blocked-${row.itemId}`}>
                    {t('approvals.selfBlocked')}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card testId="approvals-mine">
        <SectionHeader title={t('approvals.mine')} />
        {mine.length === 0 ? (
          <StateMessage
            title={t('approvals.mineEmptyTitle')}
            description={t('approvals.mineEmptyBody')}
          />
        ) : (
          <ul style={listStyle} data-testid="approvals-mine-list">
            {mine.map((row) => (
              <li key={row.id} style={rowStyle} data-testid={`mine-${row.itemId}`}>
                <ApprovalSummary locale={locale} t={t} row={row} />
                {row.mayWithdraw ? (
                  <form action={actions.withdraw}>
                    <input type="hidden" name="locale" value={locale} />
                    <input type="hidden" name="approvalId" value={row.id} />
                    <button
                      type="submit"
                      style={buttonStyle('ghost')}
                      data-testid={`withdraw-${row.itemId}`}
                    >
                      {t('approvals.withdraw')}
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {policies.length > 0 ? (
        <Card testId="approvals-policy">
          <SectionHeader
            title={t('approvals.policyTitle')}
            description={t('approvals.policyBody')}
          />
          {!mayManagePolicy ? (
            <p style={noteStyle}>{t('approvals.policyNoPermission')}</p>
          ) : (
            <ul style={listStyle}>
              {policies.map((policy) => (
                <li key={policy.brandId} style={rowStyle}>
                  <form action={actions.savePolicy} style={formStyle}>
                    <input type="hidden" name="locale" value={locale} />
                    <input type="hidden" name="brandId" value={policy.brandId} />
                    <strong style={typographyTokens.bodySm}>{policy.brandName}</strong>
                    <Checkbox
                      name="requireApproval"
                      label={t('approvals.policyRequire')}
                      checked={policy.requireApprovalBeforeScheduling}
                      testId={`policy-require-${policy.brandId}`}
                    />
                    <Checkbox
                      name="allowSelfApproval"
                      label={t('approvals.policySelf')}
                      checked={policy.allowSelfApproval}
                      testId={`policy-self-${policy.brandId}`}
                    />
                    <Checkbox
                      name="clientApproval"
                      label={t('approvals.policyClient')}
                      checked={policy.clientApprovalEnabled}
                      testId={`policy-client-${policy.brandId}`}
                    />
                    <button
                      type="submit"
                      style={buttonStyle('ghost')}
                      data-testid={`policy-save-${policy.brandId}`}
                    >
                      {t('approvals.policySave')}
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}
    </Stack>
  );
}

function ApprovalSummary({
  locale,
  t,
  row,
}: {
  readonly locale: string;
  readonly t: (key: MessageKey) => string;
  readonly row: ApprovalRow;
}) {
  return (
    <div style={{ display: 'grid', gap: spacingTokens['3xs'] }}>
      <div
        style={{ display: 'flex', gap: spacingTokens.xs, alignItems: 'center', flexWrap: 'wrap' }}
      >
        <Link href={`/${locale}/content/compose?item=${row.itemId}`} style={linkStyle}>
          {row.itemTitle}
        </Link>
        <StatusBadge
          label={t(`approvals.status.${row.status}` as MessageKey)}
          tone={STATUS_TONE[row.status]}
          testId={`approval-status-${row.itemId}`}
        />
      </div>
      <span style={metaStyle}>
        {row.brandName} · {t('approvals.requestedBy')} {row.requestedByLabel} ·{' '}
        {t('approvals.requestedAt')} {row.requestedAtLabel} · {t('approvals.cycle')} {row.cycle}
      </span>
      {row.requestNote ? <p style={noteStyle}>{row.requestNote}</p> : null}
    </div>
  );
}

/**
 * A checkbox, composed rather than created.
 *
 * `Field` renders a text control, and a checkbox is the one shape it does not
 * cover. It uses the same label typography, the same focus treatment and the
 * same spacing tokens as everything else — UI-FIDELITY-CONTRACT §6.2 rule 4
 * asks for a recorded reason when something new appears, and this is it.
 */
function Checkbox({
  name,
  label,
  checked,
  testId,
}: {
  readonly name: string;
  readonly label: string;
  readonly checked: boolean;
  readonly testId: string;
}) {
  return (
    /*
     * THE WHOLE ROW IS THE TARGET, and it is at least 24px tall.
     *
     * WCAG 2.2 AA 2.5.8 sets a 24×24 minimum, and a native checkbox renders at
     * about 13×13 — axe caught exactly that here. Growing the box alone would
     * have fixed the number and left a fiddly target; making the LABEL the
     * target is what the success criterion is actually asking for, and a label
     * wrapping its own input is already a click target in every browser.
     */
    <label
      style={{
        display: 'flex',
        gap: spacingTokens.xs,
        alignItems: 'center',
        minBlockSize: '24px',
        cursor: 'pointer',
      }}
    >
      <input
        type="checkbox"
        name={name}
        defaultChecked={checked}
        data-testid={testId}
        style={{ inlineSize: '20px', blockSize: '20px', margin: 0, cursor: 'pointer' }}
      />
      <span style={typographyTokens.bodySm}>{label}</span>
    </label>
  );
}

const listStyle = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'grid',
  gap: spacingTokens.md,
} as const;

const rowStyle = {
  display: 'grid',
  gap: spacingTokens.sm,
  paddingBlock: spacingTokens.sm,
  borderBlockEnd: `1px solid ${colorTokens.border}`,
} as const;

const formStyle = { display: 'grid', gap: spacingTokens.xs } as const;

const buttonRowStyle = {
  display: 'flex',
  gap: spacingTokens.xs,
  flexWrap: 'wrap',
} as const;

const metaStyle = { ...typographyTokens.caption, color: colorTokens.textMuted } as const;

const noteStyle = {
  ...typographyTokens.bodySm,
  color: colorTokens.textMuted,
  margin: 0,
  overflowWrap: 'anywhere',
} as const;

const linkStyle = {
  ...typographyTokens.bodySm,
  fontWeight: 600,
  color: colorTokens.textPrimary,
} as const;
