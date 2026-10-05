import Link from 'next/link';
import {
  Card,
  CONTROL_CLASS,
  SectionHeader,
  Stack,
  StateMessage,
  StatusBadge,
  colorTokens,
  radiusTokens,
  spacingTokens,
  typographyTokens,
  type BadgeTone,
  buttonClass,
} from '@brandspace/ui';
import type { MessageKey } from '../../../i18n/messages';
import { MoreDisclosure } from '../../../components/more-disclosure';
import { ChannelMark } from '../calendar/prototype-calendar';

/**
 * Connected accounts and publishing history — Phase 6.
 *
 * A DESIGN-SYSTEM EXTENSION, NOT A DEMO PORT (UI-FIDELITY-CONTRACT §6). The
 * approved demo has no social-connections screen at all — the route is a
 * "Future product preview" placeholder — which is exactly the case §6.1 was
 * written for after the Asset Library. So the screen is composed entirely from
 * what already ships: `Card`, `SectionHeader`, `StateMessage`, `StatusBadge`
 * and the button, colour, spacing and typography tokens, inside the shared
 * dashboard shell. No new colour, no new font, no new shadow, no new
 * interaction model.
 *
 * A SERVER COMPONENT WITH FORMS, and no client JavaScript at all. Every control
 * is a `<form>` posting to a server action, so the screen works with scripting
 * unavailable and every decision is enforced where it must be.
 *
 * EVERY AFFORDANCE IS A SERVER-RESOLVED FLAG. `mayManage`, `canCancel` and
 * `canRetry` say what the server already decided; hiding a button is tidiness,
 * and the action refuses independently. A screen that decided for itself could
 * only ever hide a control that works — never open one that should not.
 *
 * NOTHING HERE CAN RENDER A TOKEN. `ConnectionRow` has no field that could hold
 * one, because `ConnectionView` has none either: the encrypted material lives
 * in a different table that this path never reads.
 */

export interface ConnectionRow {
  readonly id: string;
  readonly provider: string;
  readonly providerLabel: string;
  readonly displayName: string;
  readonly targetKindLabel: string;
  readonly brandName: string;
  readonly status: 'PENDING' | 'ACTIVE' | 'NEEDS_REAUTH' | 'REVOKED' | 'DISABLED';
  readonly connectedAtLabel: string | null;
  readonly lastSyncedAtLabel: string | null;
  readonly tokenExpiresAtLabel: string | null;
  readonly expiringSoon: boolean;
  readonly publishable: boolean;
  readonly consecutiveFailureCount: number;
}

export interface ConnectableProvider {
  readonly provider: string;
  readonly label: string;
  /** Declared capabilities, rendered so the customer knows before connecting. */
  readonly postKinds: readonly string[];
  readonly maxBodyCharacters: number;
}

export interface BrandOption {
  readonly id: string;
  readonly name: string;
}

export interface PublishRow {
  readonly id: string;
  readonly providerLabel: string;
  readonly brandName: string;
  readonly itemTitle: string;
  readonly status:
    | 'PENDING'
    | 'QUEUED'
    | 'PUBLISHING'
    | 'VERIFICATION_PENDING'
    | 'PUBLISHED'
    | 'FAILED'
    | 'CANCELLED';
  readonly scheduledAtLabel: string;
  readonly publishedAtLabel: string | null;
  readonly externalPostUrl: string | null;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly nextAttemptAtLabel: string | null;
  /** A stable code the caller already translated. Never provider prose. */
  readonly failureMessage: string | null;
  readonly needsReconnect: boolean;
  readonly canCancel: boolean;
  readonly canRetry: boolean;
  /** D-332 — why a failed post past its deadline offers no Retry. Translated. */
  readonly lateNotice: string | null;
}

const PUBLISH_TONE: Record<PublishRow['status'], BadgeTone> = {
  PENDING: 'neutral',
  QUEUED: 'info',
  PUBLISHING: 'info',
  VERIFICATION_PENDING: 'warning',
  PUBLISHED: 'success',
  FAILED: 'danger',
  CANCELLED: 'neutral',
};

/* The prototype's pills: `p-ok` connected, `p-bad` expired, `p-neu` otherwise. */
const CONNECTION_PILL: Record<ConnectionRow['status'], string> = {
  PENDING: 'bsp-p-neu',
  ACTIVE: 'bsp-p-ok',
  NEEDS_REAUTH: 'bsp-p-bad',
  REVOKED: 'bsp-p-neu',
  DISABLED: 'bsp-p-bad',
};

const CONNECTION_STATUS_KEY: Record<ConnectionRow['status'], MessageKey> = {
  PENDING: 'integrations.status.pending',
  ACTIVE: 'integrations.status.active',
  NEEDS_REAUTH: 'integrations.status.needsReauth',
  REVOKED: 'integrations.status.revoked',
  DISABLED: 'integrations.status.disabled',
};

const PUBLISH_STATUS_KEY: Record<PublishRow['status'], MessageKey> = {
  PENDING: 'publishing.status.pending',
  QUEUED: 'publishing.status.queued',
  PUBLISHING: 'publishing.status.publishing',
  VERIFICATION_PENDING: 'publishing.status.verifying',
  PUBLISHED: 'publishing.status.published',
  FAILED: 'publishing.status.failed',
  CANCELLED: 'publishing.status.cancelled',
};

/** One page, channel or organization a pending grant offered (D-142). */
export interface PendingTarget {
  readonly externalAccountId: string;
  readonly displayName: string;
  readonly targetKind: string;
}

/** A grant waiting for the customer to say which of their pages they meant. */
export interface PendingSelection {
  readonly selectionToken: string;
  readonly providerLabel: string;
  readonly targets: readonly PendingTarget[];
}

export function IntegrationsView({
  locale,
  t,
  connections,
  connectable,
  brands,
  publishing,
  mayManage,
  mayManagePublishing,
  pendingSelection,
  actions,
}: {
  readonly locale: string;
  readonly t: (key: MessageKey) => string;
  readonly connections: readonly ConnectionRow[];
  readonly connectable: readonly ConnectableProvider[];
  readonly brands: readonly BrandOption[];
  readonly publishing: readonly PublishRow[];
  readonly mayManage: boolean;
  readonly mayManagePublishing: boolean;
  readonly pendingSelection: PendingSelection | null;
  readonly actions: {
    connect(formData: FormData): Promise<void>;
    disconnect(formData: FormData): Promise<void>;
    check(formData: FormData): Promise<void>;
    cancel(formData: FormData): Promise<void>;
    retry(formData: FormData): Promise<void>;
    selectTarget(formData: FormData): Promise<void>;
  };
}) {
  return (
    <Stack>
      {/*
        THE CHOICE, WHEN ONE GRANT OFFERED SEVERAL PAGES (D-142).

        FIRST ON THE PAGE because it is the one thing blocking the customer:
        they have authorized, nothing is connected yet, and until they choose,
        nothing will publish. Rendered only when the server found a live pending
        grant belonging to this person, so there is no empty variant of it.

        NO DEFAULT IS PRE-SELECTED. A radio group with one already chosen is the
        same decision-on-their-behalf this whole step exists to undo; the submit
        cannot fire until they pick one.
      */}
      {pendingSelection ? (
        <Card testId="select-target">
          <SectionHeader
            eyebrow={pendingSelection.providerLabel}
            title={t('integrations.selectTargetTitle')}
            description={t('integrations.selectTargetBody')}
          />
          <form
            action={actions.selectTarget}
            style={connectFormStyle}
            data-testid="select-target-form"
          >
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="selectionToken" value={pendingSelection.selectionToken} />
            <fieldset style={fieldsetStyle}>
              <legend style={metaStyle}>{t('integrations.selectTargetLegend')}</legend>
              {pendingSelection.targets.map((target) => (
                <label key={target.externalAccountId} style={choiceStyle}>
                  <input
                    type="radio"
                    name="externalAccountId"
                    value={target.externalAccountId}
                    required
                  />
                  <span>
                    <span style={titleStyle}>{target.displayName}</span>
                    {target.targetKind ? (
                      <span style={metaStyle}> · {target.targetKind}</span>
                    ) : null}
                  </span>
                </label>
              ))}
            </fieldset>
            <button
              type="submit"
              className={buttonClass('primary')}
              data-testid="select-target-submit"
            >
              {t('integrations.selectTargetSubmit')}
            </button>
          </form>
        </Card>
      ) : null}
      {/*
        ROUND 4, GATE 2b — THE PROTOTYPE'S ACCOUNTS (`Main.dc.html` lines
        1430–1433): one card of rows — the platform's 38px tile with its mark,
        the name over its handle, the status pill and one action. A platform
        with nothing connected is a row with "Connect" (the same connect
        action, for the brand); a connected account keeps the product's
        two-step Disconnect. Moved behind the row's "⋯" (nothing deleted):
        "Check connection" and the connection's dates. Moved behind the
        card's "⋯": the full connect form (another account, another brand)
        and the platforms' declared capabilities.
      */}
      <section className="bsp-card bsp-acc" data-testid="connected-accounts">
        {connections.length === 0 && connectable.length === 0 ? (
          <div className="bsp-row">
            <span className="bsp-acc-text">
              <span className="bsp-acc-name">{t('integrations.emptyTitle')}</span>
              <span className="bsp-acc-sub">{t('integrations.emptyBody')}</span>
            </span>
          </div>
        ) : null}
        <div data-testid="connected-accounts-list">
          {connections.map((row) => (
            <div key={row.id} className="bsp-row bsp-acc-row" data-testid={`connection-${row.id}`}>
              <span className="bsp-acc-ic" aria-hidden="true">
                <ChannelMark
                  channel={{ key: row.provider.toLowerCase(), name: row.providerLabel }}
                  size={18}
                  label={false}
                />
              </span>
              <span className="bsp-acc-text">
                <span className="bsp-acc-name bsp-ltr">{row.displayName}</span>
                <span className="bsp-acc-sub">
                  {row.providerLabel} · {row.targetKindLabel} · {row.brandName}
                </span>
                {/*
                  A WARNING BEFORE IT BREAKS, not after. A token inside its last
                  day still works, so this is a notice rather than an error.
                */}
                {row.expiringSoon ? (
                  <span className="bsp-acc-warn" data-testid={`expiring-${row.id}`}>
                    {t('integrations.expiringSoon')}
                  </span>
                ) : null}
                {row.status === 'NEEDS_REAUTH' ? (
                  <span className="bsp-acc-warn" data-testid={`needs-reauth-${row.id}`}>
                    {t('integrations.needsReauthBody')}
                  </span>
                ) : null}
                {row.consecutiveFailureCount > 0 ? (
                  <span className="bsp-acc-sub" data-testid={`failures-${row.id}`}>
                    {t('integrations.recentFailures')}: {row.consecutiveFailureCount}
                  </span>
                ) : null}
              </span>
              <span className={`bsp-pill ${CONNECTION_PILL[row.status]}`}>
                {t(CONNECTION_STATUS_KEY[row.status])}
              </span>
              <MoreDisclosure
                label={t('integrations.check')}
                testId={`connection-more-${row.id}`}
                align="end"
              >
                <dl className="bsp-acc-facts">
                  <Fact label={t('integrations.connectedAt')} value={row.connectedAtLabel} />
                  <Fact label={t('integrations.lastSynced')} value={row.lastSyncedAtLabel} />
                  <Fact label={t('integrations.tokenExpires')} value={row.tokenExpiresAtLabel} />
                </dl>
                <form action={actions.check}>
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="connectionId" value={row.id} />
                  <button
                    type="submit"
                    className="bsp-btn bsp-sm bsp-sec"
                    data-testid={`check-${row.id}`}
                  >
                    {t('integrations.check')}
                  </button>
                </form>
              </MoreDisclosure>
              {/*
                B-9 — DISCONNECTING IS TWO STEPS (CLAUDE.md §2.5): the first
                click opens the explanation; the second, a separate danger
                button, submits. No client JavaScript.
              */}
              {mayManage ? (
                <details className="bsp-acc-disc">
                  <summary
                    className="bsp-btn bsp-sm bsp-ghost"
                    data-testid={`disconnect-${row.id}`}
                  >
                    {t('integrations.disconnect')}
                  </summary>
                  <form action={actions.disconnect} className="bsp-acc-confirm">
                    <input type="hidden" name="locale" value={locale} />
                    <input type="hidden" name="connectionId" value={row.id} />
                    <input type="hidden" name="intent" value="DISCONNECT" />
                    <span className="bsp-acc-sub">{t('integrations.disconnectConfirmBody')}</span>
                    <button
                      type="submit"
                      className="bsp-btn bsp-sm bsp-acc-danger"
                      data-testid={`disconnect-confirm-${row.id}`}
                    >
                      {t('integrations.disconnectConfirmSubmit')}
                    </button>
                  </form>
                </details>
              ) : null}
            </div>
          ))}
        </div>
        {/* A platform with nothing connected: the prototype's "Not connected" row and "Connect". */}
        {mayManage && brands.length > 0
          ? connectable
              .filter((option) => !connections.some((row) => row.provider === option.provider))
              .map((option) => (
                <form
                  key={option.provider}
                  action={actions.connect}
                  className="bsp-row bsp-acc-row"
                  data-testid={`connect-row-${option.provider}`}
                >
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="provider" value={option.provider} />
                  <span className="bsp-acc-ic" aria-hidden="true">
                    <ChannelMark
                      channel={{ key: option.provider.toLowerCase(), name: option.label }}
                      size={18}
                      label={false}
                    />
                  </span>
                  <span className="bsp-acc-text">
                    <span className="bsp-acc-name bsp-ltr">{option.label}</span>
                    <span className="bsp-acc-sub">{t('integrations.notConnected')}</span>
                  </span>
                  <span className="bsp-pill bsp-p-neu">{t('integrations.notConnected')}</span>
                  {brands.length === 1 ? (
                    <input type="hidden" name="brandId" value={brands[0]?.id ?? ''} />
                  ) : (
                    <select
                      name="brandId"
                      className={`${CONTROL_CLASS} bsp-acc-brand`}
                      aria-label={t('integrations.brand')}
                      required
                    >
                      {brands.map((brand) => (
                        <option key={brand.id} value={brand.id}>
                          {brand.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <button type="submit" className="bsp-btn bsp-sm bsp-pur">
                    {t('integrations.connectShort')}
                  </button>
                </form>
              ))
          : null}
        {/*
          THE CONNECT FORM, BEHIND THE CARD'S "⋯" — any platform, any brand,
          a second account. ABSENT WITHOUT THE PERMISSION, and the action
          refuses independently (D-62/D-130).
        */}
        {mayManage ? (
          <div className="bsp-row bsp-acc-more">
            <MoreDisclosure
              label={t('integrations.connectTitle')}
              testId="connect-more"
              summary={<span>{t('integrations.connectTitle')}</span>}
              summaryClassName="bsp-btn bsp-sm bsp-ghost"
            >
              <div className="bsp-acc-connect" data-testid="connect-account">
                {connectable.length === 0 ? (
                  <span className="bsp-acc-sub">{t('integrations.noProvidersBody')}</span>
                ) : brands.length === 0 ? (
                  <span className="bsp-acc-sub">{t('integrations.noBrandsBody')}</span>
                ) : (
                  <form
                    action={actions.connect}
                    className="bsp-acc-connect-form"
                    data-testid="connect-form"
                  >
                    <input type="hidden" name="locale" value={locale} />
                    <label className="bsp-acc-field">
                      <span className="bsp-lbl">{t('integrations.provider')}</span>
                      <select
                        name="provider"
                        className={CONTROL_CLASS}
                        data-testid="connect-provider"
                        required
                      >
                        {connectable.map((option) => (
                          <option key={option.provider} value={option.provider}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="bsp-acc-field">
                      <span className="bsp-lbl">{t('integrations.brand')}</span>
                      <select
                        name="brandId"
                        className={CONTROL_CLASS}
                        data-testid="connect-brand"
                        required
                      >
                        {brands.map((brand) => (
                          <option key={brand.id} value={brand.id}>
                            {brand.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="submit"
                      className="bsp-btn bsp-sm bsp-pur"
                      data-testid="connect-submit"
                    >
                      {t('integrations.connect')}
                    </button>
                    {/*
                      CAPABILITIES ARE DECLARED, AND THE CUSTOMER SEES THEM
                      BEFORE THEY COMMIT.
                    */}
                    <ul className="bsp-acc-caps" data-testid="provider-capabilities">
                      {connectable.map((option) => (
                        <li key={option.provider}>
                          {option.label}: {option.postKinds.join(', ')} ·{' '}
                          {t('integrations.maxCharacters')} {option.maxBodyCharacters}
                        </li>
                      ))}
                    </ul>
                  </form>
                )}
              </div>
            </MoreDisclosure>
          </div>
        ) : null}
      </section>

      <Card testId="publishing-history">
        <SectionHeader
          eyebrow={t('publishing.eyebrow')}
          title={t('publishing.title')}
          description={t('publishing.body')}
        />
        {publishing.length === 0 ? (
          <StateMessage
            title={t('publishing.emptyTitle')}
            description={t('publishing.emptyBody')}
          />
        ) : (
          <ul style={listStyle} data-testid="publishing-list">
            {publishing.map((row) => (
              <li key={row.id} style={rowStyle} data-testid={`publish-job-${row.id}`}>
                <div style={headerRowStyle}>
                  <span style={titleStyle}>{row.itemTitle}</span>
                  <StatusBadge
                    tone={PUBLISH_TONE[row.status]}
                    label={t(PUBLISH_STATUS_KEY[row.status])}
                  />
                </div>
                <span style={metaStyle}>
                  {row.providerLabel} · {row.brandName} · {row.scheduledAtLabel}
                </span>
                {row.publishedAtLabel ? (
                  <span style={metaStyle}>
                    {t('publishing.publishedAt')} {row.publishedAtLabel}
                  </span>
                ) : null}
                {row.externalPostUrl ? (
                  <Link
                    href={row.externalPostUrl}
                    style={linkStyle}
                    rel="noreferrer noopener"
                    target="_blank"
                    data-testid={`post-link-${row.id}`}
                  >
                    {t('publishing.viewPost')}
                  </Link>
                ) : null}
                {/*
                  THE FAILURE IS OURS AND IT IS TRANSLATED. `failureMessage` was
                  resolved from a stable code by the page; a provider's own
                  words never reach here, because they routinely echo the
                  caption that was rejected.
                */}
                {row.failureMessage ? (
                  <p style={noticeStyle} data-testid={`failure-${row.id}`}>
                    {row.failureMessage}
                  </p>
                ) : null}
                {row.lateNotice ? (
                  <p style={noticeStyle} data-testid={`late-${row.id}`}>
                    {row.lateNotice}
                  </p>
                ) : null}
                {row.needsReconnect ? (
                  <p style={noticeStyle} data-testid={`reconnect-${row.id}`}>
                    {t('publishing.reconnectNeeded')}
                  </p>
                ) : null}
                <span style={metaStyle}>
                  {t('publishing.attempts')}: {row.attemptCount}/{row.maxAttempts}
                  {row.nextAttemptAtLabel
                    ? ` · ${t('publishing.nextAttempt')} ${row.nextAttemptAtLabel}`
                    : ''}
                </span>

                {mayManagePublishing ? (
                  <div style={buttonRowStyle}>
                    {row.canCancel ? (
                      <form action={actions.cancel} style={formStyle}>
                        <input type="hidden" name="locale" value={locale} />
                        <input type="hidden" name="jobId" value={row.id} />
                        <button
                          type="submit"
                          className={buttonClass('neutral')}
                          data-testid={`cancel-${row.id}`}
                        >
                          {t('publishing.cancel')}
                        </button>
                      </form>
                    ) : null}
                    {row.canRetry ? (
                      <form action={actions.retry} style={formStyle}>
                        <input type="hidden" name="locale" value={locale} />
                        <input type="hidden" name="jobId" value={row.id} />
                        <button
                          type="submit"
                          className={buttonClass('neutral')}
                          data-testid={`retry-${row.id}`}
                        >
                          {t('publishing.retry')}
                        </button>
                      </form>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Stack>
  );
}

/** One label/value pair. Omitted entirely when there is nothing to say. */
function Fact({ label, value }: { readonly label: string; readonly value: string | null }) {
  if (!value) return null;
  return (
    <div style={factStyle}>
      <dt style={metaStyle}>{label}</dt>
      <dd style={{ ...typographyTokens.bodySm, margin: 0 }}>{value}</dd>
    </div>
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

const headerRowStyle = {
  display: 'flex',
  gap: spacingTokens.sm,
  alignItems: 'center',
  flexWrap: 'wrap',
} as const;

const titleStyle = { ...typographyTokens.body, fontWeight: 600 } as const;

const metaStyle = { ...typographyTokens.caption, color: colorTokens.textMuted } as const;

/*
 * THE CHOICE LIST. Existing tokens only, composed the way the connect form
 * already composes them — a new screen element, not a new visual language
 * (CLAUDE.md §4.2).
 */
const fieldsetStyle = {
  display: 'grid',
  gap: spacingTokens.sm,
  border: 'none',
  margin: 0,
  padding: 0,
} as const;

const choiceStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: spacingTokens.sm,
  padding: spacingTokens.sm,
  borderRadius: radiusTokens.md,
  border: `1px solid ${colorTokens.border}`,
} as const;

const noticeStyle = {
  ...typographyTokens.bodySm,
  color: colorTokens.textMuted,
  margin: 0,
  overflowWrap: 'anywhere',
} as const;

const factStyle = { display: 'grid', gap: '2px' } as const;

const formStyle = { display: 'grid', gap: spacingTokens.xs } as const;

const connectFormStyle = {
  display: 'grid',
  gap: spacingTokens.sm,
  maxInlineSize: '32rem',
} as const;

// The prototype's form field comes from `.bs-control` (round 4).

/* Round 4 — the row's buttons keep their own 40px; stretched to the tallest
   item (the disconnect disclosure) they were 44px. */
const buttonRowStyle = {
  display: 'flex',
  gap: spacingTokens.xs,
  flexWrap: 'wrap',
  alignItems: 'flex-start',
} as const;

const linkStyle = {
  ...typographyTokens.bodySm,
  fontWeight: 600,
  color: colorTokens.textPrimary,
} as const;
