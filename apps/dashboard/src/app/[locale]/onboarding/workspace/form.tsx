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
import { timeZoneAfterCountryChange } from '../../../../components/time-zone-suggestion';

interface ApiFailurePayload {
  readonly error?: {
    readonly code?: unknown;
    readonly details?: {
      readonly fields?: unknown;
      readonly field?: unknown;
    };
  };
}

/** Only safe, server-declared field names are ever reflected back into copy. */
function validationFields(payload: ApiFailurePayload | null): string[] {
  const fields = payload?.error?.details?.fields;
  const field = payload?.error?.details?.field;
  if (Array.isArray(fields)) {
    return fields.filter((value): value is string => typeof value === 'string');
  }
  return typeof field === 'string' ? [field] : [];
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
  defaultEmail,
  countries,
  timezones,
  suggestedZones,
  cities = [],
  labels,
}: {
  locale: string;
  /** The signed-in customer's own address — a visible, editable suggestion. */
  defaultEmail: string;
  countries: readonly SearchableOption[];
  timezones: readonly SearchableOption[];
  /** Q7: each country's usual zone, preselected as a suggestion (still editable). */
  suggestedZones: Readonly<Record<string, string>>;
  /** G8 (D-335): Egypt's governorates, asked only when the country is Egypt. */
  cities?: readonly SearchableOption[];
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
    /** Q1: the owner's workspace allowance is used up. */
    limitReached: string;
    noResults: string;
    localeAr: string;
    localeEn: string;
    city?: string;
    cityNone?: string;
  };
}) {
  const [country, setCountry] = useState('');
  const [lastCountry, setLastCountry] = useState('');
  const [timezone, setTimezone] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({
    busy: false,
    error: null,
  });

  const fieldLabels: Readonly<Record<string, string>> = {
    name: labels.name,
    slug: labels.slug,
    country: labels.country,
    defaultLocale: labels.interfaceLocale,
    timezone: labels.timezone,
    billingEmail: labels.billingEmail,
    legalName: labels.legalName,
  };

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
            // G8 (D-335): Egypt only; cleared for any other country.
            ...(country === 'EG' && city !== '' ? { city } : {}),
            billingEmail: String(formData.get('billingEmail') ?? ''),
            legalName: String(formData.get('legalName') ?? '') || undefined,
          }),
        }).catch(() => null);

        if (!response?.ok) {
          const payload = (await response?.json().catch(() => null)) as ApiFailurePayload | null;
          const code = typeof payload?.error?.code === 'string' ? payload.error.code : '';
          const invalidFieldNames = [...new Set(validationFields(payload))]
            .map((field) => fieldLabels[field])
            .filter((label): label is string => Boolean(label));
          const invalidMessage =
            invalidFieldNames.length > 0
              ? labels.invalidFields.replace(
                  '{fields}',
                  invalidFieldNames.join(locale === 'ar' ? '، ' : ', '),
                )
              : labels.invalid;
          const message =
            code === 'VALIDATION_FAILED'
              ? invalidMessage
              : code === 'CONFLICT'
                ? labels.conflict
                : code === 'FORBIDDEN'
                  ? labels.forbidden
                  : code === 'QUOTA_EXCEEDED'
                    ? labels.limitReached
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
          onChange={(next) => {
            // Q7 — the country PRESELECTS its usual zone; one the person
            // picked themselves is never replaced (D-194 stands). Typing
            // clears the choice before a new one is picked, so the zone is
            // judged against the last country actually CHOSEN, not that blank.
            setCountry(next);
            if (next === '') return;
            setTimezone((current) =>
              timeZoneAfterCountryChange({
                previousCountry: lastCountry,
                nextCountry: next,
                currentZone: current,
                suggestions: suggestedZones,
              }),
            );
            setLastCountry(next);
          }}
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
          /*
           * THE LANGUAGE THE READER IS ALREADY USING, which is English unless
           * they asked for `/ar` (D-277). A visible, changeable preselection of
           * the interface language — not a business default: country, timezone
           * and billing currency are still never guessed (D-194).
           */
          defaultValue={locale === 'ar' ? 'AR' : 'EN'}
          style={authInputStyle()}
        >
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

      {country === 'EG' && cities.length > 0 && labels.city ? (
        <Field label={labels.city} htmlFor="city">
          <SearchableSelect
            id="city"
            name="city"
            options={cities}
            value={city}
            onChange={setCity}
            placeholder={labels.cityNone ?? labels.choose}
            noResultsLabel={labels.noResults}
            testId="city-select"
            style={authInputStyle()}
          />
        </Field>
      ) : null}

      <Field label={labels.billingEmail} htmlFor="billingEmail" required>
        <input
          className="bs-control"
          id="billingEmail"
          name="billingEmail"
          type="email"
          required
          defaultValue={defaultEmail}
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
