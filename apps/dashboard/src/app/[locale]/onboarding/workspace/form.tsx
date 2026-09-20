'use client';

import { useId, useState } from 'react';
import { Field, colorTokens, spacingTokens, typographyTokens } from '@brandspace/ui';
import { authButtonStyle, authInputStyle } from '../../../../components/auth-card';

export interface CountryOption {
  readonly code: string;
  readonly name: string;
}

type FailureKind = 'generic' | 'invalid' | 'conflict' | 'forbidden';

/**
 * First-workspace onboarding asks only for facts the customer actually owns.
 *
 * Country is a complete ISO list, not the subset that happens to have a payment
 * route today. Billing currency is deliberately absent: launch billing is USD
 * and the API owns that default. Timezone uses a datalist so the customer can
 * search the IANA inventory instead of typing an opaque identifier from memory.
 */
export function CreateWorkspaceForm({
  locale,
  countries,
  timezones,
  labels,
}: {
  locale: string;
  countries: readonly CountryOption[];
  timezones: readonly string[];
  labels: {
    name: string;
    slug: string;
    country: string;
    countryHint: string;
    interfaceLocale: string;
    timezone: string;
    billingEmail: string;
    legalName: string;
    choose: string;
    submit: string;
    submitting: string;
    failed: string;
    invalid: string;
    conflict: string;
    forbidden: string;
    localeAr: string;
    localeEn: string;
  };
}) {
  const [country, setCountry] = useState('');
  const [countryQuery, setCountryQuery] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle');
  const [failure, setFailure] = useState<FailureKind>('generic');
  const countryListId = useId();
  const timezoneListId = useId();

  const failureText =
    failure === 'invalid'
      ? labels.invalid
      : failure === 'conflict'
        ? labels.conflict
        : failure === 'forbidden'
          ? labels.forbidden
          : labels.failed;

  return (
    <form
      data-testid="create-workspace-form"
      onSubmit={async (event) => {
        event.preventDefault();
        setState('busy');
        setFailure('generic');

        const form = new FormData(event.currentTarget);
        const response = await fetch('/api/onboarding/workspace', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: String(form.get('name') ?? ''),
            slug: String(form.get('slug') ?? ''),
            country,
            defaultLocale: String(form.get('defaultLocale') ?? ''),
            timezone: String(form.get('timezone') ?? ''),
            billingEmail: String(form.get('billingEmail') ?? ''),
            legalName: String(form.get('legalName') ?? '') || undefined,
          }),
        }).catch(() => null);

        if (!response?.ok) {
          const payload = response
            ? await response.json().catch(() => null)
            : null;
          const code =
            payload &&
            typeof payload === 'object' &&
            'error' in payload &&
            payload.error &&
            typeof payload.error === 'object' &&
            'code' in payload.error
              ? String(payload.error.code)
              : '';

          setFailure(
            code === 'VALIDATION_FAILED'
              ? 'invalid'
              : code === 'CONFLICT'
                ? 'conflict'
                : code === 'FORBIDDEN'
                  ? 'forbidden'
                  : 'generic',
          );
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
          autoComplete="organization"
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
          autoCapitalize="none"
          spellCheck={false}
          style={authInputStyle()}
        />
      </Field>

      <Field label={labels.country} htmlFor="country" required hint={labels.countryHint}>
        <input
          className="bs-control"
          id="country"
          name="countryDisplay"
          required
          value={countryQuery}
          list={countryListId}
          data-testid="country-select"
          placeholder={labels.choose}
          autoComplete="off"
          onChange={(event) => {
            const value = event.target.value;
            setCountryQuery(value);
            const normalised = value.trim().toLocaleLowerCase();
            const match = countries.find(
              (option) =>
                option.code.toLocaleLowerCase() === normalised ||
                option.name.toLocaleLowerCase() === normalised,
            );
            setCountry(match?.code ?? '');
          }}
          style={authInputStyle()}
        />
        <datalist id={countryListId}>
          {countries.map((option) => (
            <option key={option.code} value={option.name} label={option.code} />
          ))}
        </datalist>
      </Field>

      <Field label={labels.interfaceLocale} htmlFor="defaultLocale" required>
        <select
          className="bs-control bs-select"
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
          list={timezoneListId}
          placeholder="Asia/Riyadh"
          autoComplete="off"
          style={authInputStyle()}
        />
        <datalist id={timezoneListId}>
          {timezones.map((timezone) => (
            <option key={timezone} value={timezone} />
          ))}
        </datalist>
      </Field>

      <Field label={labels.billingEmail} htmlFor="billingEmail" required>
        <input
          className="bs-control"
          id="billingEmail"
          name="billingEmail"
          type="email"
          required
          autoComplete="email"
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
        disabled={state === 'busy' || country === ''}
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
            color: colorTokens.danger,
          }}
        >
          {failureText}
        </p>
      ) : null}
    </form>
  );
}
