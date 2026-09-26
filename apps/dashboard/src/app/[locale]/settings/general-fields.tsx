'use client';

import { useEffect, useState } from 'react';
import {
  Banner,
  Field,
  SearchableSelect,
  inputStyle,
  spacingTokens,
  type SearchableOption,
} from '@brandspace/ui';
import { IndustryField } from '../../../components/industry-field';
import { timeZoneAfterCountryChange } from '../../../components/time-zone-suggestion';

/**
 * SETTINGS → GENERAL, THE FIELDS (A9, D-330).
 *
 * Client-side only for what the person sees while choosing: the country
 * preselects its usual time zone (Q7 — a zone they picked themselves is never
 * replaced), the city is asked only for Egypt, and "Something else" opens a
 * free-text industry (`IndustryField`, shared with the setup wizard). Every
 * rule is enforced again by the server action.
 *
 * Rendered inside a `DraftForm`, which re-mounts these fields on Cancel — so
 * the state below starts again from the saved values.
 */

export interface GeneralFieldsLabels {
  readonly name: string;
  readonly nameHint: string;
  readonly locale: string;
  readonly localeHint: string;
  readonly localeAr: string;
  readonly localeEn: string;
  readonly country: string;
  readonly countryHint: string;
  readonly timezone: string;
  readonly timezoneHint: string;
  readonly city: string;
  readonly cityHint: string;
  readonly cityNone: string;
  readonly weekStart: string;
  readonly weekStartHint: string;
  readonly industry: string;
  readonly industryHint: string;
  readonly industryNone: string;
  readonly industryOther: string;
  readonly industryOtherLabel: string;
  readonly website: string;
  readonly websiteHint: string;
  readonly choose: string;
  readonly noResults: string;
  /** G5 / Q22: said before saving a new zone. `{count}` is filled in. */
  readonly timezoneKept: string;
  readonly timezoneUnplanned: string;
}

/** What `/api/settings/timezone-preview` answers. */
interface TimezonePreview {
  readonly kept: number;
  readonly unplanned: readonly { readonly title: string; readonly localTime: string }[];
}

export function GeneralFields({
  saved,
  countries,
  timezones,
  cities,
  weekdays,
  industries,
  suggestedZones,
  brand,
  labels,
}: {
  readonly saved: {
    readonly name: string;
    readonly defaultLocale: string;
    readonly country: string;
    readonly timezone: string;
    readonly city: string | null;
    readonly weekStartsOn: number;
  };
  readonly countries: readonly SearchableOption[];
  readonly timezones: readonly SearchableOption[];
  readonly cities: readonly SearchableOption[];
  /** Index = weekday, 0 = Sunday, named in the reader's language. */
  readonly weekdays: readonly string[];
  /** The activated industry catalogue, in the reader's language. Empty = free text only. */
  readonly industries: readonly SearchableOption[];
  readonly suggestedZones: Readonly<Record<string, string>>;
  /** The sole brand's fields — only while multi-brand is off and the member holds `brand.manage`. */
  readonly brand: {
    readonly brandId: string;
    readonly industry: string | null;
    readonly websiteUrl: string | null;
  } | null;
  readonly labels: GeneralFieldsLabels;
}) {
  const [country, setCountry] = useState(saved.country);
  const [lastCountry, setLastCountry] = useState(saved.country);
  const [timezone, setTimezone] = useState(saved.timezone);
  /*
   * G5 / Q22 (D-334) — BEFORE SAVING A NEW ZONE, what it would do: planned
   * posts keep their local time, and any that would then be in the past or too
   * soon are listed, because they go back to planned. Asked of the server,
   * which answers from the same rule the save applies.
   */
  const [preview, setPreview] = useState<TimezonePreview | null>(null);
  useEffect(() => {
    if (timezone === '' || timezone === saved.timezone) {
      setPreview(null);
      return;
    }
    const controller = new AbortController();
    fetch(`/api/settings/timezone-preview?zone=${encodeURIComponent(timezone)}`, {
      signal: controller.signal,
    })
      .then(async (response) => (response.ok ? ((await response.json()) as TimezonePreview) : null))
      .then(setPreview)
      .catch(() => undefined);
    return () => controller.abort();
  }, [timezone, saved.timezone]);

  return (
    <>
      <Field label={labels.name} htmlFor="name" hint={labels.nameHint}>
        <input
          className="bs-control"
          id="name"
          name="name"
          defaultValue={saved.name}
          required
          maxLength={120}
          style={inputStyle()}
        />
      </Field>

      <div className="bs-form-row">
        <Field label={labels.country} htmlFor="country" hint={labels.countryHint}>
          <SearchableSelect
            id="country"
            name="country"
            options={countries}
            value={country}
            onChange={(next) => {
              // Typing clears the choice before a new one is picked; the zone is
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
            testId="settings-country"
          />
        </Field>

        <Field label={labels.timezone} htmlFor="timezone" hint={labels.timezoneHint}>
          <SearchableSelect
            id="timezone"
            name="timezone"
            options={timezones}
            value={timezone}
            onChange={setTimezone}
            placeholder={labels.choose}
            noResultsLabel={labels.noResults}
            required
            testId="settings-timezone"
          />
        </Field>
      </div>

      {preview && (preview.kept > 0 || preview.unplanned.length > 0) ? (
        <Banner tone="warning" testId="settings-timezone-warning">
          <div style={{ display: 'grid', gap: spacingTokens.xs }}>
            {preview.kept > 0 ? (
              <span>{labels.timezoneKept.replace('{count}', String(preview.kept))}</span>
            ) : null}
            {preview.unplanned.length > 0 ? (
              <>
                <span>{labels.timezoneUnplanned}</span>
                <ul
                  style={{ margin: 0, paddingInlineStart: spacingTokens.md }}
                  data-testid="settings-timezone-unplanned"
                >
                  {preview.unplanned.map((post) => (
                    <li key={`${post.title}-${post.localTime}`}>
                      <bdi>{post.title}</bdi> — {post.localTime.replace('T', ' ')}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>
        </Banner>
      ) : null}

      {country === 'EG' ? (
        <Field label={labels.city} htmlFor="city" hint={labels.cityHint}>
          <SearchableSelect
            id="city"
            name="city"
            options={cities}
            defaultValue={saved.city ?? ''}
            placeholder={labels.cityNone}
            noResultsLabel={labels.noResults}
            testId="settings-city"
          />
        </Field>
      ) : null}

      <div className="bs-form-row">
        <Field label={labels.locale} htmlFor="defaultLocale" hint={labels.localeHint}>
          <select
            className="bs-control bs-select"
            id="defaultLocale"
            name="defaultLocale"
            defaultValue={saved.defaultLocale}
            style={inputStyle()}
          >
            <option value="AR">{labels.localeAr}</option>
            <option value="EN">{labels.localeEn}</option>
          </select>
        </Field>

        <Field label={labels.weekStart} htmlFor="weekStartsOn" hint={labels.weekStartHint}>
          <select
            className="bs-control bs-select"
            id="weekStartsOn"
            name="weekStartsOn"
            data-testid="settings-week-start"
            defaultValue={String(saved.weekStartsOn)}
            style={inputStyle()}
          >
            {weekdays.map((day, index) => (
              <option key={index} value={index}>
                {day}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {brand ? (
        <>
          <input type="hidden" name="brandId" value={brand.brandId} />
          <div className="bs-form-row">
            <IndustryField
              industries={industries}
              saved={brand.industry}
              labels={labels}
              idPrefix=""
              testIdPrefix="settings"
            />
            <Field label={labels.website} htmlFor="websiteUrl" hint={labels.websiteHint}>
              <input
                className="bs-control"
                id="websiteUrl"
                name="websiteUrl"
                type="url"
                inputMode="url"
                data-testid="settings-website"
                defaultValue={brand.websiteUrl ?? ''}
                maxLength={2048}
                style={inputStyle()}
              />
            </Field>
          </div>
        </>
      ) : null}
    </>
  );
}
