'use client';

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { CONTROL_CLASS } from '@brandspace/ui';
import { translator, type MessageKey } from '../../../i18n/messages';
import { CopilotLink } from '../../../components/copilot-link';
import {
  chatAddFactAction,
  chatEditFactAction,
  chatFindFactsAction,
  chatRemoveFactAction,
  chatUndoRemoveAction,
  type ChatFact,
} from './chat-actions';
import { useMessageLocale } from '../../../i18n/message-locale-context';

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
 *
 * FOUR MODES (D7, Phase 2C-3) — Ask · Add · Edit · Remove — chosen with a
 * radio group in the demo's own chip style (an approved design-system
 * extension, UI-FIDELITY-CONTRACT §6). Only Ask calls a model. Add, Edit and
 * Remove are management through the ordinary knowledge service; their forms
 * live INSIDE the scrolling list, so the panel keeps the demo's geometry.
 * Every successful change refreshes the page, so the area cards, their counts
 * and "answered n of m" update at once.
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
  /** D7 — an answer, a job for the Copilot, or a miss. */
  readonly kind?: 'answer' | 'job' | 'missing';
  /** D7 — the knowledge areas the answer came from (retrieval, not the model). */
  readonly areas?: readonly string[];
  /** D7 — what is missing, when a key question matches. */
  readonly missing?: {
    readonly area: string;
    readonly itemKey: string;
    readonly question: { readonly en?: string; readonly ar?: string };
  } | null;
  /** D7 — for a job: the request, handed to the Copilot as written. */
  readonly request?: string;
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

export type ChatMode = 'ask' | 'add' | 'edit' | 'remove';

/** Where the chat starts: a Copilot or Ask handoff into Add, or "Fix it" into Edit. */
export type ChatStart =
  | {
      readonly mode: 'add';
      readonly area: string | null;
      readonly title: string | null;
      readonly body: string | null;
      readonly itemKey: string | null;
    }
  | { readonly mode: 'edit'; readonly fact: ChatFact | null };

const MODES: readonly ChatMode[] = ['ask', 'add', 'edit', 'remove'];

type Localized = { readonly en?: string | undefined; readonly ar?: string | undefined };

function pick(text: Localized | undefined, locale: string): string {
  if (!text) return '';
  return (locale === 'ar' ? (text.ar ?? text.en) : (text.en ?? text.ar)) ?? '';
}

export function BrandChat({
  locale,
  brandId,
  area,
  areaLabel,
  areas,
  labels,
  initialMessages,
  canChat,
  canUpload,
  modes,
  copilotHref,
  start,
  hidden,
  onClose,
  onAttach,
  onAreaDetails,
}: {
  locale: string;
  brandId: string;
  area: string | null;
  areaLabel: string | null;
  /** Every knowledge area with its label, for Add and for naming answers. */
  areas: readonly { readonly area: string; readonly label: string }[];
  labels: ChatLabels;
  initialMessages: readonly ChatMessage[];
  canChat: boolean;
  canUpload: boolean;
  /** D7 — `brand_brain.edit` (Add, Edit, Remove) and `brand_brain.review` (Add & approve). */
  modes: { readonly edit: boolean; readonly review: boolean };
  /** The Copilot, for "Send to Copilot"; null when the member may not use it. */
  copilotHref: string | null;
  start: ChatStart | null;
  /** The parent shows and hides the panel; this keeps it out of the a11y tree. */
  hidden: boolean;
  onClose: () => void;
  onAttach: () => void;
  onAreaDetails: (() => void) | null;
}) {
  const t = translator(useMessageLocale(locale));
  const router = useRouter();
  const localeKey: 'en' | 'ar' = locale === 'ar' ? 'ar' : 'en';
  const areaName = useCallback(
    (key: string) => areas.find((entry) => entry.area === key)?.label ?? key,
    [areas],
  );
  const available = modes.edit ? MODES : (['ask'] as const);

  const [mode, setMode] = useState<ChatMode>(start && modes.edit ? start.mode : 'ask');
  const [messages, setMessages] = useState<readonly ChatMessage[]>(initialMessages);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);

  // --- Add ------------------------------------------------------------------
  const addStart = start?.mode === 'add' ? start : null;
  const [addArea, setAddArea] = useState<string>(addStart?.area ?? area ?? '');
  const [addTitle, setAddTitle] = useState(addStart?.title ?? '');
  const [addBody, setAddBody] = useState(addStart?.body ?? '');
  const [addKey, setAddKey] = useState<string | null>(addStart?.itemKey ?? null);
  const [addHint, setAddHint] = useState<string | null>(null);

  // --- Edit and Remove --------------------------------------------------------
  const editStart = start?.mode === 'edit' ? start.fact : null;
  const [matches, setMatches] = useState<readonly ChatFact[] | null>(null);
  const [chosen, setChosen] = useState<ChatFact | null>(editStart);
  const [editTitle, setEditTitle] = useState(editStart ? pick(editStart.title, locale) : '');
  const [editBody, setEditBody] = useState(editStart ? pick(editStart.body, locale) : '');
  const [removed, setRemoved] = useState<{ fact: ChatFact; archivedVersion: number } | null>(null);
  const [outcome, setOutcome] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const listRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const atBottomRef = useRef(true);
  const modeRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const panelFocusRef = useRef<HTMLElement | null>(null);

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

  /** A new mode starts clean; focus moves to its first field. */
  const chooseMode = useCallback((next: ChatMode) => {
    setMode(next);
    setOutcome(null);
    setError(null);
    setMatches(null);
    setRemoved(null);
    if (next !== 'edit') setChosen(null);
    setDraft('');
  }, []);

  /*
   * FOCUS STAYS WHERE THE PERSON PUT IT. Choosing a mode — by click or by the
   * radio group's arrow keys — leaves focus on the chosen radio, as a radio
   * group does; Tab then enters the mode's form. Only a chat that OPENS in a
   * mode (a Copilot handoff, "Fix it") moves focus into its form, once.
   */
  const openedInMode = useRef(start !== null && modes.edit);
  useEffect(() => {
    if (hidden || mode === 'ask' || !openedInMode.current) return;
    openedInMode.current = false;
    window.requestAnimationFrame(() => panelFocusRef.current?.focus());
  }, [mode, hidden]);

  /** The radio group's arrow keys, in the reading direction. */
  const onModeKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    const vertical = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (step === 0 && vertical === 0) return;
    event.preventDefault();
    const rtl = document.documentElement.dir === 'rtl';
    const delta = vertical !== 0 ? vertical : rtl ? -step : step;
    const next = available[(index + delta + available.length) % available.length];
    if (!next) return;
    chooseMode(next);
    modeRefs.current[next]?.focus();
  };

  const failureText = useCallback(
    (code: string, field?: string): string => {
      if (code === 'VALIDATION_FAILED') {
        if (field === 'area') return t('bb.chatMode.missingArea');
        if (field === 'title') return t('bb.chatMode.missingTitle');
        if (field === 'body') return t('bb.chatMode.missingBody');
        if (field === 'query') return t('bb.chatMode.missingQuery');
        return t('bb.chatMode.invalid');
      }
      if (code === 'CHANGED') return t('bb.chatMode.changedSince');
      if (code.startsWith('FORBIDDEN')) return t('bb.chatMode.forbidden');
      if (code === 'NOT_FOUND') return t('bb.chatMode.notFound');
      return labels.error;
    },
    [labels.error, t],
  );

  // --- Ask ------------------------------------------------------------------
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
          kind?: 'answer' | 'job' | 'missing';
          areas?: string[];
          missing?: ChatMessage['missing'];
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
            kind: payload.kind ?? 'answer',
            areas: payload.areas ?? [],
            missing: payload.missing ?? null,
            request: message,
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

  /** From a miss in Ask: open Add on the area, answering that question. */
  const addFromMissing = (missing: NonNullable<ChatMessage['missing']>) => {
    chooseMode('add');
    setAddArea(missing.area);
    setAddKey(missing.itemKey);
    setAddTitle(pick(missing.question, locale));
    setAddBody('');
    setAddHint(pick(missing.question, locale));
  };

  // --- Add ------------------------------------------------------------------
  const submitAdd = async (intent: 'approve' | 'review') => {
    if (busy) return;
    setBusy(true);
    setOutcome(null);
    try {
      const result = await chatAddFactAction({
        locale,
        brandId,
        intent,
        area: addArea,
        title: { [localeKey]: addTitle },
        body: { [localeKey]: addBody },
        ...(addKey ? { itemKey: addKey } : {}),
      });
      if (!result.ok) {
        setOutcome({ tone: 'error', text: failureText(result.code, result.field) });
        return;
      }
      setOutcome({
        tone: 'ok',
        text: result.outcome === 'added' ? t('bb.chatMode.added') : t('bb.chatMode.sent'),
      });
      setAddTitle('');
      setAddBody('');
      setAddKey(null);
      setAddHint(null);
      router.refresh();
    } catch {
      setOutcome({ tone: 'error', text: labels.error });
    } finally {
      setBusy(false);
    }
  };

  // --- Edit and Remove: the lookup ------------------------------------------
  const find = async (text: string) => {
    const query = text.trim();
    if (busy) return;
    if (query.length === 0) {
      setOutcome({ tone: 'error', text: t('bb.chatMode.missingQuery') });
      return;
    }
    setBusy(true);
    setOutcome(null);
    setChosen(null);
    setRemoved(null);
    try {
      const result = await chatFindFactsAction({ locale, brandId, query });
      if (!result.ok) {
        setOutcome({ tone: 'error', text: failureText(result.code, result.field) });
        setMatches(null);
        return;
      }
      setMatches(result.facts);
    } catch {
      setOutcome({ tone: 'error', text: labels.error });
    } finally {
      setBusy(false);
    }
  };

  /** The member CHOOSES the fact; nothing is ever edited or removed on a guess. */
  const choose = (fact: ChatFact) => {
    setChosen(fact);
    setEditTitle(pick(fact.title, locale));
    setEditBody(pick(fact.body, locale));
    setOutcome(null);
  };

  // --- Edit -----------------------------------------------------------------
  const saveEdit = async () => {
    if (!chosen || busy) return;
    setBusy(true);
    setOutcome(null);
    try {
      const result = await chatEditFactAction({
        locale,
        itemId: chosen.id,
        expectedVersion: chosen.version,
        // The other language is kept exactly as stored.
        title: { ...chosen.title, [localeKey]: editTitle },
        body: { ...chosen.body, [localeKey]: editBody },
      });
      if (!result.ok) {
        if (result.code === 'CHANGED' && result.fresh) {
          // CHANGED SINCE: nothing was written; show what it says now.
          choose(result.fresh);
        }
        setOutcome({ tone: 'error', text: failureText(result.code, result.field) });
        return;
      }
      if (result.fact) setChosen(result.fact);
      setOutcome({ tone: 'ok', text: t('bb.chatMode.saved') });
      router.refresh();
    } catch {
      setOutcome({ tone: 'error', text: labels.error });
    } finally {
      setBusy(false);
    }
  };

  // --- Remove and Undo ---------------------------------------------------------
  const remove = async () => {
    if (!chosen || busy) return;
    setBusy(true);
    setOutcome(null);
    try {
      const result = await chatRemoveFactAction({ locale, itemId: chosen.id });
      if (!result.ok) {
        setOutcome({ tone: 'error', text: failureText(result.code) });
        return;
      }
      setRemoved({ fact: chosen, archivedVersion: result.archivedVersion });
      setChosen(null);
      setMatches(null);
      router.refresh();
    } catch {
      setOutcome({ tone: 'error', text: labels.error });
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    if (!removed || busy) return;
    setBusy(true);
    setOutcome(null);
    try {
      const result = await chatUndoRemoveAction({
        locale,
        itemId: removed.fact.id,
        archivedVersion: removed.archivedVersion,
      });
      setRemoved(null);
      setOutcome(
        result.ok
          ? { tone: 'ok', text: t('bb.chatMode.restored') }
          : { tone: 'error', text: failureText(result.code) },
      );
      if (result.ok) router.refresh();
    } catch {
      setOutcome({ tone: 'error', text: labels.error });
    } finally {
      setBusy(false);
    }
  };

  const factLine = (fact: ChatFact) => (
    <>
      <b>{pick(fact.title, locale) || fact.itemKey}</b>
      <small>
        {areaName(fact.area)} · v{fact.version}
        {fact.expired ? ` · ${t('bb.expired')}` : ''}
      </small>
    </>
  );

  const composerPlaceholder =
    mode === 'edit'
      ? t('bb.chatMode.findEdit')
      : mode === 'remove'
        ? t('bb.chatMode.findRemove')
        : labels.placeholder;

  return (
    <section
      className="bb-brain-chat"
      data-testid="brand-chat"
      data-mode={mode}
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
        D7 — THE MODES, as a radio group in the suggestions' chip style. A member
        without `brand_brain.edit` has only Ask, so no group is drawn.
      */}
      {available.length > 1 ? (
        <div
          className="bb-chat-modes"
          role="radiogroup"
          aria-label={t('bb.chatMode.label')}
          data-testid="chat-modes"
        >
          {available.map((entry, index) => (
            <button
              key={entry}
              ref={(node) => {
                modeRefs.current[entry] = node;
              }}
              type="button"
              role="radio"
              aria-checked={mode === entry}
              tabIndex={mode === entry ? 0 : -1}
              data-testid={`chat-mode-${entry}`}
              onClick={() => chooseMode(entry)}
              onKeyDown={(event) => onModeKey(event, index)}
            >
              {t(`bb.chatMode.${entry}` as MessageKey)}
            </button>
          ))}
        </div>
      ) : null}

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
        {mode === 'ask' ? (
          <>
            {messages.length === 0 && !busy ? (
              <p className="bb-chat-message brain">{labels.empty}</p>
            ) : null}

            {messages.map((message) => (
              <article
                key={message.id}
                className={
                  message.role === 'user' ? 'bb-chat-message user' : 'bb-chat-message brain'
                }
                data-testid={`chat-message-${message.role}`}
              >
                {message.purged ? (
                  <em>{labels.expired}</em>
                ) : message.insufficientKnowledge ? (
                  <>
                    <span data-testid="chat-insufficient">
                      {message.missing
                        ? t('bb.chatMode.missing')
                            .replace('{question}', pick(message.missing.question, locale))
                            .replace('{area}', areaName(message.missing.area))
                        : labels.insufficient}
                    </span>
                    {message.missing && modes.edit ? (
                      <button
                        type="button"
                        className="bb-chat-link"
                        data-testid="chat-missing-add"
                        onClick={() => message.missing && addFromMissing(message.missing)}
                      >
                        {t('bb.chatMode.addIt')}
                      </button>
                    ) : null}
                  </>
                ) : message.kind === 'job' ? (
                  /*
                   * D7 — A JOB FOR THE COPILOT. Brand Brain does not make posts.
                   * The facts listed are the ones this answer drew on; "Send to
                   * Copilot" opens it with the request written in — nothing runs
                   * and no credit moves until the person sends it there.
                   */
                  <div data-testid="chat-job">
                    <b>{t('bb.chatMode.jobTitle')}</b>
                    <p style={{ margin: '4px 0 0' }}>{t('bb.chatMode.jobBody')}</p>
                  </div>
                ) : (
                  <span style={{ whiteSpace: 'pre-wrap' }}>{message.body}</span>
                )}

                {message.role === 'assistant' && (message.areas?.length ?? 0) > 0 ? (
                  <small className="bb-chat-areas" data-testid="chat-areas">
                    {t('bb.chatMode.fromAreas').replace(
                      '{areas}',
                      (message.areas ?? []).map(areaName).join(' · '),
                    )}
                  </small>
                ) : null}

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

                {message.kind === 'job' && copilotHref && message.request ? (
                  <CopilotLink
                    href={copilotHref}
                    request={message.request}
                    className="bb-chat-action"
                    testId="chat-send-to-copilot"
                  >
                    {t('bb.chatMode.sendToCopilot')}
                  </CopilotLink>
                ) : null}
              </article>
            ))}

            {busy ? (
              <p className="bb-chat-message brain typing bs-pulse" data-testid="chat-busy">
                {labels.thinking}
              </p>
            ) : null}

            {error ? (
              <p className="bb-chat-message brain" role="alert" data-testid="chat-error">
                {error}
              </p>
            ) : null}
          </>
        ) : null}

        {mode === 'add' ? (
          <form
            className="bb-chat-message brain bb-chat-panel"
            data-testid="chat-add-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submitAdd(modes.review ? 'approve' : 'review');
            }}
          >
            <label>
              <span>{t('bb.chatMode.area')}</span>
              <select
                className={CONTROL_CLASS}
                ref={(node) => {
                  panelFocusRef.current = node;
                }}
                value={addArea}
                onChange={(event) => setAddArea(event.target.value)}
                data-testid="chat-add-area"
              >
                <option value="">{t('bb.chatMode.chooseArea')}</option>
                {areas.map((entry) => (
                  <option key={entry.area} value={entry.area}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
            {addHint ? <p data-testid="chat-add-question">{addHint}</p> : null}
            <label>
              <span>{t('bb.chatMode.factTitle')}</span>
              <input
                className={CONTROL_CLASS}
                value={addTitle}
                maxLength={200}
                onChange={(event) => setAddTitle(event.target.value)}
                data-testid="chat-add-title"
              />
            </label>
            <label>
              <span>{t('bb.chatMode.factBody')}</span>
              <textarea
                className={CONTROL_CLASS}
                rows={3}
                value={addBody}
                maxLength={2_000}
                onChange={(event) => setAddBody(event.target.value)}
                data-testid="chat-add-body"
              />
            </label>
            {modes.review ? null : <p>{t('bb.sendForReviewNote')}</p>}
            <button
              type="submit"
              className="bb-chat-action"
              disabled={busy}
              data-testid={modes.review ? 'chat-add-approve' : 'chat-add-send-review'}
            >
              {modes.review ? t('bb.addApprove') : t('bb.sendForReview')}
            </button>
          </form>
        ) : null}

        {mode === 'edit' || mode === 'remove' ? (
          <div className="bb-chat-message brain bb-chat-panel" data-testid={`chat-${mode}-panel`}>
            <p
              tabIndex={-1}
              ref={(node) => {
                panelFocusRef.current = node;
              }}
            >
              {mode === 'edit' ? t('bb.chatMode.editIntro') : t('bb.chatMode.removeIntro')}
            </p>

            {matches && matches.length === 0 ? (
              <p data-testid="chat-no-match">{t('bb.chatMode.noMatch')}</p>
            ) : null}

            {matches && matches.length > 0 && !chosen ? (
              <ul className="bb-chat-matches" data-testid="chat-matches">
                {matches.map((fact) => (
                  <li key={fact.id}>
                    <button
                      type="button"
                      className="bb-chat-match"
                      data-testid={`chat-match-${fact.id}`}
                      onClick={() => choose(fact)}
                    >
                      {factLine(fact)}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            {chosen && mode === 'edit' ? (
              <form
                data-testid="chat-edit-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveEdit();
                }}
              >
                <div className="bb-chat-old" data-testid="chat-edit-old">
                  <small>{t('bb.chatMode.current')}</small>
                  {/* The old words, struck through, beside the new ones (D7). */}
                  <s>
                    {pick(chosen.title, locale)} — {pick(chosen.body, locale)}
                  </s>
                  <small>
                    {areaName(chosen.area)} · v{chosen.version}
                    {chosen.expired ? ` · ${t('bb.expired')}` : ''}
                  </small>
                </div>
                <label>
                  <span>{t('bb.chatMode.factTitle')}</span>
                  <input
                    className={CONTROL_CLASS}
                    value={editTitle}
                    maxLength={200}
                    onChange={(event) => setEditTitle(event.target.value)}
                    data-testid="chat-edit-title"
                  />
                </label>
                <label>
                  <span>{t('bb.chatMode.newText')}</span>
                  <textarea
                    className={CONTROL_CLASS}
                    rows={3}
                    value={editBody}
                    maxLength={2_000}
                    onChange={(event) => setEditBody(event.target.value)}
                    data-testid="chat-edit-body"
                  />
                </label>
                <div className="bb-chat-buttons">
                  <button
                    type="submit"
                    className="bb-chat-action"
                    disabled={busy}
                    data-testid="chat-edit-save"
                  >
                    {t('common.save')}
                  </button>
                  <button
                    type="button"
                    className="bb-chat-link"
                    onClick={() => setChosen(null)}
                    data-testid="chat-edit-back"
                  >
                    {t('bb.chatMode.chooseAnother')}
                  </button>
                </div>
              </form>
            ) : null}

            {chosen && mode === 'remove' ? (
              <div data-testid="chat-remove-confirm">
                <p className="bb-chat-old">{factLine(chosen)}</p>
                <p>{t('bb.chatMode.removeConfirm')}</p>
                <div className="bb-chat-buttons">
                  <button
                    type="button"
                    className="bb-chat-action"
                    disabled={busy}
                    onClick={() => void remove()}
                    data-testid="chat-remove-go"
                  >
                    {t('bb.chatMode.removeGo')}
                  </button>
                  <button type="button" className="bb-chat-link" onClick={() => setChosen(null)}>
                    {t('bb.chatMode.chooseAnother')}
                  </button>
                </div>
              </div>
            ) : null}

            {removed ? (
              <div data-testid="chat-removed">
                <p>
                  {t('bb.chatMode.removed').replace(
                    '{title}',
                    pick(removed.fact.title, locale) || removed.fact.itemKey,
                  )}
                </p>
                <button
                  type="button"
                  className="bb-chat-action"
                  disabled={busy}
                  onClick={() => void undo()}
                  data-testid="chat-undo"
                >
                  {t('bb.chatMode.undo')}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {mode !== 'ask' && outcome ? (
          <p
            className="bb-chat-message brain"
            role={outcome.tone === 'error' ? 'alert' : 'status'}
            data-testid={outcome.tone === 'error' ? 'chat-mode-error' : 'chat-mode-done'}
          >
            {outcome.text}
          </p>
        ) : null}
      </div>

      {mode === 'ask' ? (
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
      ) : null}

      {mode === 'add' ? null : (
        <form
          className="bb-chat-compose"
          onSubmit={(event) => {
            event.preventDefault();
            if (mode !== 'ask') {
              void find(draft);
              return;
            }
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
            disabled={mode === 'ask' ? !canChat : !modes.edit}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={composerPlaceholder}
            aria-label={composerPlaceholder}
          />
          <button
            type="submit"
            className="bb-chat-send"
            data-testid={busy && mode === 'ask' ? 'chat-cancel' : 'chat-send'}
            disabled={
              mode === 'ask'
                ? !canChat || (!busy && draft.trim().length === 0)
                : busy || draft.trim().length === 0
            }
            aria-label={busy && mode === 'ask' ? labels.cancel : labels.send}
          >
            {busy && mode === 'ask' ? '×' : '↑'}
          </button>
        </form>
      )}

      <small className="bb-chat-disclaimer">
        {mode === 'ask' ? `${labels.disclaimer} ${labels.retention}` : t('bb.chatMode.noCredits')}
      </small>
    </section>
  );
}
