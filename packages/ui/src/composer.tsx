'use client';

import { useState, type ReactNode } from 'react';
import { colorTokens, radiusTokens, spacingTokens, typographyTokens } from './tokens';
import {
  Button,
  ButtonRow,
  CONTROL_CLASS,
  Field,
  IconTile,
  inputStyle,
  textareaStyle,
} from './primitives';
import { Card } from './surfaces';
import { StatusBadge } from './data';
import { AbstractMedia, Avatar, MediaChip } from './media';
import { AlertIcon, ImageIcon, PaperclipIcon, SparkIcon } from './icons';
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
        <span style={{ color: colorTokens.textMuted, fontWeight: 400 }}>{platformName}</span>
      </span>
    </button>
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
    media: { kind: 'image', alt: mediaAlt, seed: 1, count: 3 },
  };

  return (
    <div
      data-testid={testId ?? 'post-composer'}
      style={{
        display: 'grid',
        gap: spacingTokens.lg,
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(22rem, 100%), 1fr))',
        alignItems: 'start',
      }}
    >
      {/* ----------------------------------------------------- Editor --- */}
      <div style={{ display: 'grid', gap: spacingTokens.lg, minInlineSize: 0 }}>
        <Card
          title={labels.accountsTitle}
          description={labels.accountsHint}
          icon={<ImageIcon size={16} />}
        >
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

          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: spacingTokens.xs,
              marginBlockStart: spacingTokens.md,
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
                  minBlockSize: '2.25rem',
                  paddingInline: spacingTokens.md,
                  borderRadius: radiusTokens.full,
                  border: '1px solid transparent',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  ...typographyTokens.caption,
                  fontWeight: 600,
                  background:
                    option === format ? colorTokens.brandPurple : colorTokens.controlSurface,
                  color: option === format ? colorTokens.brandPurpleInk : colorTokens.textSecondary,
                }}
              >
                {labels.formatNames[option]}
              </button>
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
        </Card>

        <Card title={labels.contentTitle}>
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
        </Card>

        <Card
          title={labels.mediaTitle}
          description={labels.mediaHint}
          icon={<ImageIcon size={16} />}
        >
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
        </Card>

        <Card title={labels.optionsTitle}>
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
        </Card>

        <Card title={labels.scheduleTitle} tone="lavender" elevated={false}>
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
        </Card>
      </div>

      {/* ---------------------------------------------------- Preview --- */}
      <div
        style={{ display: 'grid', gap: spacingTokens.lg, minInlineSize: 0, justifyItems: 'start' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: spacingTokens.sm }}>
          <IconTile icon={<SparkIcon size={16} />} size="sm" />
          <h2 style={{ ...typographyTokens.h2, color: colorTokens.textPrimary }}>
            {labels.previewTitle}
          </h2>
          <StatusBadge label={labels.platformNames[platform]} tone="neutral" />
        </div>
        <SocialPostPreview content={preview} labels={previewLabels} testId="composer-preview" />
        {copilot}
      </div>
    </div>
  );
}
