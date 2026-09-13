'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Brand Brain chat.
 *
 * THE LAYOUT RULES ARE THE FEATURE HERE, and they are all one idea: the panel
 * is a FIXED BOX and only the message list scrolls.
 *
 *   - The panel has a fixed height. It does not grow when a message is sent,
 *     which is the failure the brief calls out by name: a panel that grows
 *     pushes its own composer off the screen, and the longer the conversation
 *     the harder it is to type.
 *   - The message list is the only scroller (`min-height: 0` on the flex child,
 *     without which a flex item refuses to shrink below its content and the
 *     whole panel stretches instead).
 *   - The composer is a grid row of its own, so it cannot be pushed anywhere.
 *   - The textarea grows to a CEILING and then scrolls internally.
 *
 * AUTO-SCROLL DOES NOT STEAL THE VIEW. It follows new messages only while the
 * reader is already at the bottom. Someone scrolled up reading a citation keeps
 * their place — jumping them to the end is the behaviour that makes a chat
 * panel unusable while an answer streams in.
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
}

const MAX_COMPOSER_HEIGHT = 120;

export function BrandChat({
  brandId,
  area,
  labels,
  initialMessages,
  canChat,
  onClose,
}: {
  brandId: string;
  area: string | null;
  labels: ChatLabels;
  initialMessages: readonly ChatMessage[];
  canChat: boolean;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<readonly ChatMessage[]>(initialMessages);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);

  const listRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
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

  /** Grow the composer to a ceiling, then let it scroll internally. */
  const resizeComposer = useCallback(() => {
    const node = composerRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(MAX_COMPOSER_HEIGHT, node.scrollHeight)}px`;
    node.style.overflowY = node.scrollHeight > MAX_COMPOSER_HEIGHT ? 'auto' : 'hidden';
  }, []);

  useEffect(() => {
    resizeComposer();
  }, [draft, resizeComposer]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  const send = useCallback(async () => {
    const message = draft.trim();
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
  }, [area, brandId, busy, canChat, conversationId, draft, labels.error]);

  return (
    <section
      data-testid="brand-chat"
      aria-label={labels.title}
      style={{
        display: 'grid',
        // THE FIXED BOX. Three rows: header, scrolling list, composer.
        gridTemplateRows: 'auto minmax(0, 1fr) auto',
        height: 'clamp(360px, 60vh, 560px)',
        borderRadius: '22px',
        background: 'rgba(255,255,255,.94)',
        boxShadow: '0 24px 70px rgba(22,16,39,.16)',
        overflow: 'hidden',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: '14px 16px',
          borderBottom: '1px solid rgba(17,17,20,.08)',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 36,
            height: 36,
            borderRadius: 12,
            background: '#7935FE',
            color: '#fff',
            display: 'grid',
            placeItems: 'center',
            fontWeight: 800,
          }}
        >
          ✦
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <b style={{ display: 'block', fontSize: '0.8rem' }}>{labels.title}</b>
          <small style={{ color: '#6D6D76', fontSize: '0.65rem' }}>{labels.subtitle}</small>
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={labels.close}
          style={{
            border: 0,
            borderRadius: 10,
            width: 32,
            height: 32,
            background: '#F1F1F4',
            cursor: 'pointer',
            font: 'inherit',
          }}
        >
          ×
        </button>
      </header>

      {/*
        THE ONLY SCROLLER. `minHeight: 0` is load-bearing: without it a flex or
        grid child refuses to shrink below its content, and the panel stretches
        instead of the list scrolling.
      */}
      <div
        ref={listRef}
        onScroll={onScroll}
        data-testid="chat-messages"
        role="log"
        aria-live="polite"
        aria-atomic="false"
        style={{
          minHeight: 0,
          overflowY: 'auto',
          overscrollBehavior: 'contain',
          padding: '14px 16px',
          display: 'grid',
          gap: '10px',
          alignContent: 'start',
        }}
      >
        {messages.length === 0 && !busy ? (
          <p style={{ margin: 0, color: '#6D6D76', fontSize: '0.75rem' }}>{labels.empty}</p>
        ) : null}

        {messages.map((message) => (
          <article
            key={message.id}
            data-testid={`chat-message-${message.role}`}
            style={{
              justifySelf: message.role === 'user' ? 'end' : 'start',
              maxWidth: '86%',
              padding: '10px 12px',
              borderRadius: 14,
              background: message.role === 'user' ? '#111114' : '#F5F2FF',
              color: message.role === 'user' ? '#fff' : '#111114',
              fontSize: '0.75rem',
              lineHeight: 1.55,
            }}
          >
            {message.purged ? (
              <em style={{ color: '#6D6D76' }}>{labels.expired}</em>
            ) : message.insufficientKnowledge ? (
              <span data-testid="chat-insufficient">{labels.insufficient}</span>
            ) : (
              <span style={{ whiteSpace: 'pre-wrap' }}>{message.body}</span>
            )}

            {message.citations.length > 0 ? (
              <footer
                data-testid="chat-citations"
                style={{ marginTop: 8, fontSize: '0.65rem', color: '#4A4A52' }}
              >
                <b style={{ display: 'block', marginBottom: 4 }}>{labels.sources}</b>
                <ul style={{ margin: 0, paddingInlineStart: '1rem' }}>
                  {message.citations.map((citation) => (
                    <li key={`${citation.kind}-${citation.id}`}>
                      {citation.label}
                      {citation.version ? ` · v${citation.version}` : ''}
                      {citation.locator ? ` · ${citation.locator}` : ''}
                    </li>
                  ))}
                </ul>
              </footer>
            ) : null}
          </article>
        ))}

        {busy ? (
          <p data-testid="chat-busy" style={{ margin: 0, color: '#6D6D76', fontSize: '0.72rem' }}>
            {labels.thinking}
          </p>
        ) : null}

        {error ? (
          <p
            role="alert"
            data-testid="chat-error"
            style={{ margin: 0, color: '#A3282F', fontSize: '0.72rem' }}
          >
            {error}
          </p>
        ) : null}
      </div>

      <footer
        style={{
          borderTop: '1px solid rgba(17,17,20,.08)',
          padding: '10px 12px',
          display: 'grid',
          gap: '8px',
        }}
      >
        <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
          <textarea
            ref={composerRef}
            data-testid="chat-input"
            value={draft}
            disabled={!canChat}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends; Shift+Enter is a newline. A multi-line composer
              // that cannot produce a newline is worse than a single-line one.
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder={labels.placeholder}
            aria-label={labels.placeholder}
            style={{
              flex: 1,
              minWidth: 0,
              resize: 'none',
              maxHeight: `${MAX_COMPOSER_HEIGHT}px`,
              padding: '9px 11px',
              borderRadius: 12,
              border: '1px solid rgba(17,17,20,.14)',
              font: 'inherit',
              fontSize: '0.75rem',
              lineHeight: 1.5,
            }}
          />
          <button
            type="button"
            data-testid={busy ? 'chat-cancel' : 'chat-send'}
            onClick={busy ? cancel : () => void send()}
            disabled={!canChat || (!busy && draft.trim().length === 0)}
            style={{
              border: 0,
              borderRadius: 12,
              height: 38,
              padding: '0 14px',
              background: busy ? '#F1F1F4' : '#7935FE',
              color: busy ? '#111114' : '#fff',
              fontWeight: 700,
              fontSize: '0.72rem',
              cursor: canChat ? 'pointer' : 'not-allowed',
              font: 'inherit',
            }}
          >
            {busy ? labels.cancel : labels.send}
          </button>
        </div>
        <p style={{ margin: 0, color: '#6D6D76', fontSize: '0.6rem', lineHeight: 1.5 }}>
          {labels.disclaimer} {labels.retention}
        </p>
      </footer>
    </section>
  );
}
