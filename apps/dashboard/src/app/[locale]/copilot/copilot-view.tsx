'use client';

import { useEffect, useState } from 'react';
import {
  Banner,
  Button,
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
  readonly error?: { code?: string };
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
  readonly error?: { code?: string };
}

/** Preview values that are machine keys, and the message stem that names them. */
const TRANSLATED_PREVIEW: Readonly<Record<string, string>> = {
  'copilot.preview.trigger': 'automations.trigger.',
  'copilot.preview.action': 'automations.action.',
  'copilot.preview.ruleEnabled': 'copilot.ruleEnabled.',
};

export function CopilotView({
  locale,
  brand,
  surface,
  labels,
  creditsLabel,
  subject = null,
  initialRequest = '',
}: {
  readonly locale: string;
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

  const number = new Intl.NumberFormat(locale === 'ar' ? 'ar' : 'en', {
    maximumFractionDigits: 2,
  });
  const time = new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

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
  const [now, setNow] = useState(() => Date.now());

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

  const propose = async (): Promise<void> => {
    if (request.trim().length === 0 || busy) return;
    setBusy(true);
    setErrorCode(null);
    setExecution(null);
    try {
      const active = await openSession();
      if (!active) return;

      setMessages((current) => [
        ...current,
        { id: `u-${current.length}`, author: 'user', text: request },
      ]);

      const result = (await post('/api/copilot/turn', {
        sessionId: active,
        // NO brandId. The session owns its brand; see the turn route (P7-R1).
        request,
        // ONE KEY PER REQUEST TEXT IN THIS CONVERSATION, so a double click
        // replays the first turn rather than paying for a second.
        idempotencyKey: `copilot:${active}:${digest(request)}`,
      })) as PlanResponse;

      if (result.error?.code) {
        // A conversation the server no longer admits (expired, or the brand
        // scope narrowed) is dropped, so the next request opens a fresh one.
        if (result.error.code === 'NOT_FOUND') setSessionId(null);
        setErrorCode(result.error.code);
        return;
      }
      setPlan(result);
      setToken(result.confirmationToken ?? null);
      setNow(Date.now());
      const summary = locale === 'ar' ? result.summary?.ar : result.summary?.en;
      if (summary) {
        setMessages((current) => [
          ...current,
          { id: `a-${current.length}`, author: 'assistant', text: summary },
        ]);
      }
      setRequest('');
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (): Promise<void> => {
    if (!plan?.planId || !plan.planHash || busy) return;
    setBusy(true);
    setErrorCode(null);
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
    try {
      const result = (await post('/api/copilot/undo', {
        planId: plan.planId,
      })) as ExecutionResponse;
      if (result.error?.code) {
        setErrorCode(result.error.code);
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
          {statusMessage(errorCode, locale) ?? t('copilot.failed')}
        </Banner>
      ) : null}

      {/*
        D-304 — ONE ASSISTANT, ONE COMPOSER. This used to be a card with its own
        "What would you like to get done?" field above the conversation, whose
        own composer then sat inert beneath it: two places to type one thing.
        Now the header states what the conversation is about, the plan and its
        results follow, and the one composer is the conversation's own.
      */}
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

      {plan && steps.length === 0 ? (
        <StateMessage kind="no-results" title={t('copilot.planEmpty')} />
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
                ? `${t('copilot.estimatedCost')}: ${number.format(costMilli / 1_000)} ${t(
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

          <ol style={{ display: 'grid', gap: spacingTokens.sm, paddingInlineStart: '1.25rem' }}>
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
                    <ul style={{ margin: 0, paddingInlineStart: '1rem' }}>
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
                style={{ margin: 0, paddingInlineStart: '1rem', ...typographyTokens.caption }}
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
                  <ul style={{ margin: 0, paddingInlineStart: '1rem' }}>
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
        <CopilotBody
          labels={labels}
          state={busy ? 'streaming' : proposedAction ? 'approval' : 'idle'}
          messages={messages}
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
}: {
  calls: readonly InspectionCall[];
  title: string;
  stepTitle: (toolKey: string) => string;
  t: (key: string, fallback: string) => string;
  number: Intl.NumberFormat;
  time: Intl.DateTimeFormat;
}) {
  return (
    <section data-testid="copilot-inspection" style={{ display: 'grid', gap: spacingTokens.sm }}>
      <h3 style={{ margin: 0, ...typographyTokens.label }}>{title}</h3>
      {calls.map((call) => (
        <div key={call.ordinal} style={{ display: 'grid', gap: '0.25rem' }}>
          <strong style={{ ...typographyTokens.bodySm }}>{stepTitle(call.toolKey)}</strong>
          {call.status !== 'SUCCEEDED' ? (
            <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
              {t(`copilot.toolStatus.${call.status}`, call.status)}
            </span>
          ) : (
            <InspectionLines call={call} t={t} number={number} time={time} />
          )}
        </div>
      ))}
    </section>
  );
}

function InspectionLines({
  call,
  t,
  number,
  time,
}: {
  call: InspectionCall;
  t: (key: string, fallback: string) => string;
  number: Intl.NumberFormat;
  time: Intl.DateTimeFormat;
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
        lines.push(
          typeof value === 'string'
            ? `${label}: ${number.format(Number(value))}`
            : `${label}: ${t(`analytics.absent.${String(metric['absent'] ?? '')}`, t('analytics.noValue', '—'))}`,
        );
      }
      if (result['containsMockData'] === true) lines.push(t('analytics.mockNotice', ''));
      break;
    case 'brand.context':
      lines.push(
        t('copilot.inspection.brandContext', '')
          .replace('{items}', number.format(Number(result['knowledgeItems'] ?? 0)))
          .replace('{chunks}', number.format(Number(result['documentChunks'] ?? 0))),
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
    default:
      break;
  }

  if (lines.length === 0) {
    return (
      <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
        {t('copilot.inspection.nothing', '')}
      </span>
    );
  }
  return (
    <ul style={{ margin: 0, paddingInlineStart: '1rem' }}>
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
