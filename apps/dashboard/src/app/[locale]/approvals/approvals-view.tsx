import type React from 'react';
import Link from 'next/link';
import {
  LinkTabs,
  type LinkTab,
  AssetThumb,
  Card,
  CONTROL_CLASS,
  Field,
  SectionHeader,
  Stack,
  StateMessage,
  StatusBadge,
  buttonStyle,
  colorTokens,
  inputStyle,
  spacingTokens,
  typographyTokens,
  type BadgeTone,
} from '@brandspace/ui';
import type { MessageKey } from '../../../i18n/messages';
import { EmptyAction } from '../../../components/empty-action';

/**
 * The Approvals screen — Phase 5B-3, docs/PRODUCT.md §5 module 14.
 *
 * A DESIGN-SYSTEM EXTENSION, NOT A DEMO PORT (UI-FIDELITY-CONTRACT §6). The
 * approved demo routes `#customer/approvals` to `simpleFeaturePage('approvals')`
 * — a "Future product preview" placeholder with three identical cards and no
 * design behind it, exactly the case §6.1 was written for after the Asset
 * Library. So the screen is composed from what already ships: `Card`,
 * `SectionHeader`, `StateMessage`, `StatusBadge`, `Field` and the button and
 * spacing tokens, inside the shared dashboard shell.
 *
 * EVERY PANEL IS GATED BY A SERVER-RESOLVED FLAG, not by a link being left out.
 * A member who may read content but not approve sees "what you sent" and no
 * verdict controls; one without `approvals.policy.manage` sees no policy
 * editor. The flags say what the server already decided — they never decide
 * anything themselves.
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
  /** Q10 — "Assigned to you" / "Assigned to Sara", or null when nobody is. */
  readonly assignedToLabel: string | null;
  /** B5 — on "Sent": who decided, and the reason they gave. */
  readonly decidedByLabel?: string | null;
  readonly decisionNote?: string | null;
  readonly mayWithdraw: boolean;
  /**
   * Whether to offer the Studio link — a link that refuses the person who
   * follows it is what §20 forbids. Every reader of this screen now holds
   * `content.read` (D-62), so this is true in practice; it stays a prop
   * because the composer's gate is the composer's to state, not this screen's
   * to assume.
   */
  readonly mayOpenInStudio: boolean;
}

/** The narrowest thing a reviewer needs in order to decide. */
export interface ReviewSubjectView {
  readonly approvalId: string;
  readonly itemId: string;
  readonly itemTitle: string;
  readonly brandName: string;
  readonly cycle: number;
  readonly requestNote: string | null;
  readonly requestedByLabel: string;
  readonly mayDecide: boolean;
  /**
   * PHASE 6 FINAL (D-288) — the post as it will look, and the conversation
   * about it, beside the verdict. Rendered by the page (the preview is the
   * composer's own adapter; the conversation is the ordinary Notes panel).
   */
  readonly previews?: React.ReactNode;
  readonly conversation?: React.ReactNode;
  readonly variants: readonly {
    readonly id: string;
    readonly platformKey: string;
    readonly body: string;
    readonly hashtags: readonly string[];
    /**
     * PHASE 8 — THE MEDIA THIS REVIEWER IS APPROVING (AC-29.1).
     *
     * A reviewer who cannot see the picture is approving a caption, not a post.
     * Each carries an expiring, per-viewer preview grant issued by the same
     * download service the Asset Library uses — never a storage key, never a
     * signed url from a column.
     */
    readonly media: readonly {
      readonly id: string;
      readonly name: string;
      readonly kind: string;
      readonly previewToken: string | null;
    }[];
  }[];
}

export interface BrandPolicyRow {
  readonly brandId: string;
  readonly brandName: string;
  readonly requireApprovalBeforeScheduling: boolean;
  readonly allowSelfApproval: boolean;
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
  review,
  tab,
  tabs,
  mayReview,
  mayReadContent,
  mayManagePolicy,
  actions,
}: {
  readonly locale: string;
  readonly t: (key: MessageKey) => string;
  readonly queue: readonly ApprovalRow[];
  readonly mine: readonly ApprovalRow[];
  readonly policies: readonly BrandPolicyRow[];
  readonly review: ReviewSubjectView | null;
  /** B5 — which list is showing, and the two links between them. */
  readonly tab: 'forMe' | 'sent';
  readonly tabs: readonly LinkTab[];
  readonly mayReview: boolean;
  readonly mayReadContent: boolean;
  readonly mayManagePolicy: boolean;
  readonly actions: {
    decide(formData: FormData): Promise<void>;
    withdraw(formData: FormData): Promise<void>;
    savePolicy(formData: FormData): Promise<void>;
  };
}) {
  return (
    <Stack>
      {/*
        THE REVIEW SUBJECT, when one was asked for: the captions under review
        and the requester's note, so a verdict is given on the words rather
        than on a title. It is authorized per approval inside the service, so
        rendering it here discloses nothing the reader could not already
        fetch.
      */}
      {review ? (
        <Card testId="approvals-review-subject">
          <SectionHeader
            eyebrow={`${review.brandName} · ${t('approvals.cycle')} ${review.cycle}`}
            title={review.itemTitle}
            description={`${t('approvals.requestedBy')} ${review.requestedByLabel}`}
          />
          {review.requestNote ? <p style={noteStyle}>{review.requestNote}</p> : null}
          {review.previews ? (
            <div
              data-testid="review-previews"
              style={{
                display: 'grid',
                gap: spacingTokens.md,
                gridTemplateColumns: 'repeat(auto-fit, minmax(min(18rem, 100%), 1fr))',
              }}
            >
              {review.previews}
            </div>
          ) : null}
          <ul style={listStyle} data-testid="review-variants">
            {review.variants.map((variant) => (
              <li key={variant.id} style={rowStyle}>
                <span style={metaStyle}>{variant.platformKey}</span>
                <p style={bodyStyle}>{variant.body}</p>
                {variant.hashtags.length > 0 ? (
                  <span style={metaStyle}>{variant.hashtags.map((h) => `#${h}`).join(' ')}</span>
                ) : null}
                {/*
                  WHAT IS ACTUALLY BEING APPROVED (AC-29.1). The thumbnails are
                  the media the publish pipeline will send — the same asset ids,
                  in the same order — so a reviewer's decision is about the post
                  rather than about its words.
                */}
                {variant.media.length > 0 ? (
                  <ul
                    style={{
                      listStyle: 'none',
                      margin: 0,
                      padding: 0,
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: spacingTokens.xs,
                    }}
                    data-testid={`approval-media-${variant.id}`}
                  >
                    {variant.media.map((item) => (
                      <li key={item.id}>
                        {item.previewToken ? (
                          <AssetThumb
                            src={`/${locale}/assets/file/${item.previewToken}`}
                            alt={item.name}
                            size="3.5rem"
                            testId={`approval-media-thumb-${item.id}`}
                          />
                        ) : (
                          <span style={metaStyle}>{item.name}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
          {review.mayDecide ? (
            <DecisionForm
              locale={locale}
              t={t}
              approvalId={review.approvalId}
              itemId={review.itemId}
              tab={tab}
              action={actions.decide}
            />
          ) : null}
          {review.conversation ?? null}
        </Card>
      ) : null}

      <div>
        <LinkTabs
          label={t('approvals.tabs.label')}
          tabs={tabs}
          currentId={tab}
          testId="approvals-tabs"
        />
      </div>

      {tab === 'forMe' ? (
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
                  {row.assignedToLabel ? (
                    <p style={noteStyle} data-testid={`assigned-to-${row.itemId}`}>
                      {row.assignedToLabel}
                    </p>
                  ) : null}
                  {row.mayDecide ? (
                    <DecisionForm
                      locale={locale}
                      t={t}
                      approvalId={row.id}
                      itemId={row.itemId}
                      tab={tab}
                      action={actions.decide}
                    />
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
      ) : null}

      {/*
        "What you sent" belongs to members who can send. A Viewer has never
        opened a cycle, so the panel is withheld rather than shown empty — and
        the page does not query it for them either.
      */}
      {tab === 'sent' && mayReadContent ? (
        <Card testId="approvals-mine">
          <SectionHeader title={t('approvals.mine')} />
          {mine.length === 0 ? (
            <StateMessage
              title={t('approvals.mineEmptyTitle')}
              description={t('approvals.mineEmptyBody')}
              action={
                <EmptyAction
                  href={`/${locale}/content?status=DRAFT`}
                  label={t('approvals.mineEmptyAction')}
                  testId="approvals-mine-empty-action"
                  tone="neutral"
                />
              }
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
                      <input type="hidden" name="tab" value={tab} />
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
      ) : null}

      {/*
        The policy editor is rendered only for the permission that may change it.
        It can enable self-approval, so it is Owner and Admin only — a role that
        can approve must not also be able to grant itself the right to approve
        its own work.
      */}
      {tab === 'forMe' && mayManagePolicy && policies.length > 0 ? (
        <Card testId="approvals-policy">
          <SectionHeader
            title={t('approvals.policyTitle')}
            description={t('approvals.policyBody')}
          />
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
        {/*
          THE REVIEW CONTEXT, not the content library. The title opens the
          review it belongs to, which is what a reader of this screen wants
          from it; opening the draft for EDITING is a different intent and is
          offered separately, below, as its own link.
        */}
        <Link href={`/${locale}/approvals?review=${row.id}`} style={linkStyle}>
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
      {row.decidedByLabel ? (
        <span style={metaStyle} data-testid={`decided-by-${row.itemId}`}>
          {row.decidedByLabel}
        </span>
      ) : null}
      {row.decisionNote ? (
        <p style={noteStyle} data-testid={`decision-note-${row.itemId}`}>
          {row.decisionNote}
        </p>
      ) : null}
      {row.mayOpenInStudio && row.itemId ? (
        <Link
          href={`/${locale}/content/compose?item=${row.itemId}`}
          style={metaStyle}
          data-testid={`open-in-studio-${row.itemId}`}
        >
          {t('calendar.openInStudio')}
        </Link>
      ) : null}
    </div>
  );
}

/**
 * The three verdicts, in one place.
 *
 * Shared by the queue row and the review-subject panel rather than duplicated,
 * because a second copy is where the two would come to offer different buttons.
 */
function DecisionForm({
  locale,
  t,
  approvalId,
  itemId,
  tab,
  action,
}: {
  readonly locale: string;
  readonly t: (key: MessageKey) => string;
  readonly approvalId: string;
  readonly itemId: string;
  readonly tab: 'forMe' | 'sent';
  readonly action: (formData: FormData) => Promise<void>;
}) {
  /*
   * B5 — THE REASON IS REQUIRED FOR "REQUEST CHANGES", and only for it: the
   * field is `required`, and Approve and Reject skip the browser's validation
   * (`formNoValidate`). The server refuses a blank reason either way.
   */
  return (
    <form action={action} style={formStyle}>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="approvalId" value={approvalId} />
      <input type="hidden" name="tab" value={tab} />
      <Field label={t('approvals.decisionNote')} htmlFor={`note-${approvalId}`}>
        <input
          id={`note-${approvalId}`}
          name="note"
          type="text"
          required
          style={inputStyle()}
          className={CONTROL_CLASS}
          placeholder={t('approvals.notePlaceholder')}
          maxLength={1000}
          data-testid={`decision-note-input-${itemId}`}
        />
      </Field>
      <div style={buttonRowStyle}>
        <button
          type="submit"
          name="verdict"
          value="APPROVE"
          formNoValidate
          style={buttonStyle('primary')}
          data-testid={`approve-${itemId}`}
        >
          {t('approvals.approve')}
        </button>
        <button
          type="submit"
          name="verdict"
          value="REQUEST_CHANGES"
          style={buttonStyle('ghost')}
          data-testid={`request-changes-${itemId}`}
        >
          {t('approvals.requestChanges')}
        </button>
        <button
          type="submit"
          name="verdict"
          value="REJECT"
          formNoValidate
          style={buttonStyle('ghost')}
          data-testid={`reject-${itemId}`}
        >
          {t('approvals.reject')}
        </button>
      </div>
    </form>
  );
}

/**
 * A checkbox, composed rather than created.
 *
 * `Field` renders a text control, and a checkbox is the one shape it does not
 * cover. It uses the same label typography, the same focus treatment and the
 * same spacing tokens as everything else — UI-FIDELITY-CONTRACT §6.2 rule 4
 * asks for a recorded reason when something new appears, and this is it.
 *
 * THE WHOLE ROW IS THE TARGET, and it is at least 24px tall: WCAG 2.2 AA 2.5.8
 * sets a 24×24 minimum and a native checkbox renders at about 13×13. Growing
 * the box alone would fix the number and leave a fiddly target; making the
 * LABEL the target is what the criterion asks for.
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

const bodyStyle = {
  ...typographyTokens.bodySm,
  margin: 0,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
} as const;

const linkStyle = {
  ...typographyTokens.bodySm,
  fontWeight: 600,
  color: colorTokens.textPrimary,
} as const;
