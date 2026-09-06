'use client';

import { useState, type ReactNode } from 'react';
import {
  colorTokens,
  layoutTokens,
  radiusTokens,
  shadowTokens,
  spacingTokens,
  typographyTokens,
} from './tokens';
import { Button, ButtonRow, CONTROL_CLASS, Field, inputStyle, textareaStyle } from './primitives';
import { Card } from './surfaces';
import { AbstractMedia, Avatar, MediaChip } from './media';
import { AlertIcon, PaperclipIcon } from './icons';
import { SocialPostPreview } from './social-post-preview';
import {
  PLATFORM_FORMATS,
  defaultFormat,
  resolveAspect,
  type PostAspect,
  type SocialFormat,
  type SocialPlatform,
  type SocialPostPreviewContent,
  type SocialPostPreviewLabels,
} from './social-post-types';

/**
 * The Create Post composer.
 *
 * THREE COLUMNS ON DESKTOP: the editor, a live preview of the selected
 * platform, and a contextual Copilot the caller slots in. On a phone they
 * become one column in that order, because a preview beside a 390px editor
 * leaves room for neither.
 *
 * ORGANISED BY SURFACE, NOT BY BOXES. Related controls are grouped by heading
 * and spacing on soft surfaces; nothing here is a collection of outlined form
 * rectangles, which is the shape the brief rejected.
 *
 * PROTOTYPE BOUNDARY. Nothing publishes. The publish and schedule controls are
 * present because a composer without them cannot be judged, and they are
 * explicitly marked as a prototype by the surface that hosts them. There is no
 * platform API, no OAuth, no upload and no draft persistence.
 */

export interface ComposerAccount {
  readonly id: string;
  readonly name: string;
  readonly handle: string;
  readonly platform: SocialPlatform;
  readonly initials: string;
  readonly avatarSeed?: 0 | 1 | 2 | 3 | 4 | 5;
}

export interface ComposerLabels {
  readonly accountsTitle: string;
  readonly accountsHint: string;
  readonly contentTitle: string;
  readonly captionLabel: string;
  readonly captionPlaceholder: string;
  readonly characterCount: (used: number, limit: number) => string;
  readonly overLimit: string;
  readonly hashtagsLabel: string;
  readonly hashtagsHint: string;
  readonly mentionsLabel: string;
  readonly mediaTitle: string;
  readonly mediaHint: string;
  readonly addMedia: string;
  readonly reorderHint: string;
  readonly carouselLabel: string;
  readonly aspectLabel: string;
  readonly optionsTitle: string;
  readonly firstCommentLabel: string;
  readonly firstCommentHint: string;
  readonly locationLabel: string;
  readonly campaignLabel: string;
  readonly approvalLabel: string;
  readonly scheduleTitle: string;
  readonly publishNow: string;
  readonly schedule: string;
  readonly saveDraft: string;
  readonly previewTitle: string;
  readonly unsupportedTitle: string;
  readonly unsupportedBody: string;
  readonly prototypeNotice: string;
  readonly formatNames: Record<SocialFormat, string>;
  readonly platformNames: Record<SocialPlatform, string>;
}

/** Per-platform caption limits. Approximate, and labelled as guidance. */
const CAPTION_LIMIT: Record<SocialPlatform, number> = {
  instagram: 2200,
  facebook: 5000,
  linkedin: 3000,
  x: 280,
  tiktok: 2200,
};

/** A selectable connected account. A filled chip, never an outlined checkbox row. */
function AccountChip({
  account,
  selected,
  onToggle,
  platformName,
}: {
  readonly account: ComposerAccount;
  readonly selected: boolean;
  readonly onToggle: () => void;
  readonly platformName: string;
}) {
  return (
    <button
      type="button"
      className="bs-pressable"
      data-testid={`composer-account-${account.id}`}
      aria-pressed={selected}
      onClick={onToggle}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: spacingTokens.sm,
        paddingInline: spacingTokens.sm,
        paddingBlock: spacingTokens.xs,
        borderRadius: radiusTokens.full,
        cursor: 'pointer',
        fontFamily: 'inherit',
        background: selected ? colorTokens.surfaceLavenderStrong : colorTokens.controlSurface,
        // Selection is a filled lavender chip plus `aria-pressed`, never a tick
        // box with an outline.
        border: `1px solid ${selected ? colorTokens.brandPurpleBorder : 'transparent'}`,
        color: selected ? colorTokens.brandPurplePressed : colorTokens.textSecondary,
        ...typographyTokens.caption,
        fontWeight: 600,
      }}
    >
      <Avatar initials={account.initials} seed={account.avatarSeed ?? 0} size="1.5rem" />
      <span style={{ display: 'grid', textAlign: 'start' }}>
        <span>{account.name}</span>
        {/*
          `textSecondary`, not `textMuted`. Muted is 4.61:1 on WHITE, which is
          the only ground it was measured against — on this chip's lavender fill
          it drops to 4.21:1 and fails AA. A muted token is only muted enough
          for the surface it was measured on.
        */}
        <span style={{ color: colorTokens.textSecondary, fontWeight: 400 }}>{platformName}</span>
      </span>
    </button>
  );
}

/**
 * A GROUP INSIDE THE EDITOR CARD, not a card of its own.
 *
 * The demo's composer editor is ONE surface (`.composer > .surface-card`) with
 * `.field` groups stacked inside it — `label { margin-bottom: 7px; font-size:
 * 9px; font-weight: 800 }`. Five separate cards made the editor four times
 * taller than the preview beside it and turned a single form into a stack of
 * boxes, which is the surface balance §0 rules out.
 */
function EditorSection({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <section style={{ display: 'grid', gap: spacingTokens.sm, minInlineSize: 0 }}>
      <div style={{ display: 'grid', gap: spacingTokens['3xs'] }}>
        <h3
          style={{
            margin: 0,
            ...typographyTokens.caption,
            fontWeight: 800,
            color: colorTokens.textPrimary,
          }}
        >
          {title}
        </h3>
        {description ? (
          <p style={{ margin: 0, ...typographyTokens.micro, color: colorTokens.textMuted }}>
            {description}
          </p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

export function PostComposer({
  accounts,
  labels,
  previewLabels,
  campaigns,
  approvers,
  initialCaption,
  captionDirection = 'ltr',
  scheduledLabel,
  mediaAlt,
  mediaSeed = 1,
  copilot,
  testId,
}: {
  readonly accounts: readonly ComposerAccount[];
  readonly labels: ComposerLabels;
  readonly previewLabels: SocialPostPreviewLabels;
  readonly campaigns: readonly { readonly id: string; readonly name: string }[];
  readonly approvers: readonly { readonly id: string; readonly name: string }[];
  /**
   * The caption the editor opens with. A PROP, not a literal in the component:
   * every user-facing string in this package is supplied by the caller so it
   * can be translated (CLAUDE.md §4).
   */
  readonly initialCaption: string;
  /** Caption direction, which follows the CONTENT and not the interface locale. */
  readonly captionDirection?: 'rtl' | 'ltr';
  /** How the chosen schedule reads, already formatted by the caller's locale. */
  readonly scheduledLabel: string;
  /** Alternative text for the preview's artwork. */
  readonly mediaAlt: string;
  /**
   * Which artwork the preview shows.
   *
   * Supplied by the caller so that opening a post in the composer shows THAT
   * post's artwork. Without it the link from the calendar is only half real:
   * the caption changes and the picture does not, which is exactly the
   * "decorative prototype element" §9 rules out.
   */
  readonly mediaSeed?: 0 | 1 | 2 | 3 | 4 | 5;
  /** The contextual Copilot panel. Optional so the composer stands alone. */
  readonly copilot?: ReactNode;
  readonly testId?: string | undefined;
}) {
  const [selectedAccounts, setSelectedAccounts] = useState<readonly string[]>(
    accounts[0] ? [accounts[0].id] : [],
  );
  const [caption, setCaption] = useState(initialCaption);
  const [format, setFormat] = useState<SocialFormat>('feed');
  // The aspect follows the format: a Story is 9:16 whatever was chosen before,
  // so the composer resolves rather than storing a value it would override.
  const aspect: PostAspect = '4:5';

  const active = accounts.find((a) => a.id === selectedAccounts[0]) ?? accounts[0];
  const platform: SocialPlatform = active?.platform ?? 'instagram';
  const limit = CAPTION_LIMIT[platform];
  const over = caption.length > limit;

  // A format the selected platform does not offer is a real state a composer
  // must show rather than silently correct.
  const supported = PLATFORM_FORMATS[platform].includes(format);

  const preview: SocialPostPreviewContent = {
    platform,
    format: supported ? format : defaultFormat(platform),
    aspect: resolveAspect(platform, supported ? format : defaultFormat(platform), aspect),
    status: 'DRAFT',
    approval: 'NEEDS_APPROVAL',
    account: {
      displayName: active?.name ?? '',
      handle: active?.handle ?? '',
      initials: active?.initials ?? '',
      avatarSeed: active?.avatarSeed ?? 0,
    },
    caption,
    captionDirection,
    hashtags: ['brandspace', 'socialmedia', 'contentstrategy'],
    scheduledLabel,
    media: { kind: 'image', alt: mediaAlt, seed: mediaSeed, count: 3 },
  };

  return (
    /*
      `.composer { display:grid; grid-template-columns: minmax(350px,1fr) 340px
       300px; gap:12px; align-items:start }` — THREE columns: editor, live
      preview, Copilot. The auto-fit two-column grid that stood here nested the
      Copilot under the preview, which is not the demo's composition. The
      breakpoints (1200 / 900 / 640) live in `.bs-composer`.
    */
    <div
      className="bs-composer"
      data-testid={testId ?? 'post-composer'}
      style={{ display: 'grid', gap: spacingTokens.sm, alignItems: 'start' }}
    >
      {/* ----------------------------------------------------- Editor --- */}
      <div style={{ display: 'grid', gap: spacingTokens.lg, minInlineSize: 0 }}>
        <Card testId="composer-editor">
          {/* One surface, its groups separated by space rather than by boxes. */}
          <div style={{ display: 'grid', gap: spacingTokens.xl, minInlineSize: 0 }}>
            <EditorSection title={labels.accountsTitle} description={labels.accountsHint}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: spacingTokens.xs }}>
                {accounts.map((account) => (
                  <AccountChip
                    key={account.id}
                    account={account}
                    platformName={labels.platformNames[account.platform]}
                    selected={selectedAccounts.includes(account.id)}
                    onToggle={() =>
                      setSelectedAccounts((current) =>
                        current.includes(account.id)
                          ? current.filter((id) => id !== account.id)
                          : [...current, account.id],
                      )
                    }
                  />
                ))}
              </div>

              {!supported ? (
                <p
                  data-testid="composer-unsupported"
                  style={{
                    display: 'flex',
                    gap: spacingTokens.xs,
                    alignItems: 'flex-start',
                    marginBlockStart: spacingTokens.md,
                    marginBlockEnd: 0,
                    padding: spacingTokens.sm,
                    borderRadius: radiusTokens.md,
                    background: colorTokens.warningTint,
                    color: colorTokens.warning,
                    ...typographyTokens.caption,
                    fontWeight: 600,
                  }}
                >
                  <AlertIcon size={14} />
                  <span>
                    <strong>{labels.unsupportedTitle}</strong> {labels.unsupportedBody}
                  </span>
                </p>
              ) : null}
            </EditorSection>

            <EditorSection title={labels.contentTitle}>
              <Field
                label={labels.captionLabel}
                htmlFor="composer-caption"
                hint={labels.characterCount(caption.length, limit)}
                error={over ? labels.overLimit : undefined}
              >
                <textarea
                  id="composer-caption"
                  className={CONTROL_CLASS}
                  value={caption}
                  onChange={(event) => setCaption(event.target.value)}
                  placeholder={labels.captionPlaceholder}
                  style={textareaStyle(over ? { tone: 'error' } : {})}
                />
              </Field>

              <Field
                label={labels.hashtagsLabel}
                htmlFor="composer-hashtags"
                hint={labels.hashtagsHint}
              >
                <input
                  id="composer-hashtags"
                  className={CONTROL_CLASS}
                  defaultValue="#brandspace #socialmedia #contentstrategy"
                  style={inputStyle()}
                />
              </Field>

              <Field label={labels.mentionsLabel} htmlFor="composer-mentions">
                <input
                  id="composer-mentions"
                  className={CONTROL_CLASS}
                  defaultValue="@brandspace.hq"
                  style={inputStyle()}
                />
              </Field>
            </EditorSection>

            <EditorSection title={labels.mediaTitle} description={labels.mediaHint}>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(6rem, 1fr))',
                  gap: spacingTokens.sm,
                }}
              >
                {[1, 2, 4].map((seed, index) => (
                  <div
                    key={seed}
                    data-testid={`composer-media-${index}`}
                    style={{
                      position: 'relative',
                      aspectRatio: '1 / 1',
                      borderRadius: radiusTokens.md,
                      overflow: 'hidden',
                    }}
                  >
                    <AbstractMedia seed={seed as 1 | 2 | 4} alt={`Media ${index + 1}`} />
                    <MediaChip placement="start-start">{index + 1}</MediaChip>
                  </div>
                ))}
                {/* The upload well: a soft dashed target is correct HERE, because
                this is genuinely a drop zone rather than a decorative box. */}
                <button
                  type="button"
                  data-testid="composer-add-media"
                  style={{
                    aspectRatio: '1 / 1',
                    borderRadius: radiusTokens.md,
                    border: `1px dashed ${colorTokens.brandPurpleBorder}`,
                    background: colorTokens.surfaceLavender,
                    color: colorTokens.brandPurplePressed,
                    cursor: 'pointer',
                    display: 'grid',
                    placeItems: 'center',
                    gap: spacingTokens['3xs'],
                    fontFamily: 'inherit',
                    ...typographyTokens.caption,
                    fontWeight: 600,
                  }}
                >
                  <PaperclipIcon size={20} />
                  {labels.addMedia}
                </button>
              </div>
              <p
                style={{
                  margin: 0,
                  marginBlockStart: spacingTokens.sm,
                  ...typographyTokens.caption,
                  color: colorTokens.textMuted,
                }}
              >
                {labels.reorderHint} · {labels.carouselLabel}
              </p>
            </EditorSection>

            <EditorSection title={labels.optionsTitle}>
              <Field
                label={labels.firstCommentLabel}
                htmlFor="composer-first-comment"
                hint={labels.firstCommentHint}
              >
                <input id="composer-first-comment" className={CONTROL_CLASS} style={inputStyle()} />
              </Field>
              <Field label={labels.locationLabel} htmlFor="composer-location">
                <input
                  id="composer-location"
                  className={CONTROL_CLASS}
                  defaultValue="Riyadh"
                  style={inputStyle()}
                />
              </Field>
              <Field label={labels.campaignLabel} htmlFor="composer-campaign">
                <select id="composer-campaign" className={CONTROL_CLASS} style={inputStyle()}>
                  {campaigns.map((campaign) => (
                    <option key={campaign.id} value={campaign.id}>
                      {campaign.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={labels.approvalLabel} htmlFor="composer-approver">
                <select id="composer-approver" className={CONTROL_CLASS} style={inputStyle()}>
                  {approvers.map((approver) => (
                    <option key={approver.id} value={approver.id}>
                      {approver.name}
                    </option>
                  ))}
                </select>
              </Field>
            </EditorSection>

            <EditorSection title={labels.scheduleTitle}>
              <ButtonRow>
                <Button variant="primary" data-testid="composer-publish">
                  {labels.publishNow}
                </Button>
                <Button variant="neutral" data-testid="composer-schedule">
                  {labels.schedule}
                </Button>
                <Button variant="ghost" data-testid="composer-draft">
                  {labels.saveDraft}
                </Button>
              </ButtonRow>
              <p
                data-testid="composer-prototype-notice"
                style={{
                  display: 'flex',
                  gap: spacingTokens.xs,
                  alignItems: 'center',
                  margin: 0,
                  marginBlockStart: spacingTokens.md,
                  ...typographyTokens.caption,
                  color: colorTokens.textSecondary,
                }}
              >
                <AlertIcon size={14} />
                {labels.prototypeNotice}
              </p>
            </EditorSection>
          </div>
        </Card>
      </div>

      {/* ---------------------------------------------------- Preview --- */}
      <div style={{ display: 'grid', gap: spacingTokens.sm, minInlineSize: 0 }}>
        {/*
          The panel names itself in its own head (`.preview-head`, 10px / 800)
          rather than under a 29px view heading — the preview is a panel inside
          the composer, not a section of the page.
        */}
        <SocialPostPreview
          content={preview}
          labels={previewLabels}
          testId="composer-preview"
          head={
            <>
              <span>{labels.previewTitle}</span>
              {/*
                `.segmented { padding: 4px; border-radius: 13px; background:
                 var(--soft) }` with `button.selected { background: #fff;
                 box-shadow: 0 5px 14px rgba(0,0,0,.05) }`. The demo puts the
                Feed/Story switch in the PREVIEW HEAD, next to what it changes,
                rather than among the publishing options.
              */}
              <span
                style={{
                  display: 'inline-flex',
                  padding: spacingTokens['3xs'],
                  borderRadius: radiusTokens.xl,
                  background: colorTokens.surfaceMuted,
                }}
              >
                {PLATFORM_FORMATS[platform].map((option) => (
                  <button
                    key={option}
                    type="button"
                    className="bs-pressable"
                    data-testid={`composer-format-${option}`}
                    aria-pressed={option === format}
                    onClick={() => setFormat(option)}
                    style={{
                      minBlockSize: layoutTokens.controlHeightXs,
                      paddingInline: '0.6875rem',
                      borderRadius: radiusTokens.md,
                      border: '1px solid transparent',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      ...typographyTokens.caption,
                      fontWeight: 750,
                      background: option === format ? colorTokens.surface : 'transparent',
                      boxShadow: option === format ? shadowTokens.raised : 'none',
                      color: colorTokens.textPrimary,
                    }}
                  >
                    {labels.formatNames[option]}
                  </button>
                ))}
              </span>
            </>
          }
        />
      </div>

      {/* ---------------------------------------------------- Copilot --- */}
      <div className="bs-composer-copilot" style={{ minInlineSize: 0 }}>
        {copilot}
      </div>
    </div>
  );
}
