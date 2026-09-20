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
    conflict: string;
    forbidden: string;
    localeAr: string;
    localeEn: string;
  };
}) {
  const [country, setCountry] = useState('');
  const [timezone, setTimezone] = useState('');
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({
    busy: false,
    error: null,
  });

  return (
    <form
      data-testid="create-workspace-form"
      onSubmit={async (event) => {
        event.preventDefault();
        setState({ busy: true, error: null });
        const formData = new FormData(event.currentTarget);
        const response = await fetch('/api/onboarding/workspace', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: String(formData.get('name') ?? ''),
            slug: String(formData.get('slug') ?? ''),
            country,
            defaultLocale: String(formData.get('defaultLocale') ?? ''),
            timezone,
            billingEmail: String(formData.get('billingEmail') ?? ''),
            legalName: String(formData.get('legalName') ?? '') || undefined,
          }),
        }).catch(() => null);

        if (!response?.ok) {
          const payload = (await response?.json().catch(() => null)) as
            | { error?: { code?: string } }
            | null;
          const code = payload?.error?.code;
          const message =
            code === 'VALIDATION_FAILED'
              ? labels.invalid
              : code === 'CONFLICT'
                ? labels.conflict
                : code === 'FORBIDDEN'
                  ? labels.forbidden
                  : labels.failed;
          setState({ busy: false, error: message });
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
        <SearchableSelect
          id="country"
          name="country"
          options={countries}
          value={country}
          onChange={setCountry}
          placeholder={labels.choose}
          noResultsLabel={labels.invalid}
          required
          testId="country-select"
          style={authInputStyle()}
        />
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
        <SearchableSelect
          id="timezone"
          name="timezone"
          options={timezones}
          value={timezone}
          onChange={setTimezone}
          placeholder={labels.choose}
          noResultsLabel={labels.invalid}
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
        disabled={state.busy || country === '' || timezone === ''}
        style={authButtonStyle()}
      >
        {state.busy ? labels.submitting : labels.submit}
      </button>

      {state.error ? (
        <p
          role="alert"
          data-testid="create-workspace-error"
          style={{
            marginBlockStart: spacingTokens.sm,
            ...typographyTokens.caption,
            color: colorTokens.danger,
          }}
        >
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
