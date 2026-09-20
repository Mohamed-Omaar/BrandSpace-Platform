'use client';

import { useState } from 'react';
import {
  Field,
  SearchableSelect,
  colorTokens,
  spacingTokens,
  typographyTokens,
  type SearchableOption,
} from '@brandspace/ui';
import { authButtonStyle, authInputStyle } from '../../../../components/auth-card';

type FailureKind = 'generic' | 'invalid' | 'conflict' | 'forbidden';

interface FailureState {
  readonly kind: FailureKind;
  readonly fields: readonly string[];
}

/**
 * First-workspace onboarding asks only for facts the customer actually owns.
 *
 * Country and timezone are controlled vocabularies: the visible controls are
 * searchable, but only the canonical ISO country code / IANA zone is submitted.
 * Billing currency is deliberately absent; the API owns the launch USD default.
 */
export function CreateWorkspaceForm({
  locale,
  countries,
  timezones,
  labels,
}: {
  locale: string;
  countries: readonly SearchableOption[];
  timezones: readonly SearchableOption[];
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
    invalidFields: string;
    conflict: string;
    forbidden: string;
    noResults: string;
    localeAr: string;
    localeEn: string;
  };
}) {
  const [country, setCountry] = useState('');
  const [timezone, setTimezone] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle');
  const [failure, setFailure] = useState<FailureState>({ kind: 'generic', fields: [] });

  const fieldLabels: Readonly<Record<string, string>> = {
    name: labels.name,
    slug: labels.slug,
    country: labels.country,
    defaultLocale: labels.interfaceLocale,
    timezone: labels.timezone,
    billingEmail: labels.billingEmail,
    legalName: labels.legalName,
  };

  const invalidFieldNames = [...new Set(failure.fields)]
    .map((field) => fieldLabels[field])
    .filter((label): label is string => Boolean(label));

  const failureText =
    failure.kind === 'invalid'
      ? invalidFieldNames.length > 0
        ? labels.invalidFields.replace(
            '{fields}',
            invalidFieldNames.join(locale === 'ar' ? '، ' : ', '),
          )
        : labels.invalid
      : failure.kind === 'conflict'
        ? labels.conflict
        : failure.kind === 'forbidden'
          ? labels.forbidden
          : labels.failed;

  return (
    <form
      data-testid="create-workspace-form"
      onSubmit={async (event) => {
        event.preventDefault();
        setState('busy');
        setFailure({ kind: 'generic', fields: [] });

        const form = new FormData(event.currentTarget);
        const response = await fetch('/api/onboarding/workspace', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: String(form.get('name') ?? ''),
            slug: String(form.get('slug') ?? ''),
            country,
            defaultLocale: String(form.get('defaultLocale') ?? ''),
            timezone,
            billingEmail: String(form.get('billingEmail') ?? ''),
            legalName: String(form.get('legalName') ?? '') || undefined,
          }),
        }).catch(() => null);

        if (!response?.ok) {
          const payload = (response ? await response.json().catch(() => null) : null) as
            | {
                error?: {
                  code?: unknown;
                  details?: {
                    fields?: unknown;
                    field?: unknown;
                  };
                };
              }
            | null;

          const code = typeof payload?.error?.code === 'string' ? payload.error.code : '';
          const detailFields = payload?.error?.details?.fields;
          const detailField = payload?.error?.details?.field;
          const fields = Array.isArray(detailFields)
            ? detailFields.filter((field): field is string => typeof field === 'string')
            : typeof detailField === 'string'
              ? [detailField]
              : [];

          setFailure({
            kind:
              code === 'VALIDATION_FAILED'
                ? 'invalid'
                : code === 'CONFLICT'
                  ? 'conflict'
                  : code === 'FORBIDDEN'
                    ? 'forbidden'
                    : 'generic',
            fields,
          });
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
        <SearchableSelect
          id="country"
          name="country"
          options={countries}
          value={country}
          onChange={setCountry}
          placeholder={labels.choose}
          noResultsLabel={labels.noResults}
          required
          testId="country-select"
          style={authInputStyle()}
        />
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
        <SearchableSelect
          id="timezone"
          name="timezone"
          options={timezones}
          value={timezone}
          onChange={setTimezone}
          placeholder={labels.choose}
          noResultsLabel={labels.noResults}
          required
          testId="timezone-select"
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
        disabled={state === 'busy' || country === '' || timezone === ''}
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
