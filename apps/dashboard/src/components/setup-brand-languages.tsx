'use client';

import { useEffect, useRef, useState } from 'react';

type Code = 'EN' | 'AR';

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
 *
 * Review of #67, round 3: drawn as the prototype's "Which languages do you
 * post in?" chips (`Auth.dc.html` line 136). The AI language — which the
 * prototype does not draw — is kept behind a "More" disclosure.
 */
export function SetupBrandLanguages({
  initialDefault,
  labels,
  hintId,
  moreLabel,
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
  /** The "More" disclosure's face; the AI language is drawn inline without it. */
  readonly moreLabel?: string;
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

  const select = (
    <div>
      <label className="bsp-wz-lb" htmlFor="setup-brand-locale">
        {labels.defaultLanguage}
      </label>
      <select
        id="setup-brand-locale"
        name="defaultLocale"
        className="bs-control bs-select"
        data-testid="setup-brand-locale"
        aria-describedby={hintId ?? 'setup-brand-locale-hint'}
        required
        value={defaultLocale}
        onChange={(event) => setDefaultLocale(event.target.value === 'AR' ? 'AR' : 'EN')}
      >
        <option value="EN">{labels.localeEn}</option>
        <option value="AR">{labels.localeAr}</option>
      </select>
      <span id="setup-brand-locale-hint" className="bsp-wz-hint">
        {labels.defaultLanguageHint}
      </span>
    </div>
  );

  return (
    <>
      <fieldset className="bsp-wz-fs" data-testid="setup-brand-languages">
        <legend className="bsp-wz-lb">{labels.languages}</legend>
        <div className="bsp-wz-chips">
          {(['AR', 'EN'] as const).map((code) => (
            <label key={code} className="bsp-wz-chip bsp-wz-chip-sm">
              <input
                ref={code === 'EN' ? first : undefined}
                type="checkbox"
                name="supportedLocales"
                value={code}
                className="bsp-wz-radio"
                checked={posting.includes(code)}
                onChange={(event) => toggle(code, event.target.checked)}
                data-testid={`setup-brand-language-${code}`}
              />
              {code === 'EN' ? labels.localeEn : labels.localeAr}
            </label>
          ))}
        </div>
      </fieldset>
      {moreLabel ? (
        <details className="bsp-wz-more" data-testid="setup-brand-more">
          <summary>{moreLabel}</summary>
          {select}
        </details>
      ) : (
        select
      )}
    </>
  );
}
