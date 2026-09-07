'use client';

import { useCallback, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  colorTokens,
  layoutTokens,
  radiusTokens,
  shadowTokens,
  spacingTokens,
  typographyTokens,
  zIndexTokens,
} from './tokens';
import { AlertIcon, CheckIcon, CloseIcon, PaperclipIcon, SendIcon, SparkIcon } from './icons';
import { Button, CONTROL_CLASS, IconButton, textareaStyle } from './primitives';
import { Banner, Skeleton } from './feedback';
import { useOverlayBehaviour } from './overlays';
import { Avatar } from './media';
import type { CopilotSurface } from './copilot-types';

/**
 * The AI Copilot's VISUAL SHELL. No provider, no generation, no credits spent.
 *
 * THIS COMPONENT CANNOT TALK TO A MODEL, and that is deliberate rather than
 * unfinished. It renders a conversation, a prompt field, suggested actions, an
 * attachment area, the tool cards describing what a run would do and — the part
 * that matters — an approval region. Everything it displays is supplied by the
 * caller.
 *
 * THE APPROVAL RULE, which the real phase must not soften: CLAUDE.md §2.5 says
 * the Copilot may PROPOSE and PREVIEW a high-impact action but must never
 * execute one silently. So a proposed action renders as a description, a
 * before/after preview of exactly what would change, and an explicit
 * confirm/reject pair — and this shell offers no code path that performs
 * anything. When the AI phase wires a provider in, the confirmation is already
 * the only door.
 *
 * WHY IT IS CONTEXTUAL rather than a floating chat window: the Copilot is only
 * useful when it knows what the person is looking at. `CopilotContext` names the
 * surface (a calendar week, a selected post, the composer's draft, a design) and
 * the header states it, so a suggestion like "suggest a posting time" is
 * visibly about something rather than a generic prompt starter.
 *
 * In production navigation this stays behind the existing feature-flag and
 * entitlement mechanism until that phase; it appears here and in the isolated
 * design showcase for visual review only.
 */

export type CopilotState = 'idle' | 'streaming' | 'error' | 'insufficient-credits' | 'approval';

export interface CopilotMessage {
  readonly id: string;
  readonly author: 'user' | 'assistant';
  readonly text: string;
}

/** A suggested action chip. The id is stable; the label is a translated string. */
export interface CopilotSuggestion {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
}

/**
 * A TOOL CARD: what the assistant did, or would do, expressed as an operation
 * rather than as prose in a chat bubble.
 */
export interface CopilotToolRun {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly status: 'running' | 'done' | 'failed';
}

/** One field a proposed action would change, shown before it is applied. */
export interface CopilotChangePreview {
  readonly label: string;
  readonly before?: string | undefined;
  readonly after: string;
}

export interface CopilotProposedAction {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** Marked when the action would change tenant state — always confirmable. */
  readonly mutating: boolean;
  /** Exactly what would change. Rendered before the confirm/reject pair. */
  readonly preview?: readonly CopilotChangePreview[];
}

/**
 * The credit indication.
 *
 * OPTIONAL ON PURPOSE. §2.2 forbids inventing allowances, so a surface that
 * cannot read a real balance passes nothing and no number is shown, rather than
 * a plausible-looking placeholder.
 */
export interface CopilotCredits {
  readonly label: string;
  readonly value: string;
}

export interface CopilotContext {
  readonly surface: CopilotSurface;
  /** What the Copilot is currently attached to, e.g. a post title or a week. */
  readonly subject: string;
}

export interface CopilotLabels {
  readonly title: string;
  readonly subtitle: string;
  readonly open: string;
  readonly close: string;
  readonly promptLabel: string;
  readonly promptPlaceholder: string;
  readonly send: string;
  readonly attach: string;
  readonly attachmentsLabel: string;
  readonly suggestionsLabel: string;
  readonly conversationLabel: string;
  readonly streaming: string;
  readonly errorTitle: string;
  readonly errorBody: string;
  readonly insufficientCreditsTitle: string;
  readonly insufficientCreditsBody: string;
  readonly approvalTitle: string;
  readonly approvalBody: string;
  readonly approve: string;
  readonly reject: string;
  readonly mutatingWarning: string;
  readonly disabledNotice: string;
  /** Names the surface the Copilot is attached to, e.g. "Content calendar". */
  readonly surfaceNames: Record<CopilotSurface, string>;
  readonly contextLabel: string;
  readonly toolsLabel: string;
  readonly previewTitle: string;
  readonly beforeLabel: string;
  readonly afterLabel: string;
  readonly assistantName: string;
  readonly userName: string;
}

/* ------------------------------------------------------------------ */
/* Message bubbles                                                     */
/* ------------------------------------------------------------------ */

/**
 * Author distinction WITHOUT an outline.
 *
 * The assistant speaks from a lavender surface aligned to the start with a
 * brand avatar; the person speaks from a neutral surface aligned to the end.
 * Side, fill and avatar carry the distinction together, so it survives both a
 * greyscale render and 1.4.1 (colour is never the only signal).
 */
function bubbleStyle(author: CopilotMessage['author']): CSSProperties {
  const assistant = author === 'assistant';
  return {
    maxInlineSize: '100%',
    padding: spacingTokens.sm,
    paddingInline: spacingTokens.md,
    borderRadius: radiusTokens.lg,
    borderStartStartRadius: assistant ? radiusTokens.xs : radiusTokens.lg,
    borderStartEndRadius: assistant ? radiusTokens.lg : radiusTokens.xs,
    background: assistant ? colorTokens.surfaceLavender : colorTokens.surfaceMuted,
    color: colorTokens.textPrimary,
    ...typographyTokens.bodySm,
    overflowWrap: 'anywhere',
  };
}

function MessageRow({
  message,
  labels,
}: {
  readonly message: CopilotMessage;
  readonly labels: CopilotLabels;
}) {
  const assistant = message.author === 'assistant';
  return (
    <div
      data-testid={`copilot-message-${message.author}`}
      style={{
        display: 'grid',
        gridTemplateColumns: 'auto minmax(0, 1fr)',
        gap: spacingTokens.sm,
        justifyItems: 'start',
        justifyContent: assistant ? 'start' : 'end',
        maxInlineSize: '92%',
        justifySelf: assistant ? 'start' : 'end',
        direction: assistant ? undefined : 'inherit',
      }}
    >
      {assistant ? (
        <span
          aria-hidden="true"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            inlineSize: '1.75rem',
            blockSize: '1.75rem',
            borderRadius: radiusTokens.full,
            background: colorTokens.brandPurple,
            color: colorTokens.brandPurpleInk,
            flexShrink: 0,
          }}
        >
          <SparkIcon size={14} />
        </span>
      ) : (
        <span aria-hidden="true" style={{ gridColumn: 1, flexShrink: 0 }}>
          <Avatar initials={labels.userName.slice(0, 2)} size="1.75rem" seed={3} />
        </span>
      )}
      <div style={{ display: 'grid', gap: spacingTokens['3xs'], minInlineSize: 0 }}>
        <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
          {assistant ? labels.assistantName : labels.userName}
        </span>
        <div style={bubbleStyle(message.author)}>{message.text}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tool cards                                                          */
/* ------------------------------------------------------------------ */

function toolStatusVisual(status: CopilotToolRun['status']): {
  readonly icon: ReactNode;
  readonly color: string;
  readonly tint: string;
} {
  if (status === 'failed') {
    return {
      icon: <AlertIcon size={14} />,
      color: colorTokens.danger,
      tint: colorTokens.dangerTint,
    };
  }
  if (status === 'running') {
    return {
      icon: <SparkIcon size={14} />,
      color: colorTokens.brandPurple,
      tint: colorTokens.brandPurpleTint,
    };
  }
  return {
    icon: <CheckIcon size={14} />,
    color: colorTokens.success,
    tint: colorTokens.successTint,
  };
}

function ToolCard({ run }: { readonly run: CopilotToolRun }) {
  const visual = toolStatusVisual(run.status);
  return (
    <div
      data-testid="copilot-tool-card"
      data-status={run.status}
      style={{
        display: 'grid',
        gridTemplateColumns: 'auto minmax(0, 1fr)',
        gap: spacingTokens.sm,
        alignItems: 'start',
        padding: spacingTokens.sm,
        paddingInline: spacingTokens.md,
        borderRadius: radiusTokens.lg,
        background: colorTokens.surfaceSoft,
        boxShadow: shadowTokens.card,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          inlineSize: '1.75rem',
          blockSize: '1.75rem',
          borderRadius: radiusTokens.md,
          background: visual.tint,
          color: visual.color,
        }}
      >
        {visual.icon}
      </span>
      <span style={{ display: 'grid', gap: spacingTokens['3xs'], minInlineSize: 0 }}>
        <span style={{ ...typographyTokens.label, color: colorTokens.textPrimary }}>
          {run.title}
        </span>
        <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
          {run.detail}
        </span>
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Change preview                                                      */
/* ------------------------------------------------------------------ */

/**
 * The PREVIEW of a proposed change.
 *
 * A person approving an action needs to see the actual text that would replace
 * the actual text they have, not a summary of it. Before is struck through in
 * a muted surface, after is on the brand tint — and both are labelled in words,
 * because strike-through alone is a visual-only signal.
 */
function ChangePreview({
  changes,
  labels,
}: {
  readonly changes: readonly CopilotChangePreview[];
  readonly labels: CopilotLabels;
}) {
  return (
    <div data-testid="copilot-change-preview" style={{ display: 'grid', gap: spacingTokens.sm }}>
      <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
        {labels.previewTitle}
      </span>
      {changes.map((change) => (
        <div key={change.label} style={{ display: 'grid', gap: spacingTokens['3xs'] }}>
          <span style={{ ...typographyTokens.label, color: colorTokens.textPrimary }}>
            {change.label}
          </span>
          {change.before === undefined ? null : (
            <span
              style={{
                ...typographyTokens.bodySm,
                color: colorTokens.textMuted,
                background: colorTokens.surfaceMuted,
                borderRadius: radiusTokens.md,
                padding: spacingTokens.xs,
                paddingInline: spacingTokens.sm,
                overflowWrap: 'anywhere',
              }}
            >
              <span style={{ ...typographyTokens.caption, display: 'block' }}>
                {labels.beforeLabel}
              </span>
              <s>{change.before}</s>
            </span>
          )}
          <span
            style={{
              ...typographyTokens.bodySm,
              color: colorTokens.textPrimary,
              background: colorTokens.brandPurpleTint,
              borderRadius: radiusTokens.md,
              padding: spacingTokens.xs,
              paddingInline: spacingTokens.sm,
              overflowWrap: 'anywhere',
            }}
          >
            <span
              style={{
                ...typographyTokens.caption,
                display: 'block',
                color: colorTokens.brandPurplePressed,
              }}
            >
              {labels.afterLabel}
            </span>
            {change.after}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Body                                                                */
/* ------------------------------------------------------------------ */

/** The panel's inner content. Shared by the desktop aside and the mobile sheet. */
export function CopilotBody({
  labels,
  state,
  messages,
  suggestions = [],
  attachments = [],
  tools = [],
  context,
  credits,
  proposedAction,
  onApprove,
  onReject,
  disabled = false,
}: {
  readonly labels: CopilotLabels;
  readonly state: CopilotState;
  readonly messages: readonly CopilotMessage[];
  readonly suggestions?: readonly CopilotSuggestion[];
  readonly attachments?: readonly string[];
  readonly tools?: readonly CopilotToolRun[];
  readonly context?: CopilotContext | undefined;
  /** Omitted where no real balance can be read. Nothing is invented. */
  readonly credits?: CopilotCredits | undefined;
  readonly proposedAction?: CopilotProposedAction | undefined;
  readonly onApprove?: (() => void) | undefined;
  readonly onReject?: (() => void) | undefined;
  /** True until a real provider exists: the composer is inert and says so. */
  readonly disabled?: boolean;
}) {
  const promptId = useId();

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateRows: context ? 'auto 1fr auto' : '1fr auto',
        minBlockSize: 0,
        blockSize: '100%',
        background: colorTokens.surface,
      }}
    >
      {/*
        THE CONTEXT STRIP. The Copilot states what it is attached to, so its
        suggestions read as being about something rather than as prompt starters.
      */}
      {context ? (
        <div
          data-testid="copilot-context"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: spacingTokens.xs,
            flexWrap: 'wrap',
            padding: spacingTokens.sm,
            paddingInline: spacingTokens.md,
            background: colorTokens.surfaceLavender,
          }}
        >
          <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
            {labels.contextLabel}
          </span>
          <span
            style={{
              ...typographyTokens.caption,
              fontWeight: 600,
              color: colorTokens.brandPurplePressed,
              background: colorTokens.surface,
              borderRadius: radiusTokens.full,
              paddingInline: spacingTokens.sm,
              paddingBlock: spacingTokens['3xs'],
            }}
          >
            {labels.surfaceNames[context.surface]}
          </span>
          <span
            style={{
              ...typographyTokens.caption,
              color: colorTokens.textPrimary,
              minInlineSize: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {context.subject}
          </span>
          {credits ? (
            <span
              data-testid="copilot-credits"
              style={{
                marginInlineStart: 'auto',
                ...typographyTokens.caption,
                color: colorTokens.textSecondary,
              }}
            >
              {credits.label}{' '}
              <strong style={{ color: colorTokens.textPrimary }}>{credits.value}</strong>
            </span>
          ) : null}
        </div>
      ) : null}

      <div
        data-testid="copilot-conversation"
        role="log"
        aria-label={labels.conversationLabel}
        aria-live="polite"
        // A region that scrolls with a mouse must also scroll with a keyboard,
        // or its content is unreachable without a pointer (WCAG 2.1.1). axe
        // flags this as `scrollable-region-focusable`, and it did.
        tabIndex={0}
        style={{
          overflowY: 'auto',
          padding: spacingTokens.md,
          display: 'grid',
          gap: spacingTokens.md,
          alignContent: 'start',
        }}
      >
        {messages.map((message) => (
          <MessageRow key={message.id} message={message} labels={labels} />
        ))}

        {tools.length > 0 ? (
          <section
            aria-label={labels.toolsLabel}
            data-testid="copilot-tools"
            style={{ display: 'grid', gap: spacingTokens.xs }}
          >
            {tools.map((run) => (
              <ToolCard key={run.id} run={run} />
            ))}
          </section>
        ) : null}

        {state === 'streaming' ? (
          <div
            data-testid="copilot-streaming"
            style={{ ...bubbleStyle('assistant'), display: 'grid', gap: spacingTokens.xs }}
          >
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: spacingTokens.xs,
                ...typographyTokens.caption,
                color: colorTokens.brandPurplePressed,
                fontWeight: 600,
              }}
            >
              <span className="bs-pulse" aria-hidden="true" style={{ display: 'inline-flex' }}>
                <SparkIcon size={14} />
              </span>
              {labels.streaming}
            </span>
            <Skeleton width="100%" />
            <Skeleton width="70%" />
          </div>
        ) : null}

        {state === 'error' ? (
          <div data-testid="copilot-error">
            <Banner tone="error" testId="copilot-error-banner">
              <strong>{labels.errorTitle}</strong>
              <span style={{ display: 'block' }}>{labels.errorBody}</span>
            </Banner>
          </div>
        ) : null}

        {state === 'insufficient-credits' ? (
          <div data-testid="copilot-insufficient-credits">
            <Banner tone="warning" testId="copilot-credits-banner">
              <strong>{labels.insufficientCreditsTitle}</strong>
              <span style={{ display: 'block' }}>{labels.insufficientCreditsBody}</span>
            </Banner>
          </div>
        ) : null}

        {/*
          THE APPROVAL REGION. A proposed action is described, PREVIEWED and
          then GATED. There is no "apply" that runs without this, and a mutating
          action additionally states, in words, that it will change data.
        */}
        {proposedAction ? (
          <section
            data-testid="copilot-approval"
            aria-label={labels.approvalTitle}
            style={{
              borderRadius: radiusTokens.xl,
              background: colorTokens.surface,
              boxShadow: shadowTokens.raised,
              padding: spacingTokens.md,
              display: 'grid',
              gap: spacingTokens.sm,
            }}
          >
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: spacingTokens.xs,
                ...typographyTokens.caption,
                fontWeight: 600,
                color: colorTokens.brandPurplePressed,
              }}
            >
              <SparkIcon size={14} />
              {labels.approvalTitle}
            </span>
            <span style={{ ...typographyTokens.label, color: colorTokens.textPrimary }}>
              {proposedAction.title}
            </span>
            <span style={{ ...typographyTokens.bodySm, color: colorTokens.textSecondary }}>
              {proposedAction.description}
            </span>

            {proposedAction.preview && proposedAction.preview.length > 0 ? (
              <ChangePreview changes={proposedAction.preview} labels={labels} />
            ) : null}

            {proposedAction.mutating ? (
              <span
                data-testid="copilot-mutating-warning"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: spacingTokens.xs,
                  ...typographyTokens.caption,
                  color: colorTokens.warning,
                  background: colorTokens.warningTint,
                  borderRadius: radiusTokens.md,
                  padding: spacingTokens.xs,
                  paddingInline: spacingTokens.sm,
                  fontWeight: 600,
                }}
              >
                <AlertIcon size={14} />
                {labels.mutatingWarning}
              </span>
            ) : null}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: spacingTokens.sm }}>
              <Button variant="neutral" size="sm" onClick={onReject} data-testid="copilot-reject">
                {labels.reject}
              </Button>
              <Button variant="primary" size="sm" onClick={onApprove} data-testid="copilot-approve">
                {labels.approve}
              </Button>
            </div>
          </section>
        ) : null}
      </div>

      <div
        style={{
          padding: spacingTokens.md,
          display: 'grid',
          gap: spacingTokens.sm,
          background: colorTokens.surfaceSoft,
        }}
      >
        {suggestions.length > 0 ? (
          <div
            role="group"
            aria-label={labels.suggestionsLabel}
            data-testid="copilot-suggestions"
            style={{ display: 'flex', flexWrap: 'wrap', gap: spacingTokens.xs }}
          >
            {suggestions.map((suggestion) => (
              <button
                key={suggestion.id}
                type="button"
                disabled={disabled}
                className="bs-pressable"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: spacingTokens.xs,
                  minBlockSize: layoutTokens.controlHeightSm,
                  paddingInline: spacingTokens.sm,
                  borderRadius: radiusTokens.full,
                  border: 'none',
                  background: colorTokens.surfaceLavender,
                  color: disabled ? colorTokens.textMuted : colorTokens.brandPurplePressed,
                  ...typographyTokens.caption,
                  fontWeight: 600,
                  cursor: disabled ? 'not-allowed' : 'pointer',
                }}
              >
                {suggestion.icon ? (
                  <span aria-hidden="true" style={{ display: 'inline-flex' }}>
                    {suggestion.icon}
                  </span>
                ) : null}
                {suggestion.label}
              </button>
            ))}
          </div>
        ) : null}

        {attachments.length > 0 ? (
          <ul
            aria-label={labels.attachmentsLabel}
            data-testid="copilot-attachments"
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'flex',
              flexWrap: 'wrap',
              gap: spacingTokens.xs,
            }}
          >
            {attachments.map((attachment) => (
              <li
                key={attachment}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: spacingTokens.xs,
                  paddingInline: spacingTokens.sm,
                  paddingBlock: spacingTokens['3xs'],
                  borderRadius: radiusTokens.full,
                  background: colorTokens.surface,
                  ...typographyTokens.caption,
                  color: colorTokens.textSecondary,
                }}
              >
                <PaperclipIcon size={14} />
                {attachment}
              </li>
            ))}
          </ul>
        ) : null}

        <label
          htmlFor={promptId}
          style={{ ...typographyTokens.label, color: colorTokens.textPrimary }}
        >
          {labels.promptLabel}
        </label>
        <div
          style={{
            display: 'grid',
            gap: spacingTokens.xs,
            borderRadius: radiusTokens.lg,
            background: colorTokens.surface,
            padding: spacingTokens.xs,
            boxShadow: shadowTokens.card,
          }}
        >
          <textarea
            id={promptId}
            data-testid="copilot-prompt"
            rows={3}
            disabled={disabled}
            placeholder={labels.promptPlaceholder}
            aria-describedby={disabled ? `${promptId}-notice` : undefined}
            className={CONTROL_CLASS}
            style={{
              ...textareaStyle(),
              background: 'transparent',
              boxShadow: 'none',
              color: disabled ? colorTokens.textMuted : colorTokens.textPrimary,
            }}
          />
          <div
            style={{
              display: 'flex',
              gap: spacingTokens.xs,
              alignItems: 'center',
              justifyContent: 'flex-end',
            }}
          >
            <IconButton
              label={labels.attach}
              variant="ghost"
              size="sm"
              circular
              disabled={disabled}
              icon={<PaperclipIcon size={16} />}
            />
            <Button
              variant="primary"
              size="sm"
              disabled={disabled}
              icon={<SendIcon size={16} />}
              data-testid="copilot-send"
            >
              {labels.send}
            </Button>
          </div>
        </div>
        {/*
          The composer is INERT and says why. A prompt box that looks live but
          does nothing is precisely the "button that claims an unsupported
          action" this phase must not ship.
        */}
        {disabled ? (
          <p
            id={`${promptId}-notice`}
            data-testid="copilot-disabled-notice"
            style={{ margin: 0, ...typographyTokens.caption, color: colorTokens.textSecondary }}
          >
            {labels.disabledNotice}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

/**
 * The Copilot's header. Premium, and the ONE place the soft purple glow the
 * brief permits outside the hero is used.
 */
export function CopilotHeader({
  labels,
  onClose,
}: {
  readonly labels: CopilotLabels;
  readonly onClose?: (() => void) | undefined;
}) {
  return (
    <header
      data-testid="copilot-header"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: spacingTokens.sm,
        padding: spacingTokens.md,
        background: `radial-gradient(120% 140% at 100% 0%, ${colorTokens.surfaceLavenderStrong} 0%, ${colorTokens.surface} 70%)`,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          inlineSize: '2.25rem',
          blockSize: '2.25rem',
          borderRadius: radiusTokens.lg,
          background: colorTokens.brandPurple,
          color: colorTokens.brandPurpleInk,
          boxShadow: shadowTokens.brandGlow,
        }}
      >
        <SparkIcon size={18} />
      </span>
      <span style={{ display: 'grid', minInlineSize: 0 }}>
        <span style={{ ...typographyTokens.h3, color: colorTokens.textPrimary }}>
          {labels.title}
        </span>
        <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
          {labels.subtitle}
        </span>
      </span>
      {onClose ? (
        <span style={{ marginInlineStart: 'auto' }}>
          <IconButton
            label={labels.close}
            variant="ghost"
            circular
            onClick={onClose}
            icon={<CloseIcon size={18} />}
            data-testid="copilot-close"
          />
        </span>
      ) : null}
    </header>
  );
}

/**
 * The Copilot as a docked panel on desktop and a full-height sheet on mobile.
 *
 * ONE COMPONENT, two presentations, driven by the same CSS breakpoint the shell
 * uses — so the panel cannot end up docked on a phone. The mobile sheet is a
 * real modal: focus trapped, Escape closes, focus restored to the trigger.
 */
export function CopilotPanel({
  open,
  onClose,
  labels,
  children,
  testId,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly labels: CopilotLabels;
  readonly children: ReactNode;
  readonly testId?: string | undefined;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Only the mobile sheet traps focus. On desktop the panel sits beside the
  // page and must NOT trap: it is a region, not a modal.
  const [isSheet, setIsSheet] = useState(false);

  const measure = useCallback((node: HTMLDivElement | null) => {
    panelRef.current = node;
    if (node) setIsSheet(window.matchMedia('(max-width: 767px)').matches);
  }, []);

  useOverlayBehaviour({ open: open && isSheet, onClose, containerRef: panelRef });

  if (!open) return null;

  return (
    <>
      <div
        className="bs-copilot-scrim"
        data-testid="copilot-scrim"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: zIndexTokens.overlay,
          background: 'rgba(15, 23, 42, 0.45)',
        }}
      />
      <aside
        ref={measure}
        className="bs-copilot-panel"
        role={isSheet ? 'dialog' : 'complementary'}
        aria-modal={isSheet ? true : undefined}
        aria-label={labels.title}
        data-testid={testId ?? 'copilot-panel'}
        tabIndex={-1}
        style={{
          position: 'fixed',
          insetBlock: 0,
          insetInlineEnd: 0,
          zIndex: zIndexTokens.dialog,
          inlineSize: `min(${layoutTokens.copilotPanelWidth}, 100vw)`,
          display: 'grid',
          gridTemplateRows: 'auto 1fr',
          background: colorTokens.surface,
          boxShadow: shadowTokens.overlay,
        }}
      >
        <CopilotHeader labels={labels} onClose={onClose} />
        <div style={{ minBlockSize: 0 }}>{children}</div>
      </aside>
    </>
  );
}

/** The launcher. Hidden in production navigation until the AI phase ships. */
export function CopilotLauncher({
  label,
  onOpen,
  expanded,
}: {
  readonly label: string;
  readonly onOpen: () => void;
  readonly expanded: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-expanded={expanded}
      data-testid="copilot-launcher"
      className="bs-pressable"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: spacingTokens.xs,
        minBlockSize: layoutTokens.controlHeightSm,
        paddingInline: spacingTokens.md,
        borderRadius: radiusTokens.full,
        border: 'none',
        background: colorTokens.brandPurpleTint,
        color: colorTokens.brandPurplePressed,
        ...typographyTokens.label,
        cursor: 'pointer',
      }}
    >
      <span style={{ display: 'inline-flex' }} aria-hidden="true">
        <SparkIcon size={16} />
      </span>
      {label}
    </button>
  );
}
