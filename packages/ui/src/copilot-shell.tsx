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
import { AlertIcon, CloseIcon, PaperclipIcon, SendIcon, SparkIcon } from './icons';
import { Button, buttonStyle, textareaStyle } from './primitives';
import { Banner, Skeleton } from './feedback';
import { useOverlayBehaviour } from './overlays';

/**
 * The AI Copilot's VISUAL SHELL. No provider, no generation, no credits spent.
 *
 * THIS COMPONENT CANNOT TALK TO A MODEL, and that is deliberate rather than
 * unfinished. It renders a conversation, a prompt field, suggested actions, an
 * attachment area and — the part that matters — an approval region. Everything
 * it displays is supplied by the caller.
 *
 * THE APPROVAL RULE, which the real phase must not soften: CLAUDE.md §2.5 says
 * the Copilot may PROPOSE and PREVIEW a high-impact action but must never
 * execute one silently. So a proposed action renders as a description plus an
 * explicit confirm/reject pair, and this shell offers no code path that
 * performs anything. When the AI phase wires a provider in, the confirmation is
 * already the only door.
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

export interface CopilotProposedAction {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** Marked when the action would change tenant state — always confirmable. */
  readonly mutating: boolean;
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
}

function bubbleStyle(author: CopilotMessage['author']): CSSProperties {
  const assistant = author === 'assistant';
  return {
    maxInlineSize: '90%',
    justifySelf: assistant ? 'start' : 'end',
    padding: spacingTokens.sm,
    paddingInline: spacingTokens.md,
    borderRadius: radiusTokens.lg,
    background: assistant ? colorTokens.surfaceMuted : colorTokens.brandPurpleTint,
    border: `1px solid ${assistant ? colorTokens.cardBorder : colorTokens.brandPurpleBorder}`,
    color: colorTokens.textPrimary,
    ...typographyTokens.bodySm,
    overflowWrap: 'anywhere',
  };
}

/** The panel's inner content. Shared by the desktop aside and the mobile sheet. */
export function CopilotBody({
  labels,
  state,
  messages,
  suggestions = [],
  attachments = [],
  proposedAction,
  onApprove,
  onReject,
  disabled = false,
}: {
  readonly labels: CopilotLabels;
  readonly state: CopilotState;
  readonly messages: readonly CopilotMessage[];
  readonly suggestions?: readonly string[];
  readonly attachments?: readonly string[];
  readonly proposedAction?: CopilotProposedAction | undefined;
  readonly onApprove?: (() => void) | undefined;
  readonly onReject?: (() => void) | undefined;
  /** True until a real provider exists: the composer is inert and says so. */
  readonly disabled?: boolean;
}) {
  const promptId = useId();

  return (
    <div
      style={{ display: 'grid', gridTemplateRows: '1fr auto', minBlockSize: 0, blockSize: '100%' }}
    >
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
          gap: spacingTokens.sm,
          alignContent: 'start',
        }}
      >
        {messages.map((message) => (
          <div
            key={message.id}
            data-testid={`copilot-message-${message.author}`}
            style={bubbleStyle(message.author)}
          >
            {message.text}
          </div>
        ))}

        {state === 'streaming' ? (
          <div
            data-testid="copilot-streaming"
            style={{ ...bubbleStyle('assistant'), display: 'grid', gap: spacingTokens.xs }}
          >
            <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
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
          THE APPROVAL REGION. A proposed action is described and then GATED.
          There is no "apply" that runs without this, and a mutating action
          additionally states, in words, that it will change data.
        */}
        {proposedAction ? (
          <section
            data-testid="copilot-approval"
            aria-label={labels.approvalTitle}
            style={{
              border: `1px solid ${colorTokens.brandPurpleBorder}`,
              borderRadius: radiusTokens.md,
              background: colorTokens.surface,
              padding: spacingTokens.md,
              display: 'grid',
              gap: spacingTokens.sm,
            }}
          >
            <span style={{ ...typographyTokens.label, color: colorTokens.textPrimary }}>
              {proposedAction.title}
            </span>
            <span style={{ ...typographyTokens.bodySm, color: colorTokens.textSecondary }}>
              {proposedAction.description}
            </span>
            {proposedAction.mutating ? (
              <span
                data-testid="copilot-mutating-warning"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: spacingTokens.xs,
                  ...typographyTokens.caption,
                  color: colorTokens.warning,
                  fontWeight: 600,
                }}
              >
                <AlertIcon size={14} />
                {labels.mutatingWarning}
              </span>
            ) : null}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: spacingTokens.sm }}>
              <Button variant="secondary" size="sm" onClick={onReject} data-testid="copilot-reject">
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
          borderBlockStart: `1px solid ${colorTokens.cardBorder}`,
          padding: spacingTokens.md,
          display: 'grid',
          gap: spacingTokens.sm,
          background: colorTokens.surface,
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
                key={suggestion}
                type="button"
                disabled={disabled}
                style={{
                  ...buttonStyle('secondary', 'sm'),
                  borderRadius: radiusTokens.full,
                  fontWeight: 500,
                  color: disabled ? colorTokens.textMuted : colorTokens.textPrimary,
                  cursor: disabled ? 'not-allowed' : 'pointer',
                }}
              >
                {suggestion}
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
                  background: colorTokens.surfaceMuted,
                  border: `1px solid ${colorTokens.border}`,
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
        <textarea
          id={promptId}
          data-testid="copilot-prompt"
          rows={3}
          disabled={disabled}
          placeholder={labels.promptPlaceholder}
          aria-describedby={disabled ? `${promptId}-notice` : undefined}
          style={{
            ...textareaStyle(),
            background: disabled ? colorTokens.surfaceMuted : colorTokens.surface,
            color: disabled ? colorTokens.textMuted : colorTokens.textPrimary,
          }}
        />
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
        <div style={{ display: 'flex', gap: spacingTokens.sm, justifyContent: 'flex-end' }}>
          <Button
            variant="secondary"
            size="sm"
            disabled={disabled}
            icon={<PaperclipIcon size={16} />}
          >
            {labels.attach}
          </Button>
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
    </div>
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
          borderInlineStart: `1px solid ${colorTokens.cardBorder}`,
          boxShadow: shadowTokens.overlay,
        }}
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: spacingTokens.sm,
            padding: spacingTokens.md,
            borderBlockEnd: `1px solid ${colorTokens.cardBorder}`,
          }}
        >
          <span style={{ display: 'inline-flex', color: colorTokens.brandPurple }}>
            <SparkIcon size={20} />
          </span>
          <span style={{ display: 'grid', minInlineSize: 0 }}>
            <span style={{ ...typographyTokens.h3, color: colorTokens.textPrimary }}>
              {labels.title}
            </span>
            <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
              {labels.subtitle}
            </span>
          </span>
          <button
            type="button"
            aria-label={labels.close}
            data-testid="copilot-close"
            onClick={onClose}
            style={{
              marginInlineStart: 'auto',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              inlineSize: '2.25rem',
              blockSize: '2.25rem',
              borderRadius: radiusTokens.md,
              border: `1px solid ${colorTokens.borderStrong}`,
              background: colorTokens.surface,
              color: colorTokens.textPrimary,
              cursor: 'pointer',
            }}
          >
            <CloseIcon size={18} />
          </button>
        </header>
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
      style={{ ...buttonStyle('secondary', 'sm'), gap: spacingTokens.xs }}
    >
      <span style={{ display: 'inline-flex', color: colorTokens.brandPurple }}>
        <SparkIcon size={16} />
      </span>
      {label}
    </button>
  );
}
