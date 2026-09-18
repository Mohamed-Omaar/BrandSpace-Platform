'use client';

import { useState, type CSSProperties } from 'react';
import { colorTokens, spacingTokens, typographyTokens } from '@brandspace/ui';
import {
  customerButtonStyle,
  customerInputStyle,
  customerSecondaryButtonStyle,
} from '../../../components/workspace-shell';

/**
 * The commercial actions, as client components.
 *
 * NONE OF THEM SENDS AN AMOUNT. Each posts a KEY — a plan key, an interval, a
 * pack key — and the server resolves the price from the activated catalogue.
 * There is no field here that could carry a price, which is the only durable
 * form of "a customer cannot alter what they are charged" (§37).
 *
 * AND NONE OF THEM MARKS ANYTHING PAID. The successful response is a URL the
 * browser is sent to; what happens after that is decided by a signed provider
 * event and reported by the checkout status page (§22).
 */

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** A stable key per click, so a double-submit opens ONE checkout. */
function idempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

export function BuyPlanButton({
  locale,
  planKey,
  billingInterval,
  label,
  busyLabel,
  failedLabel,
  redirectNotice,
  disabled,
  testId,
}: {
  locale: string;
  planKey: string;
  billingInterval: 'MONTH' | 'YEAR';
  label: string;
  busyLabel: string;
  failedLabel: string;
  redirectNotice: string;
  disabled?: boolean;
  testId?: string;
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle');

  return (
    <div style={{ display: 'grid', gap: spacingTokens.xs }}>
      <button
        type="button"
        data-testid={testId}
        disabled={disabled || state === 'busy'}
        style={customerButtonStyle()}
        onClick={async () => {
          setState('busy');
          const response = await post('/api/commerce/checkout/subscription', {
            planKey,
            billingInterval,
            idempotencyKey: idempotencyKey(),
            // Navigation only: which localized route the provider returns to.
            locale: locale === 'ar' ? 'ar' : 'en',
          }).catch(() => null);
          const payload = (await response?.json().catch(() => null)) as {
            redirectUrl?: string;
          } | null;
          if (!response?.ok || !payload?.redirectUrl) {
            setState('failed');
            return;
          }
          // THE PROVIDER'S OWN PAGE. No card field exists anywhere in this app.
          globalThis.location.assign(payload.redirectUrl);
        }}
      >
        {state === 'busy' ? busyLabel : label}
      </button>
      <p
        style={noticeStyle}
        {...(state === 'failed'
          ? { role: 'alert' as const, 'data-testid': 'checkout-failed' }
          : {})}
      >
        {state === 'failed' ? failedLabel : redirectNotice}
      </p>
    </div>
  );
}

export function BuyPackButton({
  locale,
  packKey,
  label,
  busyLabel,
  failedLabel,
  testId,
}: {
  locale: string;
  packKey: string;
  label: string;
  busyLabel: string;
  failedLabel: string;
  testId?: string;
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle');
  return (
    <>
      <button
        type="button"
        data-testid={testId}
        disabled={state === 'busy'}
        style={customerButtonStyle()}
        onClick={async () => {
          setState('busy');
          const response = await post('/api/commerce/checkout/pack', {
            packKey,
            idempotencyKey: idempotencyKey(),
            locale: locale === 'ar' ? 'ar' : 'en',
          }).catch(() => null);
          const payload = (await response?.json().catch(() => null)) as {
            redirectUrl?: string;
          } | null;
          if (!response?.ok || !payload?.redirectUrl) {
            setState('failed');
            return;
          }
          globalThis.location.assign(payload.redirectUrl);
        }}
      >
        {state === 'busy' ? busyLabel : label}
      </button>
      {state === 'failed' ? (
        <p role="alert" data-testid="checkout-failed" style={noticeStyle}>
          {failedLabel}
        </p>
      ) : null}
    </>
  );
}

/**
 * Schedule a downgrade.
 *
 * SEPARATE FROM THE UPGRADE BUTTON, because it does something different: it
 * takes no payment and changes nothing today. Presenting both as "choose this
 * plan" would tell the customer the same story about two different outcomes.
 */
export function ScheduleDowngradeButton({
  planKey,
  label,
  busyLabel,
  testId,
}: {
  planKey: string;
  label: string;
  busyLabel: string;
  testId?: string;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={busy}
      style={customerSecondaryButtonStyle()}
      onClick={async () => {
        setBusy(true);
        await post('/api/commerce/subscription/downgrade', { planKey }).catch(() => null);
        globalThis.location.reload();
      }}
    >
      {busy ? busyLabel : label}
    </button>
  );
}

export function SimpleActionButton({
  path,
  label,
  busyLabel,
  testId,
  variant = 'secondary',
}: {
  path: string;
  label: string;
  busyLabel: string;
  testId?: string;
  variant?: 'primary' | 'secondary';
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={busy}
      style={variant === 'primary' ? customerButtonStyle() : customerSecondaryButtonStyle()}
      onClick={async () => {
        setBusy(true);
        await post(path, {}).catch(() => null);
        globalThis.location.reload();
      }}
    >
      {busy ? busyLabel : label}
    </button>
  );
}

/**
 * Cancelling, behind an explicit confirmation.
 *
 * TWO DELIBERATE ELEMENTS: a written reason and a checkbox that has to be
 * ticked. CLAUDE.md §2.5 makes this a high-impact action, and the copy states
 * what cancelling does and does NOT do — access continues to the end of the paid
 * period, and nothing is deleted.
 */
export function CancelSubscriptionForm({
  title,
  body,
  reasonLabel,
  confirmLabel,
  submitLabel,
  busyLabel,
}: {
  title: string;
  body: string;
  reasonLabel: string;
  confirmLabel: string;
  submitLabel: string;
  busyLabel: string;
}) {
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <form
      data-testid="cancel-subscription"
      style={{ display: 'grid', gap: spacingTokens.sm }}
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        await post('/api/commerce/subscription/cancel', { reason, confirm: true }).catch(
          () => null,
        );
        globalThis.location.reload();
      }}
    >
      <p style={{ margin: 0, ...typographyTokens.bodySm }}>{title}</p>
      <p style={noticeStyle}>{body}</p>
      <label style={{ display: 'grid', gap: spacingTokens.xs, ...typographyTokens.bodySm }}>
        {reasonLabel}
        <input
          className="bs-control"
          name="reason"
          required
          minLength={4}
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          style={customerInputStyle()}
        />
      </label>
      <label
        style={{
          display: 'flex',
          gap: spacingTokens.xs,
          alignItems: 'center',
          ...typographyTokens.bodySm,
        }}
      >
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        {confirmLabel}
      </label>
      <button
        type="submit"
        data-testid="cancel-subscription-submit"
        disabled={!confirmed || reason.trim().length < 4 || busy}
        style={customerSecondaryButtonStyle()}
      >
        {busy ? busyLabel : submitLabel}
      </button>
    </form>
  );
}

const noticeStyle: CSSProperties = {
  margin: 0,
  ...typographyTokens.caption,
  color: colorTokens.textMuted,
};
