'use client';

import Link from 'next/link';
import { formatCredits } from '../../../server/composer-editor';
import { useCallback, useEffect, useState } from 'react';
import {
  Banner,
  Button,
  buttonClass,
  Card,
  CopilotBody,
  SectionHeader,
  StateMessage,
  StatusBadge,
  colorTokens,
  spacingTokens,
  typographyTokens,
  type CopilotLabels,
  type CopilotMessage,
  type CopilotProposedAction,
  type CopilotToolRun,
} from '@brandspace/ui';
import { messages as catalogue, statusMessage, type MessageKey } from '../../../i18n/messages';
import { type DateFormatterLike, whenFormatter } from '../../../server/prototype-dates';
import { aiLimitMessage } from '../../../components/ai-limit';
import { ConversationFoot, ConversationTools } from './conversation-tools';
import { SourceCard, type SourceCardLabels } from './source-card';

/**
 * THE COPILOT, WIRED TO A REAL PROVIDER FOR THE FIRST TIME.
 *
 * IT USES THE EXISTING VISUAL SHELL. `CopilotBody` shipped with the design system
 * and already renders the conversation, the tool cards, the preview and — the
 * part that matters — the approval region. This screen supplies real data to it
 * rather than building a second visual system beside it (CLAUDE.md §4.1).
 *
 * THE CONFIRMATION TOKEN LIVES IN REACT STATE AND NOWHERE ELSE. It arrives in the
 * `/turn` response, sits in this component's memory, and is sent back in the
 * `/confirm` request body. It is never put in the URL — a query string lands in
 * the browser history, in the referrer of every subsequent request and in an
 * access log, and this token is a live authorization to change tenant state.
 *
 * THE PLAN HASH GOES BACK WITH IT, and that is the binding: `/confirm` refuses a
 * hash that no longer matches the stored plan, so a confirmation issued for one
 * plan cannot be applied to a revision of it.
 *
 * NOTHING HERE DECIDES ANYTHING. Every refusal this screen can show — no
 * permission, brand out of scope, entitlement denied, confirmation expired,
 * unsafe undo — is a decision the server made and this component renders. A
 * client that decided would be a client that could be persuaded otherwise.
 */

/** PR B — one stored entry of the conversation, as `/api/copilot/conversation` returns it. */
interface HistoryRow {
  readonly id: string;
  readonly role: 'USER' | 'ASSISTANT';
  readonly body: string | null;
  readonly kind: 'message' | 'topic_break';
  readonly purged: boolean;
  readonly createdAt: string;
}

export interface CopilotBrand {
  readonly id: string;
  readonly name: string;
}

interface PlanStep {
  readonly ordinal: number;
  readonly toolKey: string;
  readonly messageKey: string;
  readonly actionClass: 'READ_ONLY' | 'INTERNAL_REVERSIBLE' | 'EXTERNAL_OR_DESTRUCTIVE';
  readonly spendsCredits: boolean;
  readonly undoable: boolean;
  readonly preview: readonly { labelKey: string; before?: string; after: string }[];
}

interface InspectionCall {
  readonly ordinal: number;
  readonly toolKey: string;
  readonly status: string;
  readonly failureCode: string | null;
  readonly result: unknown;
}

interface PlanResponse {
  readonly summary?: { ar: string; en: string };
  /** Phase 2C D9: a brand question while the brand's "Use Brand Brain" is off. */
  /** Phase 2C-3 D8: `brand_brain_missing` — a brand question nothing usable answers. */
  readonly notice?: 'brand_brain_off' | 'brand_brain_missing' | 'permission_denied' | null;
  /** PR B — the permissions a refused workspace read asked for. */
  readonly deniedPermissions?: readonly string[];
  /** D8 — the knowledge areas this turn's brand facts came from (retrieval, not the model). */
  readonly brandFactAreas?: readonly string[];
  /** D8 — the key question that would answer it, when one matches. */
  readonly missing?: {
    readonly area: string;
    readonly itemKey: string;
    readonly question: { readonly en?: string; readonly ar?: string };
  } | null;
  /** D8 — "save this fact": handed to Brand Brain → Add, never saved here. */
  readonly saveFact?: {
    readonly area: string | null;
    readonly title: string | null;
    readonly body: string | null;
  } | null;
  readonly planId?: string;
  readonly planHash?: string;
  readonly requiresConfirmation?: boolean;
  readonly highestActionClass?: PlanStep['actionClass'];
  readonly estimatedCreditsMilli?: string;
  readonly confirmationExpiresAt?: string | null;
  readonly confirmationToken?: string | null;
  readonly rejectedToolKeys?: readonly string[];
  readonly steps?: readonly PlanStep[];
  readonly inspection?: readonly InspectionCall[] | null;
  readonly error?: { code?: string; details?: Readonly<Record<string, unknown>> };
}

interface ExecutionResponse {
  readonly status?: string;
  readonly undoStatus?: string;
  readonly undoExpiresAt?: string | null;
  readonly toolCalls?: readonly {
    ordinal: number;
    toolKey: string;
    status: string;
    failureCode: string | null;
  }[];
  readonly undone?: readonly { ordinal: number; toolKey: string }[];
  readonly refused?: readonly { ordinal: number; toolKey: string; reason: string }[];
  readonly error?: { code?: string; details?: Readonly<Record<string, unknown>> };
}

/** Preview values that are machine keys, and the message stem that names them. */
const TRANSLATED_PREVIEW: Readonly<Record<string, string>> = {
  'copilot.preview.trigger': 'automations.trigger.',
  'copilot.preview.action': 'automations.action.',
  'copilot.preview.ruleEnabled': 'copilot.ruleEnabled.',
};

export function CopilotView({
  locale,
  now: serverNow,
  brand,
  surface,
  labels,
  creditsLabel,
  denials = {},
  sources = null,
  subject = null,
  initialRequest = '',
  rateMetricKeys = [],
  panel = null,
  retentionDays = null,
}: {
  /**
   * PR B — how long the conversation's messages are kept (the Copilot policy's
   * retention), for the line under the composer. Null draws no line.
   */
  readonly retentionDays?: number | null;
  readonly locale: string;
  /**
   * The server's `systemClock.now()`, as ISO: what this client view reads
   * its dates against (a date in another year shows its year). It never reads
   * the real clock for a label.
   */
  readonly now: string;
  /**
   * THE FLOATING PANEL'S EXTRAS (`Main.dc.html` lines 1494–1523, review of #67
   * round 3): the greeting bubble the conversation opens with and the three
   * suggestion chips above the field. A chip puts its request in the field and
   * sends nothing — the person reads it and presses send, and the plan and
   * confirmation apply as always (the same rule as D-296's hand-over). The
   * panel's head states the context, so the line above the conversation is
   * not drawn twice.
   */
  readonly panel?: {
    readonly greeting: string;
    /** The field's short placeholder ("Ask or request something…"). */
    readonly placeholder: string;
    /**
     * PR B — a chip may carry the request it puts in the box (`prompt`) when
     * that differs from what it reads (Brand Brain's three chips, the page's
     * own question); otherwise its label is the request.
     */
    readonly suggestions: readonly {
      readonly id: string;
      readonly label: string;
      readonly prompt?: string;
    }[];
  } | null;
  /**
   * The metrics stored in parts per mille, from the analytics catalogue on the
   * server — so a rate from a result recorded before results carried their
   * unit still reads as a percentage (Phase 2B-2b).
   */
  readonly rateMetricKeys?: readonly string[];
  /**
   * D-296 — a request handed over by "Give to Copilot" (a recurring workflow
   * BrandSpace noticed). Put in the box, NEVER sent: the person reads it and
   * presses Propose, and the plan/confirm ceremony applies as always.
   */
  readonly initialRequest?: string;
  /**
   * WHAT THE READER IS LOOKING AT (D-277 §37, D-280) — a campaign, a post or an
   * insight, with the title to say so. Sent when the session opens; the server
   * admits it against the brand or refuses the conversation.
   */
  readonly subject?: {
    readonly type: 'CAMPAIGN' | 'CONTENT_ITEM' | 'INSIGHT';
    readonly id: string;
    readonly title: string;
  } | null;
  /** The rail's selected brand — the ONLY brand this conversation acts on (D-190). */
  readonly brand: CopilotBrand;
  /** Where the Copilot was opened from; a key from the closed surface list. */
  readonly surface: string;
  readonly labels: CopilotLabels;
  /** Omitted where no real balance can be read. Nothing is invented (§2.2). */
  readonly creditsLabel: string | null;
  /**
   * PR B (D-594) — the screen's own refusal (E6) per permission this member
   * lacks, so "show me our billing" is refused in the words Billing uses.
   */
  readonly denials?: Readonly<Record<string, string>>;
  /**
   * PR B — "+" attaches a file to Brand Brain (the retired chat's attach),
   * for a member who may upload sources; `review` offers Approve all.
   */
  readonly sources?: { readonly review: boolean } | null;
}) {
  /*
   * THE DICTIONARY IS RESOLVED HERE, FROM THE LOCALE — never handed in as a
   * function. A server component may pass this client component only
   * SERIALIZABLE props, and a translator is a closure.
   */
  const dictionary = locale === 'ar' ? catalogue.ar : catalogue.en;
  const t = (key: MessageKey): string => dictionary[key];
  /** A key that may not exist (a machine value's label): the value itself if not. */
  const tOr = (key: string, fallback: string): string =>
    (dictionary as Record<string, string>)[key] ?? fallback;

  /*
   * D8 (Phase 2C-3) — BRAND ANSWERS NAME THEIR AREA; A MISSING FACT IS SAID IN
   * THE PRODUCT'S WORDS. The area names are translated from closed keys the
   * server returned from retrieval — never taken from the model's text.
   */
  const areaLabel = (area: string): string =>
    tOr(
      `bb.area.${area.toLowerCase().replace(/_([a-z])/g, (_all, c: string) => c.toUpperCase())}`,
      area,
    );
  const missingSentence = (missing: PlanResponse['missing'] | null): string => {
    if (!missing) return t('copilot.notice.brandBrainMissing');
    const question =
      (locale === 'ar'
        ? (missing.question.ar ?? missing.question.en)
        : (missing.question.en ?? missing.question.ar)) ?? '';
    return t('copilot.notice.brandBrainMissingNamed')
      .replace('{question}', question)
      .replace('{area}', areaLabel(missing.area));
  };

  const number = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 2,
  });
  const time = whenFormatter(locale, 'UTC', new Date(serverNow));

  /*
   * ONE CONVERSATION PER VISIT (P6-12). Every submit used to open a NEW
   * session, so the history the orchestrator carefully fences into each turn
   * was always empty and "now make it shorter" meant nothing. The session is
   * opened on the first request and reused; the brand is fixed for the visit,
   * so a different brand in the rail is a different page load and a new
   * conversation.
   */
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [request, setRequest] = useState(initialRequest.slice(0, 1_000));
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<readonly CopilotMessage[]>([]);
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [execution, setExecution] = useState<ExecutionResponse | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  // PR A2 — a daily or monthly AI budget names itself and its reset time.
  const [errorDetails, setErrorDetails] = useState<Readonly<Record<string, unknown>> | null>(null);
  const [now, setNow] = useState(() => Date.now());

  /*
   * PR B (D-594) — THE ONE CONVERSATION. It is opened as soon as the Copilot
   * is (free: no model is called), its history is read back — the whole
   * conversation, grouped by day, with the "New topic" dividers — and read
   * again after every reply, so what the person sees is what was stored.
   */
  const [history, setHistory] = useState<readonly HistoryRow[]>([]);
  const [search, setSearch] = useState('');
  const [attached, setAttached] = useState<File | null>(null);
  // PR B — the turn under way, for Stop; and how many were stopped.
  const [turn, setTurn] = useState<{ sessionId: string; idempotencyKey: string } | null>(null);
  const [stops, setStops] = useState(0);
  // PR B — ONE KEY PER PAGE LOAD: a double click replays the turn, while the
  // same words asked again after a reload or a Clear are a new request (the
  // gateway's own replay outlives the cleared messages).
  const [pageNonce] = useState(() => Math.floor(Math.random() * 0x7fffffff).toString(36));
  const [found, setFound] = useState<readonly HistoryRow[] | null>(null);
  const [price, setPrice] = useState<string | null>(null);

  /*
   * THE CONFIRMATION WINDOW IS SHOWN CLOSING, NOT DISCOVERED CLOSED. While a
   * plan waits, the clock ticks so the expiry is stated and, once passed, the
   * confirm button stands down with a sentence rather than failing on click.
   */
  const awaiting = Boolean(plan?.requiresConfirmation && !execution && token);
  useEffect(() => {
    if (!awaiting) return;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [awaiting]);

  const post = async (path: string, body: unknown): Promise<unknown> => {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return response.json().catch(() => ({ error: { code: 'INTERNAL' } }));
  };

  const openSession = async (): Promise<string | null> => {
    if (sessionId) return sessionId;
    const opened = (await post('/api/copilot/session', {
      brandId: brand.id,
      surface,
      locale: locale === 'ar' ? 'AR' : 'EN',
      subject: subject ? { type: subject.type, id: subject.id } : null,
    })) as { sessionId?: string; error?: { code?: string } };
    if (!opened.sessionId) {
      setErrorCode(opened.error?.code ?? 'INTERNAL');
      return null;
    }
    setSessionId(opened.sessionId);
    return opened.sessionId;
  };

  const load = useCallback(async (id: string): Promise<void> => {
    const page = (await post('/api/copilot/conversation', { sessionId: id, limit: 200 })) as {
      messages?: readonly HistoryRow[];
    };
    if (page.messages) {
      setHistory(page.messages);
      setMessages([]);
    }
    // `post` is stable for the life of the view.
  }, []);

  useEffect(() => {
    void (async () => {
      const id = await openSession();
      if (id) await load(id);
    })();
    // Opened once per view: the brand is fixed for the visit (D-190).
  }, []);

  // Search inside the conversation, after a pause in typing.
  useEffect(() => {
    const query = search.trim();
    if (query === '' || !sessionId) {
      setFound(null);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      void (async () => {
        const page = (await post('/api/copilot/conversation', {
          sessionId,
          search: query,
          limit: 100,
        })) as { messages?: readonly HistoryRow[] };
        setFound(page.messages ?? []);
      })();
    }, 350);
    return () => window.clearTimeout(timer);
  }, [search, sessionId]);

  // The price of the message being written, shown before it is sent.
  useEffect(() => {
    const text = request.trim();
    if (text === '' || !sessionId) {
      setPrice(null);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      void (async () => {
        const quote = (await post('/api/copilot/quote', { sessionId, request: text })) as {
          estimateMilli?: string;
        };
        setPrice(
          quote.estimateMilli !== undefined
            ? t('copilot.messagePrice').replace('{credits}', formatCredits(quote.estimateMilli))
            : null,
        );
      })();
    }, 600);
    return () => window.clearTimeout(timer);
  }, [request, sessionId]);

  const newTopic = async (): Promise<void> => {
    if (!sessionId || busy) return;
    await post('/api/copilot/topic', { sessionId });
    setPlan(null);
    await load(sessionId);
  };

  const clearConversation = async (): Promise<void> => {
    if (!sessionId || busy) return;
    await post('/api/copilot/clear', { sessionId });
    setPlan(null);
    setExecution(null);
    setSearch('');
    await load(sessionId);
  };

  /** "Today", "Yesterday", or the date, as the reader's locale writes it. */
  const dayOf = (iso: string): string => {
    const day = new Date(iso);
    const today = new Date(serverNow);
    const key = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (key(day) === key(today)) return t('copilot.today');
    const yesterday = new Date(today.getTime() - 86_400_000);
    if (key(day) === key(yesterday)) return t('copilot.yesterday');
    return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-u-nu-latn' : 'en', {
      dateStyle: 'medium',
    }).format(day);
  };

  const shown: CopilotMessage[] = [];
  let lastDay = '';
  for (const row of found ?? history) {
    const day = dayOf(row.createdAt);
    if (day !== lastDay) {
      shown.push({ id: `day-${row.id}`, author: 'assistant', text: day, kind: 'day' });
      lastDay = day;
    }
    shown.push(
      row.kind === 'topic_break'
        ? { id: row.id, author: 'user', text: t('copilot.topicBreak'), kind: 'topic_break' }
        : {
            id: row.id,
            author: row.role === 'USER' ? 'user' : 'assistant',
            text: row.purged ? t('copilot.purged') : (row.body ?? ''),
          },
    );
  }
  const conversation: readonly CopilotMessage[] = found ? shown : [...shown, ...messages];

  const propose = async (): Promise<void> => {
    if (request.trim().length === 0 || busy) return;
    setBusy(true);
    setErrorCode(null);
    setErrorDetails(null);
    setExecution(null);
    try {
      const active = await openSession();
      if (!active) return;

      setMessages((current) => [
        ...current,
        { id: `u-${current.length}`, author: 'user', text: request },
      ]);

      // ONE KEY PER REQUEST TEXT ON THIS PAGE, so a double click replays the
      // first turn rather than paying for a second. PR B — a stopped turn
      // moves the counter, so asking again is a new turn.
      const idempotencyKey = `copilot:${active}:${pageNonce}:${digest(request)}:${stops}`;
      setTurn({ sessionId: active, idempotencyKey });
      const result = (await post('/api/copilot/turn', {
        sessionId: active,
        // NO brandId. The session owns its brand; see the turn route (P7-R1).
        request,
        idempotencyKey,
      })) as PlanResponse;

      // PR B — STOPPED: no answer, nothing charged, and no error to show.
      if (
        result.error?.code === 'CONFLICT' &&
        (result.error.details as { reason?: unknown } | undefined)?.reason === 'stopped'
      ) {
        setMessages((current) => [
          ...current,
          { id: `a-${current.length}`, author: 'assistant', text: t('copilot.stopped') },
        ]);
        return;
      }
      if (result.error?.code) {
        // A conversation the server no longer admits (expired, or the brand
        // scope narrowed) is dropped, so the next request opens a fresh one.
        if (result.error.code === 'NOT_FOUND') setSessionId(null);
        setErrorCode(result.error.code);
        setErrorDetails(result.error.details ?? null);
        return;
      }
      setPlan(result);
      setToken(result.confirmationToken ?? null);
      setNow(Date.now());
      // A brand question while Brand Brain is off is answered with the notice,
      // in the reader's language, never with the model's words (Phase 2C D9).
      const summary =
        result.notice === 'brand_brain_off'
          ? t('copilot.notice.brandBrainOff')
          : result.notice === 'brand_brain_missing'
            ? missingSentence(result.missing ?? null)
            : result.notice === 'permission_denied'
              ? [...new Set(result.deniedPermissions ?? [])]
                  .map((key) => denials[key])
                  .filter((line): line is string => Boolean(line))
                  .join(' ') || t('copilot.notice.permissionDenied')
              : result.saveFact
                ? t('copilot.saveFact.summary')
                : locale === 'ar'
                  ? result.summary?.ar
                  : result.summary?.en;
      if (summary) {
        setMessages((current) => [
          ...current,
          { id: `a-${current.length}`, author: 'assistant', text: summary },
        ]);
      }
      setRequest('');
      await load(active);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (): Promise<void> => {
    if (!plan?.planId || !plan.planHash || busy) return;
    setBusy(true);
    setErrorCode(null);
    setErrorDetails(null);
    try {
      const result = (await post('/api/copilot/confirm', {
        planId: plan.planId,
        // THE HASH THE CUSTOMER WAS SHOWN, sent back so the server can refuse a
        // confirmation issued for a different version of this plan.
        planHash: plan.planHash,
        token: token ?? '',
      })) as ExecutionResponse;
      if (result.error?.code) {
        setErrorCode(result.error.code);
        setErrorDetails(result.error.details ?? null);
        return;
      }
      setExecution(result);
      // THE TOKEN IS SPENT. Dropping it here means a second click cannot even
      // attempt a replay, on top of the server refusing one.
      setToken(null);
    } finally {
      setBusy(false);
    }
  };

  /*
   * DECLINING IS A SERVER ACT NOW (P6-12). The plan is cancelled where it
   * lives, its confirmation token cleared and `copilot.plan_cancelled` audited
   * — it no longer sits open until its window lapses. The local state is
   * cleared whatever the answer: a plan that had already expired cannot be
   * cancelled and does not need to be.
   */
  const reject = async (): Promise<void> => {
    const planId = plan?.planId;
    setPlan(null);
    setToken(null);
    if (!planId || busy) return;
    setBusy(true);
    try {
      await post('/api/copilot/cancel', { planId });
    } finally {
      setBusy(false);
    }
  };

  const undo = async (): Promise<void> => {
    if (!plan?.planId || busy) return;
    setBusy(true);
    setErrorCode(null);
    setErrorDetails(null);
    try {
      const result = (await post('/api/copilot/undo', {
        planId: plan.planId,
      })) as ExecutionResponse;
      if (result.error?.code) {
        setErrorCode(result.error.code);
        setErrorDetails(result.error.details ?? null);
        return;
      }
      setExecution((current) => ({ ...current, ...result }));
    } finally {
      setBusy(false);
    }
  };

  const steps = plan?.steps ?? [];
  const external = plan?.highestActionClass === 'EXTERNAL_OR_DESTRUCTIVE';
  const expiresAt = plan?.confirmationExpiresAt ? Date.parse(plan.confirmationExpiresAt) : null;
  const expired = expiresAt !== null && expiresAt <= now;
  const costMilli = Number(plan?.estimatedCreditsMilli ?? '0');
  const previewValue = (labelKey: string, value: string): string => {
    const stem = TRANSLATED_PREVIEW[labelKey];
    return stem ? tOr(`${stem}${value}`, value) : value;
  };
  const stepTitle = (toolKey: string): string => {
    const step = steps.find((entry) => entry.toolKey === toolKey);
    return step ? t(`copilot.tool.${step.messageKey}` as MessageKey) : toolKey;
  };

  const tools: readonly CopilotToolRun[] = steps.map((step) => {
    const call =
      execution?.toolCalls?.find((entry) => entry.ordinal === step.ordinal) ??
      plan?.inspection?.find((entry) => entry.ordinal === step.ordinal);
    return {
      id: String(step.ordinal),
      title: t(`copilot.tool.${step.messageKey}` as MessageKey),
      detail: t(`copilot.actionClass.${step.actionClass}` as MessageKey),
      status:
        call?.status === 'SUCCEEDED'
          ? 'done'
          : call && call.status !== 'PLANNED' && call.status !== 'RUNNING'
            ? 'failed'
            : 'running',
    };
  });

  const proposedAction: CopilotProposedAction | undefined =
    plan && plan.requiresConfirmation && !execution && !expired
      ? {
          id: plan.planId ?? 'plan',
          title: t('copilot.plan'),
          description: external ? t('copilot.externalWarning') : t('copilot.subtitle'),
          mutating: true,
          preview: steps.flatMap((step) =>
            step.preview.map((line) => ({
              label: t(line.labelKey as MessageKey),
              before:
                line.before === undefined ? undefined : previewValue(line.labelKey, line.before),
              after: previewValue(line.labelKey, line.after),
            })),
          ),
        }
      : undefined;

  const executionTone =
    execution?.status === 'COMPLETED'
      ? 'success'
      : execution?.status === 'FAILED'
        ? 'danger'
        : 'neutral';

  return (
    <div style={{ display: 'grid', gap: spacingTokens.lg }}>
      {/*
       * A REFUSAL IN THE READER'S LANGUAGE, NEVER A MACHINE CODE. A code the
       * catalogue does not know renders the generic sentence rather than itself.
       */}
      {errorCode ? (
        <Banner tone="error" testId="copilot-error">
          {aiLimitMessage(
            { error: { code: errorCode, ...(errorDetails ? { details: errorDetails } : {}) } },
            { 'ai.limit.daily': t('ai.limit.daily'), 'ai.limit.monthly': t('ai.limit.monthly') },
            locale,
          ) ??
            statusMessage(errorCode, locale) ??
            t('copilot.failed')}
        </Banner>
      ) : null}

      {/*
        D-304 — ONE ASSISTANT, ONE COMPOSER. This used to be a card with its own
        "What would you like to get done?" field above the conversation, whose
        own composer then sat inert beneath it: two places to type one thing.
        Now the header states what the conversation is about, the plan and its
        results follow, and the one composer is the conversation's own.
      */}
      {panel ? null : (
        <p
          data-testid="copilot-context"
          style={{ margin: 0, ...typographyTokens.caption, color: colorTokens.textSecondary }}
        >
          {t('copilot.contextBrand').replace('{brand}', brand.name)}
          {surface !== 'general'
            ? ` · ${t('copilot.contextFrom').replace(
                '{screen}',
                tOr(`copilot.surface.${surface}`, surface),
              )}`
            : ''}
          {subject ? ` · ${t('copilot.contextSubject').replace('{subject}', subject.title)}` : ''}
        </p>
      )}

      {plan && steps.length === 0 ? (
        <div data-testid="copilot-answered" style={{ display: 'grid', gap: spacingTokens.sm }}>
          {/* D8 — where the brand facts in this answer came from. */}
          {(plan.brandFactAreas?.length ?? 0) > 0 && !plan.notice ? (
            <p
              data-testid="copilot-brand-areas"
              style={{ margin: 0, ...typographyTokens.caption, color: colorTokens.textSecondary }}
            >
              {t('copilot.brandAreas').replace(
                '{areas}',
                (plan.brandFactAreas ?? []).map(areaLabel).join(' · '),
              )}
            </p>
          ) : null}
          {plan.notice === 'brand_brain_missing' ? (
            <Banner tone="info" testId="copilot-brand-missing">
              {missingSentence(plan.missing ?? null)}
            </Banner>
          ) : null}
          {/*
            D8 — THE COPILOT NEVER SAVES A FACT. A save request becomes this
            card: a link into the Brand Brain area's add form, prefilled. Nothing
            is saved until the person adds it there, with their own permission.
          */}
          {plan.saveFact ? (
            <Banner tone="info" testId="copilot-save-handoff">
              <span style={{ display: 'grid', gap: spacingTokens.xs }}>
                <span>{t('copilot.saveFact.body')}</span>
                <Link
                  href={`/${locale}/brand-brain?${new URLSearchParams({
                    brand: brand.id,
                    mode: 'add',
                    ...(plan.saveFact.area ? { area: plan.saveFact.area } : {}),
                    ...(plan.saveFact.title ? { title: plan.saveFact.title } : {}),
                    ...(plan.saveFact.body ? { body: plan.saveFact.body } : {}),
                  }).toString()}`}
                  className={buttonClass('neutral', 'sm')}
                  style={{ justifySelf: 'start' }}
                  data-testid="copilot-save-handoff-link"
                >
                  {t('copilot.saveFact.open')}
                </Link>
              </span>
            </Banner>
          ) : null}
          {plan.notice || plan.saveFact ? null : (
            <StateMessage kind="no-results" title={t('copilot.planEmpty')} />
          )}
        </div>
      ) : null}

      {plan && (plan.rejectedToolKeys?.length ?? 0) > 0 ? (
        <Banner tone="warning">{t('copilot.rejectedTools')}</Banner>
      ) : null}

      {plan && steps.length > 0 ? (
        <Card testId="copilot-plan">
          <SectionHeader
            title={t('copilot.plan')}
            description={
              costMilli > 0
                ? `${t('copilot.estimatedCost')}: ${formatCredits(plan?.estimatedCreditsMilli ?? '0')} ${t(
                    'copilot.credits',
                  )}`
                : t('copilot.noCost')
            }
            actions={
              <StatusBadge
                tone={external ? 'warning' : 'neutral'}
                label={t(
                  `copilot.actionClass.${plan.highestActionClass ?? 'READ_ONLY'}` as MessageKey,
                )}
              />
            }
          />
          {/*
           * THE EXTERNAL WARNING IS ITS OWN BANNER, not a line in a list. A plan
           * that would leave the platform must not look like one that would not.
           */}
          {external ? (
            <Banner tone="warning">{t('copilot.externalWarning')}</Banner>
          ) : (
            /*
             * AND THE OPPOSITE IS SAID TOO (D-277 §38): a plan that stays inside
             * BrandSpace says so before it is confirmed, so "create two drafts"
             * is never mistaken for "post two things".
             */
            <p
              data-testid="copilot-nothing-published"
              style={{ margin: 0, ...typographyTokens.caption, color: colorTokens.textSecondary }}
            >
              {t('copilot.nothingWillPublish')}
            </p>
          )}

          <ol
            style={{
              display: 'grid',
              gap: spacingTokens.sm,
              paddingInlineStart: 'var(--bsp-rem-1-25)',
            }}
          >
            {steps.map((step) => {
              const call = execution?.toolCalls?.find((entry) => entry.ordinal === step.ordinal);
              return (
                <li
                  key={step.ordinal}
                  style={{ ...typographyTokens.bodySm }}
                  data-testid={`copilot-step-${step.ordinal}`}
                >
                  <strong>{t(`copilot.tool.${step.messageKey}` as MessageKey)}</strong>{' '}
                  <span style={{ color: colorTokens.textSecondary }}>
                    ({t(`copilot.actionClass.${step.actionClass}` as MessageKey)}
                    {step.undoable ? '' : ` · ${t('copilot.notUndoable')}`})
                  </span>
                  {step.preview.length > 0 ? (
                    <ul style={{ margin: 0, paddingInlineStart: 'var(--bsp-rem-1)' }}>
                      {step.preview.map((line) => (
                        <li
                          key={`${step.ordinal}-${line.labelKey}`}
                          style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}
                        >
                          {t(line.labelKey as MessageKey)}:{' '}
                          {line.before !== undefined && line.before !== line.after ? (
                            <>
                              <s>{previewValue(line.labelKey, line.before)}</s> →{' '}
                            </>
                          ) : null}
                          {previewValue(line.labelKey, line.after)}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {call ? (
                    <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
                      {' '}
                      · {tOr(`copilot.toolStatus.${call.status}`, call.status)}
                      {call.failureCode
                        ? ` (${tOr(`copilot.failure.${call.failureCode}`, t('copilot.failureOther'))})`
                        : ''}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ol>

          {plan.inspection && plan.inspection.length > 0 ? (
            <InspectionResults
              calls={plan.inspection}
              title={t('copilot.inspection.title')}
              stepTitle={stepTitle}
              t={tOr}
              number={number}
              time={time}
              rateMetricKeys={rateMetricKeys}
              locale={locale}
            />
          ) : null}

          {plan.requiresConfirmation && !execution ? (
            expired ? (
              <p
                data-testid="copilot-expired"
                style={{ margin: 0, ...typographyTokens.caption, color: colorTokens.textSecondary }}
              >
                {t('copilot.expired')}
              </p>
            ) : (
              <div style={{ display: 'flex', gap: spacingTokens.sm, flexWrap: 'wrap' }}>
                <Button
                  variant="brand"
                  size="sm"
                  onClick={() => void confirm()}
                  disabled={busy || token === null}
                  data-testid="copilot-confirm"
                >
                  {t('copilot.confirm')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void reject()}
                  disabled={busy}
                  data-testid="copilot-reject"
                >
                  {t('copilot.reject')}
                </Button>
                {expiresAt !== null ? (
                  <span style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}>
                    {t('copilot.confirmationExpires')}: {time.format(new Date(expiresAt))}
                  </span>
                ) : null}
              </div>
            )
          ) : null}

          {execution ? (
            <div style={{ display: 'grid', gap: spacingTokens.sm }} data-testid="copilot-result">
              <StatusBadge
                tone={executionTone}
                label={tOr(
                  `copilot.status.${execution.status ?? ''}`,
                  String(execution.status ?? ''),
                )}
              />
              {/*
               * WHAT CHANGED, SAID EXACTLY (D-277 §38): one line per step that
               * ran, from the server's own tool-call record — and, unless a
               * publish step actually succeeded, that nothing was published.
               */}
              <ul
                data-testid="copilot-changed"
                style={{
                  margin: 0,
                  paddingInlineStart: 'var(--bsp-rem-1)',
                  ...typographyTokens.caption,
                }}
              >
                {(execution.toolCalls ?? [])
                  .filter((call) => call.status === 'SUCCEEDED')
                  .map((call) => (
                    <li key={call.ordinal}>✓ {stepTitle(call.toolKey)}</li>
                  ))}
              </ul>
              {(execution.toolCalls ?? []).some(
                (call) => call.toolKey === 'publishing.publish_now' && call.status === 'SUCCEEDED',
              ) ? null : (
                <p
                  data-testid="copilot-nothing-was-published"
                  style={{
                    margin: 0,
                    ...typographyTokens.caption,
                    color: colorTokens.textSecondary,
                  }}
                >
                  {t('copilot.nothingPublished')}
                </p>
              )}
              {execution.undoStatus === 'AVAILABLE' ? (
                <div style={{ display: 'flex', gap: spacingTokens.sm, flexWrap: 'wrap' }}>
                  <Button
                    variant="neutral"
                    size="sm"
                    onClick={() => void undo()}
                    disabled={busy}
                    data-testid="copilot-undo"
                  >
                    {t('copilot.undo')}
                  </Button>
                  {execution.undoExpiresAt ? (
                    <span style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}>
                      {t('copilot.undoUntil')}: {time.format(new Date(execution.undoExpiresAt))}
                    </span>
                  ) : null}
                </div>
              ) : execution.undoStatus && execution.undoStatus !== 'NOT_APPLICABLE' ? (
                <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
                  {tOr(`copilot.undoStatus.${execution.undoStatus}`, execution.undoStatus)}
                </span>
              ) : null}
              {(execution.refused?.length ?? 0) > 0 ? (
                <div data-testid="copilot-undo-refused">
                  <Banner tone="warning">{t('copilot.undoRefused')}</Banner>
                  <ul style={{ margin: 0, paddingInlineStart: 'var(--bsp-rem-1)' }}>
                    {execution.refused?.map((entry) => (
                      <li
                        key={`${entry.ordinal}-${entry.reason}`}
                        style={{ ...typographyTokens.caption }}
                      >
                        {tOr(`copilot.undoReason.${entry.reason}`, t('copilot.failureOther'))}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </Card>
      ) : null}

      {/*
       * THE APPROVED VISUAL SHELL, carrying the real conversation. It is the same
       * component the design showcase renders; the data behind it is real.
       */}
      <Card>
        <ConversationTools
          labels={{
            search: t('copilot.search'),
            searchPlaceholder: t('copilot.searchPlaceholder'),
            newTopic: t('copilot.newTopic'),
            more: t('copilot.more'),
            clear: t('copilot.clear'),
            clearTitle: t('copilot.clearTitle'),
            clearBody: t('copilot.clearBody'),
            clearConfirm: t('copilot.clearConfirm'),
            cancel: t('copilot.cancel'),
            close: t('copilot.close'),
          }}
          search={search}
          onSearch={setSearch}
          onNewTopic={() => void newTopic()}
          onClear={() => void clearConversation()}
          disabled={busy || !sessionId}
          {...(sources
            ? {
                attach: {
                  label: t('copilot.attachFile'),
                  onFile: (file: File) => setAttached(file),
                },
              }
            : {})}
        />
        <CopilotBody
          labels={panel ? { ...labels, promptPlaceholder: panel.placeholder } : labels}
          state={busy ? 'streaming' : proposedAction ? 'approval' : 'idle'}
          messages={
            panel && conversation.length === 0
              ? [{ id: 'copilot-hello', author: 'assistant', text: panel.greeting }]
              : conversation
          }
          {...(panel
            ? {
                suggestions: panel.suggestions,
                onSuggestion: (id: string) => {
                  const chosen = panel.suggestions.find((entry) => entry.id === id);
                  if (chosen && !busy) setRequest(chosen.prompt ?? chosen.label);
                },
              }
            : {})}
          tools={tools}
          {...(creditsLabel
            ? { credits: { label: t('overview.metric.credits'), value: creditsLabel } }
            : {})}
          {...(proposedAction ? { proposedAction } : {})}
          onApprove={() => void confirm()}
          onReject={() => void reject()}
          composer={{
            value: request,
            onChange: setRequest,
            onSubmit: () => void propose(),
            busy,
            maxLength: 2_000,
            inputTestId: 'copilot-request',
            submitTestId: 'copilot-propose',
          }}
        />
        {attached && sources ? (
          <SourceCard
            key={`${attached.name}-${attached.lastModified}`}
            file={attached}
            locale={locale}
            brandId={brand.id}
            canReview={sources.review}
            labels={sourceCardLabels(t)}
            onDone={() => setAttached(null)}
          />
        ) : null}
        {busy && turn ? (
          <span className="bsp-st-inline">
            <button
              type="button"
              className="bsp-btn bsp-sm bsp-sec"
              data-testid="copilot-stop"
              onClick={() => {
                setStops((count) => count + 1);
                void post('/api/copilot/stop', turn);
              }}
            >
              {t('copilot.stop')}
            </button>
          </span>
        ) : null}
        <ConversationFoot
          price={price}
          retention={
            retentionDays ? t('copilot.retention').replace('{days}', String(retentionDays)) : null
          }
        />
      </Card>
    </div>
  );
}

/**
 * WHAT A READ-ONLY PLAN FOUND (P6-12 — the Inspect step).
 *
 * Rendered from the tool results the server returned, which are METADATA by
 * construction: counts, statuses, ids, titles and STORED figures. A metric with
 * no value shows its named reason, never a zero. A result shape this component
 * does not recognise shows nothing rather than a raw object.
 */
function InspectionResults({
  calls,
  title,
  stepTitle,
  t,
  number,
  time,
  rateMetricKeys,
  locale,
}: {
  calls: readonly InspectionCall[];
  title: string;
  stepTitle: (toolKey: string) => string;
  t: (key: string, fallback: string) => string;
  number: Intl.NumberFormat;
  time: DateFormatterLike;
  rateMetricKeys: readonly string[];
  locale: string;
}) {
  return (
    <section data-testid="copilot-inspection" style={{ display: 'grid', gap: spacingTokens.sm }}>
      <h3 style={{ margin: 0, ...typographyTokens.label }}>{title}</h3>
      {calls.map((call) => (
        <div key={call.ordinal} style={{ display: 'grid', gap: 'var(--bsp-rem-0-25)' }}>
          <strong style={{ ...typographyTokens.bodySm }}>{stepTitle(call.toolKey)}</strong>
          {call.status !== 'SUCCEEDED' ? (
            <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
              {t(`copilot.toolStatus.${call.status}`, call.status)}
            </span>
          ) : (
            <InspectionLines
              call={call}
              t={t}
              number={number}
              time={time}
              rateMetricKeys={rateMetricKeys}
              locale={locale}
            />
          )}
        </div>
      ))}
    </section>
  );
}

/** PR B — a connection's status as the integrations screen words it. */
const CHANNEL_STATUS: Readonly<Record<string, string>> = {
  ACTIVE: 'active',
  NEEDS_REAUTH: 'needsReauth',
  DISABLED: 'disabled',
};

function InspectionLines({
  call,
  t,
  number,
  time,
  rateMetricKeys,
  locale: _locale,
}: {
  call: InspectionCall;
  rateMetricKeys: readonly string[];
  locale: string;
  t: (key: string, fallback: string) => string;
  number: Intl.NumberFormat;
  time: DateFormatterLike;
}) {
  const result = (call.result ?? {}) as Record<string, unknown>;
  const lines: string[] = [];
  const list = (key: string): Record<string, unknown>[] =>
    Array.isArray(result[key]) ? (result[key] as Record<string, unknown>[]) : [];

  switch (call.toolKey) {
    case 'analytics.summary':
      for (const metric of list('metrics')) {
        const key = String(metric['metricKey'] ?? '');
        const value = metric['value'];
        const label = t(`analytics.metric.${key}`, key);
        // A rate is parts per mille (47 is 4.7%) — never shown raw.
        const isRate = metric['unit'] === 'RATIO_MILLI' || rateMetricKeys.includes(key);
        const shown = isRate
          ? `${new Intl.NumberFormat('en-US', {
              maximumFractionDigits: 1,
              numberingSystem: 'latn',
            }).format(Number(value) / 10)}%`
          : number.format(Number(value));
        lines.push(
          typeof value === 'string'
            ? `${label}: ${shown}`
            : `${label}: ${t(`analytics.absent.${String(metric['absent'] ?? '')}`, t('analytics.noValue', '—'))}`,
        );
      }
      if (result['containsMockData'] === true) lines.push(t('analytics.mockNotice', ''));
      break;
    case 'brand.context':
      lines.push(
        t('copilot.inspection.brandContext', '').replace(
          '{items}',
          number.format(Number(result['knowledgeItems'] ?? 0)),
        ),
      );
      break;
    case 'content.search':
      for (const item of list('items').slice(0, 10)) {
        lines.push(
          `${String(item['title'] ?? '')} — ${t(`content.status.${String(item['status'])}`, String(item['status'] ?? ''))}`,
        );
      }
      break;
    case 'calendar.lookup':
      for (const slot of list('slots').slice(0, 10)) {
        const at = Date.parse(String(slot['scheduledAtUtc'] ?? ''));
        lines.push(
          `${Number.isNaN(at) ? '' : time.format(new Date(at))} — ${t(`content.status.${String(slot['status'])}`, String(slot['status'] ?? ''))}`,
        );
      }
      break;
    case 'campaign.list':
      for (const campaign of list('campaigns').slice(0, 10)) {
        lines.push(
          `${String(campaign['name'] ?? '')} — ${t(`campaigns.status.${String(campaign['status'])}`, String(campaign['status'] ?? ''))}`,
        );
      }
      break;
    case 'approvals.summary':
      // B14 — the counts first, then the oldest waiting posts.
      lines.push(
        t('copilot.inspection.approvals', '')
          .replace('{pending}', number.format(Number(result['pendingCount'] ?? 0)))
          .replace('{mine}', number.format(Number(result['assignedToYouCount'] ?? 0)))
          .replace('{anyone}', number.format(Number(result['unassignedCount'] ?? 0))),
      );
      for (const item of list('items').slice(0, 10)) {
        const at = Date.parse(String(item['requestedAt'] ?? ''));
        lines.push(
          `${String(item['title'] ?? '—')} — ${Number.isNaN(at) ? '' : time.format(new Date(at))}`,
        );
      }
      break;
    /*
     * PR B (D-594) — THE WORKSPACE READS. Every number with its period (or
     * "as of" for a count now) and the place it was read from, so a figure in
     * the conversation is always traceable to a screen.
     */
    case 'team.list':
      lines.push(
        t('copilot.inspection.team', '')
          .replace('{active}', number.format(Number(result['activeCount'] ?? 0)))
          .replace('{invited}', number.format(Number(result['invitedCount'] ?? 0))),
      );
      for (const member of list('members').slice(0, 20)) {
        lines.push(
          `${String(member['name'] ?? '—')} — ${String((member['role'] as Record<string, unknown> | undefined)?.[_locale === 'ar' ? 'ar' : 'en'] ?? member['roleKey'] ?? '')}${member['status'] === 'INVITED' ? ` (${t('copilot.inspection.invited', '')})` : ''}`,
        );
      }
      break;
    case 'credits.balance':
      if (typeof result['balanceCredits'] === 'number') {
        lines.push(
          t('copilot.inspection.creditsLeft', '').replace(
            '{credits}',
            number.format(result['balanceCredits']),
          ),
        );
      }
      if (typeof result['usedThisPeriodCredits'] === 'number') {
        lines.push(
          t('copilot.inspection.creditsUsed', '').replace(
            '{credits}',
            number.format(result['usedThisPeriodCredits']),
          ),
        );
      }
      break;
    case 'plan.summary':
      if (typeof result['planKey'] === 'string') {
        lines.push(
          t('copilot.inspection.plan', '')
            .replace(
              '{plan}',
              String(
                (result['planName'] as Record<string, unknown> | null | undefined)?.[
                  _locale === 'ar' ? 'ar' : 'en'
                ] ?? result['planKey'],
              ),
            )
            .replace(
              '{status}',
              t(`billing.status.${String(result['status'])}`, String(result['status'] ?? '')),
            ),
        );
      }
      if (typeof result['trialEndsAt'] === 'string' && result['status'] === 'TRIALING') {
        const at = Date.parse(result['trialEndsAt']);
        if (!Number.isNaN(at)) {
          lines.push(
            t('copilot.inspection.trialEnds', '').replace('{date}', time.format(new Date(at))),
          );
        }
      }
      break;
    case 'channels.list':
      lines.push(
        t('copilot.inspection.channels', '').replace(
          '{count}',
          number.format(Number(result['count'] ?? 0)),
        ),
      );
      for (const channel of list('channels').slice(0, 20)) {
        lines.push(
          `${String(channel['name'] ?? '')} — ${t(`integrations.provider.${String(channel['provider']).toLowerCase()}`, String(channel['provider'] ?? ''))} · ${t(`integrations.status.${CHANNEL_STATUS[String(channel['status'])] ?? 'active'}`, String(channel['status'] ?? ''))}`,
        );
      }
      break;
    case 'notifications.recent':
      lines.push(
        t('copilot.inspection.unread', '').replace(
          '{count}',
          number.format(Number(result['unreadCount'] ?? 0)),
        ),
      );
      break;
    default:
      break;
  }

  // PR B — where the numbers came from, and the period they cover.
  if (typeof result['source'] === 'string' && lines.length > 0) {
    const period = result['period'] as { from?: unknown; to?: unknown } | null | undefined;
    const from = typeof period?.from === 'string' ? Date.parse(period.from) : Number.NaN;
    const to = typeof period?.to === 'string' ? Date.parse(period.to) : Number.NaN;
    const asOf = typeof result['asOf'] === 'string' ? Date.parse(result['asOf']) : Number.NaN;
    const source = t(`copilot.source.${result['source']}`, String(result['source']));
    lines.push(
      !Number.isNaN(from)
        ? t('copilot.inspection.sourcePeriod', '')
            .replace('{source}', source)
            .replace('{from}', time.format(new Date(from)))
            .replace('{to}', Number.isNaN(to) ? '—' : time.format(new Date(to)))
        : t('copilot.inspection.sourceAsOf', '')
            .replace('{source}', source)
            .replace('{at}', Number.isNaN(asOf) ? '—' : time.format(new Date(asOf))),
    );
  }

  if (lines.length === 0) {
    return (
      <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
        {t('copilot.inspection.nothing', '')}
      </span>
    );
  }
  return (
    <ul style={{ margin: 0, paddingInlineStart: 'var(--bsp-rem-1)' }}>
      {lines.map((line, index) => (
        <li key={index} style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
          {line}
        </li>
      ))}
    </ul>
  );
}

/** A short, stable digest, so a double submission replays rather than re-pays. */
function digest(value: string): string {
  let out = 0;
  for (let index = 0; index < value.length; index += 1) {
    out = (out * 31 + value.charCodeAt(index)) >>> 0;
  }
  return out.toString(16).padStart(8, '0');
}

/** PR B — the Add card's words, in the reader's language. */
function sourceCardLabels(t: (key: MessageKey) => string): SourceCardLabels {
  return {
    askTitle: t('copilot.source.askTitle'),
    askBody: t('copilot.source.askBody'),
    add: t('copilot.source.add'),
    notNow: t('copilot.source.notNow'),
    uploading: t('copilot.source.uploading'),
    stage: {
      QUEUED: t('copilot.source.stage.queued'),
      EXTRACTING: t('copilot.source.stage.reading'),
      CHUNKING: t('copilot.source.stage.reading'),
      EXTRACTING_FACTS: t('copilot.source.stage.facts'),
      COMPLETED: t('copilot.source.stage.facts'),
      WHOLE: t('copilot.source.stage.whole'),
    },
    progressLabel: t('copilot.source.progressLabel'),
    coverage: t('copilot.source.coverage'),
    coverageNoSkips: t('copilot.source.coverageNoSkips'),
    coverageOne: t('copilot.source.coverageOne'),
    coverageNoSkipsOne: t('copilot.source.coverageNoSkipsOne'),
    todaysExtraction: t('copilot.source.todays'),
    approveOrReview: t('copilot.source.approveOrReview'),
    approveAll: t('copilot.source.approveAll'),
    review: t('copilot.source.review'),
    approved: t('copilot.source.approved'),
    failed: t('copilot.source.failed'),
    refused: t('copilot.source.refused'),
  };
}
