'use client';

import { useState } from 'react';
import {
  Banner,
  Button,
  Card,
  CopilotBody,
  SectionHeader,
  StateMessage,
  StatusBadge,
  colorTokens,
  inputStyle,
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
  readonly error?: { code?: string };
}

interface ExecutionResponse {
  readonly status?: string;
  readonly undoStatus?: string;
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

export function CopilotView({
  locale,
  brands,
  labels,
  creditsLabel,
}: {
  readonly locale: string;
  readonly brands: readonly CopilotBrand[];
  readonly labels: CopilotLabels;
  /** Omitted where no real balance can be read. Nothing is invented (§2.2). */
  readonly creditsLabel: string | null;
}) {
  /*
   * THE DICTIONARY IS RESOLVED HERE, FROM THE LOCALE — never handed in as a
   * function.
   *
   * A server component may pass this client component only SERIALIZABLE props,
   * and a translator is a closure: React refuses it at render time with
   * "Functions cannot be passed directly to Client Components", which takes the
   * whole screen down rather than degrading. The locale is a string, the
   * message catalogue is a module this bundle already contains, and the two
   * together give exactly the same text with nothing crossing the boundary that
   * cannot cross it.
   *
   * Every string this component renders is still a translation key — CLAUDE.md
   * §4 — and both languages still come from one catalogue.
   */
  const dictionary = locale === 'ar' ? catalogue.ar : catalogue.en;
  const t = (key: MessageKey): string => dictionary[key];

  const [brandId, setBrandId] = useState(brands[0]?.id ?? '');
  const [request, setRequest] = useState('');
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<readonly CopilotMessage[]>([]);
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [execution, setExecution] = useState<ExecutionResponse | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const post = async (path: string, body: unknown): Promise<unknown> => {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return response.json().catch(() => ({ error: { code: 'INTERNAL' } }));
  };

  const propose = async (): Promise<void> => {
    if (request.trim().length === 0 || busy) return;
    setBusy(true);
    setErrorCode(null);
    setExecution(null);
    try {
      const opened = (await post('/api/copilot/session', {
        brandId: brandId || null,
        surface: 'general',
        locale: locale === 'ar' ? 'AR' : 'EN',
      })) as { sessionId?: string; error?: { code?: string } };
      if (!opened.sessionId) {
        setErrorCode(opened.error?.code ?? 'INTERNAL');
        return;
      }

      setMessages((current) => [
        ...current,
        { id: `u-${current.length}`, author: 'user', text: request },
      ]);

      const result = (await post('/api/copilot/turn', {
        sessionId: opened.sessionId,
        brandId: brandId || null,
        request,
        // ONE KEY PER REQUEST TEXT, so a double click replays the first turn
        // rather than paying for a second.
        idempotencyKey: `copilot:${opened.sessionId}:${digest(request)}`,
      })) as PlanResponse;

      if (result.error?.code) {
        setErrorCode(result.error.code);
        return;
      }
      setPlan(result);
      setToken(result.confirmationToken ?? null);
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

  const tools: readonly CopilotToolRun[] = steps.map((step) => {
    const call = execution?.toolCalls?.find((entry) => entry.ordinal === step.ordinal);
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
    plan && plan.requiresConfirmation && !execution
      ? {
          id: plan.planId ?? 'plan',
          title: t('copilot.plan'),
          description: external ? t('copilot.externalWarning') : t('copilot.subtitle'),
          mutating: true,
          preview: steps.flatMap((step) =>
            step.preview.map((line) => ({
              label: t(line.labelKey as MessageKey),
              before: line.before,
              after: line.after,
            })),
          ),
        }
      : undefined;

  return (
    <div style={{ display: 'grid', gap: spacingTokens.lg }}>
      {/*
       * A REFUSAL IN THE READER'S LANGUAGE, NEVER A MACHINE CODE.
       *
       * `errorCode` is a code from a closed set that the SERVER chose; the
       * sentence is chosen here, from the same bilingual catalogue every other
       * string on this screen comes from. A code the catalogue does not know
       * renders the generic sentence rather than itself — which is what keeps a
       * provider message, a stack frame or a schema error off this banner
       * whatever a future error path does.
       */}
      {errorCode ? (
        <Banner tone="error" testId="copilot-error">
          {statusMessage(errorCode, locale) ?? t('copilot.failed')}
        </Banner>
      ) : null}

      <Card title={t('copilot.promptLabel')}>
        <div style={{ display: 'grid', gap: spacingTokens.sm }}>
          {brands.length > 1 ? (
            <label style={{ display: 'grid', gap: '0.25rem' }}>
              <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
                {t('analytics.brandLabel')}
              </span>
              <select
                className="bs-control"
                value={brandId}
                onChange={(event) => setBrandId(event.target.value)}
                data-testid="copilot-brand"
              >
                {brands.map((brand) => (
                  <option key={brand.id} value={brand.id}>
                    {brand.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <label style={{ display: 'grid', gap: '0.25rem' }}>
            <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
              {t('copilot.promptLabel')}
            </span>
            <input
              className="bs-control"
              style={inputStyle()}
              value={request}
              maxLength={2_000}
              placeholder={t('copilot.promptPlaceholder')}
              onChange={(event) => setRequest(event.target.value)}
              data-testid="copilot-request"
            />
          </label>

          <Button
            variant="brand"
            size="sm"
            onClick={() => void propose()}
            disabled={busy || request.trim().length === 0}
            data-testid="copilot-propose"
          >
            {t('copilot.send')}
          </Button>
        </div>
      </Card>

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
            description={`${t('copilot.estimatedCost')}: ${plan.estimatedCreditsMilli ?? '0'}`}
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
           * THE EXTERNAL WARNING IS ITS OWN BANNER, not a line in a list. A
           * plan that would leave the platform must not look like a plan that
           * would not, and a reader skimming a preview should meet that
           * difference before they meet the button.
           */}
          {external ? <Banner tone="warning">{t('copilot.externalWarning')}</Banner> : null}

          <ol style={{ display: 'grid', gap: spacingTokens.sm, paddingInlineStart: '1.25rem' }}>
            {steps.map((step) => (
              <li key={step.ordinal} style={{ ...typographyTokens.bodySm }}>
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
                        {t(line.labelKey as MessageKey)}: {line.after}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ol>

          {plan.requiresConfirmation && !execution ? (
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
                onClick={() => {
                  setPlan(null);
                  // THE TOKEN IS DROPPED ON CANCEL. A customer who said "no" must
                  // not still be holding a live credential for the plan they
                  // rejected.
                  setToken(null);
                }}
                disabled={busy}
                data-testid="copilot-reject"
              >
                {t('copilot.reject')}
              </Button>
              {plan.confirmationExpiresAt ? (
                <span style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}>
                  {t('copilot.confirmationExpires')}: {plan.confirmationExpiresAt}
                </span>
              ) : null}
            </div>
          ) : null}

          {execution ? (
            <div style={{ display: 'grid', gap: spacingTokens.sm }} data-testid="copilot-result">
              <StatusBadge tone="success" label={String(execution.status ?? '')} />
              {execution.undoStatus === 'AVAILABLE' ? (
                <Button
                  variant="neutral"
                  size="sm"
                  onClick={() => void undo()}
                  disabled={busy}
                  data-testid="copilot-undo"
                >
                  {t('copilot.undo')}
                </Button>
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
                        {t(`copilot.undoReason.${entry.reason}` as MessageKey)}
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
       * component the design showcase renders; what changed in Phase 7 is that
       * the data behind it is real.
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
          onReject={() => {
            setPlan(null);
            setToken(null);
          }}
          // The composer above is the real one; the shell's own field would be a
          // second place to type the same thing.
          disabled
        />
      </Card>
    </div>
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
