'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CONTROL_CLASS } from '@brandspace/ui';

/**
 * Brand Brain chat — the approved demo's panel, with a real backend behind it.
 *
 * IT IS NOT A FLOATING WINDOW. The demo puts the chat INSIDE the hero's
 * right-hand column and swaps it with the stats view (`.bb-hero-stats.chat-open`
 * hides one and shows the other). That is why this component renders a bare
 * `.bb-brain-chat` section with no position, no width and no shadow of its own:
 * its parent owns all three. A floating panel was the previous interpretation
 * and it is the thing the fidelity contract exists to prevent.
 *
 * THE LAYOUT RULE THAT MATTERS is unchanged and is inherited from the demo's
 * stylesheet: the panel is a fixed box and only the message list scrolls
 * (`.bb-chat-messages{flex:1;min-height:0;overflow-y:auto}`). A panel that grows
 * when a message is sent pushes its own composer off the screen. The composer is
 * the demo's single-line input, so the box cannot grow at all.
 *
 * AUTO-SCROLL DOES NOT STEAL THE VIEW. It follows new messages only while the
 * reader is already at the bottom. Someone scrolled up reading a citation keeps
 * their place.
 */

export interface ChatCitation {
  readonly kind: 'knowledge' | 'document';
  readonly id: string;
  readonly label: string;
  readonly area?: string;
  readonly version?: number;
  readonly locator?: string | null;
}

export interface ChatMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly body: string | null;
  readonly citations: readonly ChatCitation[];
  readonly insufficientKnowledge: boolean;
  readonly purged?: boolean;
}

export interface ChatSuggestion {
  readonly label: string;
  readonly prompt: string;
}

export interface ChatLabels {
  readonly title: string;
  readonly subtitle: string;
  readonly placeholder: string;
  readonly send: string;
  readonly cancel: string;
  readonly thinking: string;
  readonly empty: string;
  readonly sources: string;
  readonly insufficient: string;
  readonly disclaimer: string;
  readonly retention: string;
  readonly expired: string;
  readonly error: string;
  readonly close: string;
  readonly contextAll: string;
  readonly areaDetails: string;
  readonly attach: string;
  readonly suggestions: readonly ChatSuggestion[];
}

export function BrandChat({
  brandId,
  area,
  areaLabel,
  labels,
  initialMessages,
  canChat,
  canUpload,
  hidden,
  onClose,
  onAttach,
  onAreaDetails,
}: {
  brandId: string;
  area: string | null;
  areaLabel: string | null;
  labels: ChatLabels;
  initialMessages: readonly ChatMessage[];
  canChat: boolean;
  canUpload: boolean;
  /** The parent shows and hides the panel; this keeps it out of the a11y tree. */
  hidden: boolean;
  onClose: () => void;
  onAttach: () => void;
  onAreaDetails: (() => void) | null;
}) {
  const [messages, setMessages] = useState<readonly ChatMessage[]>(initialMessages);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);

  const listRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const atBottomRef = useRef(true);

  /** Track whether the reader is at the bottom BEFORE new content arrives. */
  const onScroll = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const distance = list.scrollHeight - list.scrollTop - list.clientHeight;
    atBottomRef.current = distance < 48;
  }, []);

  useEffect(() => {
    const list = listRef.current;
    // Follow only if they were already at the bottom. Otherwise leave them
    // exactly where they were reading.
    if (list && atBottomRef.current) list.scrollTop = list.scrollHeight;
  }, [messages, busy]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (message.length === 0 || busy || !canChat) return;

      // Generated ONCE per send and reused by a retry, so a request whose
      // response is lost replays instead of billing a second time.
      const idempotencyKey = `chat-${crypto.randomUUID()}`;
      const optimisticId = `local-${idempotencyKey}`;

      setMessages((current) => [
        ...current,
        {
          id: optimisticId,
          role: 'user',
          body: message,
          citations: [],
          insufficientKnowledge: false,
        },
      ]);
      setDraft('');
      setError(null);
      setBusy(true);
      atBottomRef.current = true;

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const response = await fetch('/api/brand-brain/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            brandId,
            message,
            idempotencyKey,
            ...(conversationId ? { conversationId } : {}),
            ...(area ? { area } : {}),
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          // The server answers with a stable code and never an internal message.
          // The screen shows its own copy rather than echoing anything back.
          setError(labels.error);
          return;
        }

        const payload = (await response.json()) as {
          conversationId: string;
          answer: string | null;
          citations: ChatCitation[];
          insufficientKnowledge: boolean;
        };

        setConversationId(payload.conversationId);
        setMessages((current) => [
          ...current,
          {
            id: `assistant-${idempotencyKey}`,
            role: 'assistant',
            body: payload.answer,
            citations: payload.citations ?? [],
            insufficientKnowledge: payload.insufficientKnowledge,
          },
        ]);
      } catch (cause: unknown) {
        // An abort is the user's own choice, not a failure to report.
        if ((cause as { name?: string } | null)?.name !== 'AbortError') setError(labels.error);
      } finally {
        abortRef.current = null;
        setBusy(false);
      }
    },
    [area, brandId, busy, canChat, conversationId, labels.error],
  );

  return (
    <section
      className="bb-brain-chat"
      data-testid="brand-chat"
      aria-label={labels.title}
      aria-hidden={hidden ? 'true' : undefined}
      // The panel is hidden by its parent's CSS, not removed. `inert` keeps a
      // hidden panel's controls out of the tab order, which `display: none`
      // already does — it is here so that a future change to how the parent
      // hides it cannot quietly leave a focusable control behind.
      inert={hidden ? true : undefined}
    >
      <header className="bb-brain-chat-head">
        <div className="bb-brain-chat-brand">
          <i aria-hidden="true">✦</i>
          <span>
            <small>{labels.subtitle}</small>
            <b>{labels.title}</b>
          </span>
        </div>
        <button
          type="button"
          className="bb-chat-close"
          onClick={onClose}
          aria-label={labels.close}
          data-testid="chat-close"
        >
          ×
        </button>
      </header>

      <div className="bb-chat-context-row">
        <span className="bb-chat-context" data-testid="chat-context">
          {areaLabel ?? labels.contextAll}
        </span>
        {onAreaDetails ? (
          <button
            type="button"
            className="bb-chat-area-details"
            onClick={onAreaDetails}
            data-testid="chat-area-details"
          >
            {labels.areaDetails}
          </button>
        ) : null}
      </div>

      {/*
        THE ONLY SCROLLER. `min-height: 0` in the stylesheet is load-bearing:
        without it a flex child refuses to shrink below its content and the whole
        panel stretches instead of the list scrolling.
      */}
      <div
        ref={listRef}
        onScroll={onScroll}
        className="bb-chat-messages"
        data-testid="chat-messages"
        role="log"
        aria-live="polite"
        aria-atomic="false"
      >
        {messages.length === 0 && !busy ? (
          <p className="bb-chat-message brain">{labels.empty}</p>
        ) : null}

        {messages.map((message) => (
          <article
            key={message.id}
            className={message.role === 'user' ? 'bb-chat-message user' : 'bb-chat-message brain'}
            data-testid={`chat-message-${message.role}`}
          >
            {message.purged ? (
              <em>{labels.expired}</em>
            ) : message.insufficientKnowledge ? (
              <span data-testid="chat-insufficient">{labels.insufficient}</span>
            ) : (
              <span style={{ whiteSpace: 'pre-wrap' }}>{message.body}</span>
            )}

            {message.citations.length > 0 ? (
              <footer className="bb-chat-sources" data-testid="chat-citations">
                {message.citations.map((citation) => (
                  <span className="bb-chat-source" key={`${citation.kind}-${citation.id}`}>
                    {citation.label}
                    {citation.version ? ` · v${citation.version}` : ''}
                    {citation.locator ? ` · ${citation.locator}` : ''}
                  </span>
                ))}
              </footer>
            ) : null}
          </article>
        ))}

        {busy ? (
          <p className="bb-chat-message brain typing" data-testid="chat-busy">
            {labels.thinking}
          </p>
        ) : null}

        {error ? (
          <p className="bb-chat-message brain" role="alert" data-testid="chat-error">
            {error}
          </p>
        ) : null}
      </div>

      <div className="bb-chat-suggestions">
        {labels.suggestions.map((suggestion) => (
          <button
            key={suggestion.prompt}
            type="button"
            data-testid={`chat-suggestion-${suggestion.prompt.length}`}
            disabled={!canChat || busy}
            onClick={() => void send(suggestion.prompt)}
          >
            {suggestion.label}
          </button>
        ))}
      </div>

      <form
        className="bb-chat-compose"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) {
            cancel();
            return;
          }
          void send(draft);
        }}
      >
        <button
          type="button"
          className="bb-chat-attach"
          onClick={onAttach}
          disabled={!canUpload}
          aria-label={labels.attach}
          data-testid="chat-attach"
        >
          +
        </button>
        <input
          className={`${CONTROL_CLASS} bb-chat-input`}
          type="text"
          autoComplete="off"
          data-testid="chat-input"
          value={draft}
          disabled={!canChat}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={labels.placeholder}
          aria-label={labels.placeholder}
        />
        <button
          type="submit"
          className="bb-chat-send"
          data-testid={busy ? 'chat-cancel' : 'chat-send'}
          disabled={!canChat || (!busy && draft.trim().length === 0)}
          aria-label={busy ? labels.cancel : labels.send}
        >
          {busy ? '×' : '↑'}
        </button>
      </form>

      <small className="bb-chat-disclaimer">
        {labels.disclaimer} {labels.retention}
      </small>
    </section>
  );
}
