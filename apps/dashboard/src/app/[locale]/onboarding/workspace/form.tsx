'use client';

import { useMemo, useState } from 'react';
import { Field, colorTokens, spacingTokens, typographyTokens } from '@brandspace/ui';
import { authButtonStyle, authInputStyle } from '../../../../components/auth-card';

export interface MarketOption {
  readonly country: string;
  readonly name: string;
  readonly currencies: ReadonlyArray<{ readonly code: string; readonly name: string }>;
}

/**
 * The four answers, asked plainly.
 *
 * NOTHING IS PRESELECTED (D-194). Both selects open on an empty "Choose…"
 * option, so a customer who submits without looking cannot be given a country
 * and a currency by accident. That is the whole point: a default here IS the
 * assumption the decision removed.
 *
 * THE COUNTRY NARROWS THE CURRENCY LIST AND DOES NOT PICK FROM IT. Choosing a
 * country filters the currencies to the ones that market offers; the customer
 * still chooses. When the narrowed list holds exactly one, it is still theirs to
 * select — an automatic pick would be the same silent inference wearing a
 * convenience.
 *
 * AND THE RELATIONSHIP IS NOT IN THIS COMPONENT. It arrives as data from the
 * activated `commerce` document, so adding a market or a currency is a
 * configuration change (§4).
 */
export function CreateWorkspaceForm({
  locale,
  markets,
  labels,
}: {
  locale: string;
  markets: readonly MarketOption[];
  labels: {
    name: string;
    slug: string;
    country: string;
    countryHint: string;
    currency: string;
    currencyHint: string;
    interfaceLocale: string;
    timezone: string;
    billingEmail: string;
    legalName: string;
    choose: string;
    submit: string;
    submitting: string;
    failed: string;
    localeAr: string;
    localeEn: string;
  };
}) {
  const [country, setCountry] = useState('');
  const [currency, setCurrency] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle');

  const currencies = useMemo(
    () => markets.find((market) => market.country === country)?.currencies ?? [],
    [markets, country],
  );

  return (
    <form
      data-testid="create-workspace-form"
      onSubmit={async (event) => {
        event.preventDefault();
        setState('busy');
        const form = new FormData(event.currentTarget);
        const response = await fetch('/api/onboarding/workspace', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: String(form.get('name') ?? ''),
            slug: String(form.get('slug') ?? ''),
            country,
            currency,
            defaultLocale: String(form.get('defaultLocale') ?? ''),
            timezone: String(form.get('timezone') ?? ''),
            billingEmail: String(form.get('billingEmail') ?? ''),
            legalName: String(form.get('legalName') ?? '') || undefined,
          }),
        }).catch(() => null);

        if (!response?.ok) {
          setState('failed');
          return;
        }
        globalThis.location.assign(`/${locale}/onboarding`);
      }}
    >
      <Field label={labels.name} htmlFor="name" required>
        <input
          className="bs-control"
          id="name"
          name="name"
          required
          maxLength={120}
          style={authInputStyle()}
        />
      </Field>

      <Field label={labels.slug} htmlFor="slug" required>
        <input
          className="bs-control"
          id="slug"
          name="slug"
          required
          pattern="[a-z0-9][a-z0-9-]{1,48}[a-z0-9]"
          maxLength={50}
          style={authInputStyle()}
        />
      </Field>

      <Field label={labels.country} htmlFor="country" required hint={labels.countryHint}>
        <select
          className="bs-control"
          id="country"
          name="country"
          required
          value={country}
          data-testid="country-select"
          onChange={(event) => {
            setCountry(event.target.value);
            // The previous currency may not be offered here. Cleared rather
            // than re-picked, so the customer answers again.
            setCurrency('');
          }}
          style={authInputStyle()}
        >
          <option value="">{labels.choose}</option>
          {markets.map((market) => (
            <option key={market.country} value={market.country}>
              {market.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label={labels.currency} htmlFor="currency" required hint={labels.currencyHint}>
        <select
          className="bs-control"
          id="currency"
          name="currency"
          required
          value={currency}
          disabled={country === ''}
          data-testid="currency-select"
          onChange={(event) => setCurrency(event.target.value)}
          style={authInputStyle()}
        >
          <option value="">{labels.choose}</option>
          {currencies.map((option) => (
            <option key={option.code} value={option.code}>
              {option.code} — {option.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label={labels.interfaceLocale} htmlFor="defaultLocale" required>
        <select
          className="bs-control"
          id="defaultLocale"
          name="defaultLocale"
          required
          style={authInputStyle()}
        >
          <option value="">{labels.choose}</option>
          <option value="AR">{labels.localeAr}</option>
          <option value="EN">{labels.localeEn}</option>
        </select>
      </Field>

      <Field label={labels.timezone} htmlFor="timezone" required>
        <input
          className="bs-control"
          id="timezone"
          name="timezone"
          required
          maxLength={64}
          placeholder="Europe/London"
          style={authInputStyle()}
        />
      </Field>

      <Field label={labels.billingEmail} htmlFor="billingEmail" required>
        <input
          className="bs-control"
          id="billingEmail"
          name="billingEmail"
          type="email"
          required
          style={authInputStyle()}
        />
      </Field>

      <Field label={labels.legalName} htmlFor="legalName">
        <input
          className="bs-control"
          id="legalName"
          name="legalName"
          maxLength={200}
          style={authInputStyle()}
        />
      </Field>

      <button
        type="submit"
        data-testid="create-workspace-submit"
        disabled={state === 'busy' || country === '' || currency === ''}
        style={authButtonStyle()}
      >
        {state === 'busy' ? labels.submitting : labels.submit}
      </button>

      {state === 'failed' ? (
        <p
          role="alert"
          data-testid="create-workspace-error"
          style={{
            marginBlockStart: spacingTokens.sm,
            ...typographyTokens.caption,
            color: colorTokens.textMuted,
          }}
        >
          {labels.failed}
        </p>
      ) : null}
    </form>
  );
}
