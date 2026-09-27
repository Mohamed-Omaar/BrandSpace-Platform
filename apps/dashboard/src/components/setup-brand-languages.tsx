'use client';

import { useEffect, useRef, useState } from 'react';
import { Field, inputStyle, spacingTokens, typographyTokens } from '@brandspace/ui';

/**
 * THE SETUP WIZARD'S LANGUAGE FIELDS (D-331, D-335).
 *
 * The languages the brand publishes in, and the language its AI writes in. At
 * least one publishing language is required — the first box carries the
 * browser's own validity message while none is ticked, so the form cannot be
 * sent without one. When exactly one is ticked the AI language follows it,
 * because a brand that publishes only in Arabic should not get English drafts;
 * `setupBrandFrom` applies the same rule on the server, which is the one that
 * counts.
 */
type Code = 'EN' | 'AR';

export function SetupBrandLanguages({
  initialDefault,
  labels,
  hintId,
}: {
  readonly initialDefault: Code;
  readonly labels: {
    readonly defaultLanguage: string;
    readonly defaultLanguageHint: string;
    readonly languages: string;
    readonly localeEn: string;
    readonly localeAr: string;
    /** Said by the browser while no language is ticked. */
    readonly atLeastOne: string;
  };
  readonly hintId?: string;
}) {
  const [posting, setPosting] = useState<readonly Code[]>(['EN', 'AR']);
  const [defaultLocale, setDefaultLocale] = useState<Code>(initialDefault);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    first.current?.setCustomValidity(posting.length === 0 ? labels.atLeastOne : '');
  }, [posting, labels.atLeastOne]);

  const toggle = (code: Code, on: boolean) => {
    const next = (['EN', 'AR'] as const).filter((c) => (c === code ? on : posting.includes(c)));
    setPosting(next);
    if (next.length === 1 && next[0]) setDefaultLocale(next[0]);
  };

  return (
    <>
      <Field
        label={labels.defaultLanguage}
        htmlFor="setup-brand-locale"
        hint={labels.defaultLanguageHint}
        required
      >
        <select
          id="setup-brand-locale"
          name="defaultLocale"
          className="bs-control bs-select"
          style={inputStyle()}
          data-testid="setup-brand-locale"
          aria-describedby={hintId}
          value={defaultLocale}
          onChange={(event) => setDefaultLocale(event.target.value === 'AR' ? 'AR' : 'EN')}
        >
          <option value="EN">{labels.localeEn}</option>
          <option value="AR">{labels.localeAr}</option>
        </select>
      </Field>
      <fieldset
        style={{ border: 0, margin: 0, padding: 0, display: 'grid', gap: spacingTokens.xs }}
        data-testid="setup-brand-languages"
      >
        <legend style={{ ...typographyTokens.label, marginBlockEnd: spacingTokens.xs }}>
          {labels.languages}
        </legend>
        {(['EN', 'AR'] as const).map((code, index) => (
          <label
            key={code}
            style={{ display: 'inline-flex', gap: spacingTokens.xs, alignItems: 'center' }}
          >
            <input
              ref={index === 0 ? first : undefined}
              type="checkbox"
              name="supportedLocales"
              value={code}
              checked={posting.includes(code)}
              onChange={(event) => toggle(code, event.target.checked)}
              data-testid={`setup-brand-language-${code}`}
            />
            {code === 'EN' ? labels.localeEn : labels.localeAr}
          </label>
        ))}
      </fieldset>
    </>
  );
}
