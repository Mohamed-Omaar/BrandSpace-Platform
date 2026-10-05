'use client';

import { useState } from 'react';
import { Field, inputStyle, type SearchableOption } from '@brandspace/ui';

/**
 * THE INDUSTRY FIELD — the activated catalogue plus "Something else" (G6,
 * D-329), shared by Settings → General (D-330) and the setup wizard's brand
 * step (D-335) so the two cannot come to offer it differently.
 *
 * What is submitted is ONE `industry` value: a catalogue key, the free text
 * typed under "Something else", or empty. With no catalogue activated the
 * field is free text only. The server decodes it with Brand Profile's own
 * rules (`industryFrom`) either way.
 */

/** The select's "Something else" value. Never stored. */
const OTHER = '__other';

export interface IndustryFieldLabels {
  readonly industry: string;
  readonly industryHint: string;
  readonly industryNone: string;
  readonly industryOther: string;
  readonly industryOtherLabel: string;
}

export function IndustryField({
  industries,
  saved,
  labels,
  idPrefix,
  testIdPrefix,
  single = false,
  backLabel,
}: {
  /**
   * Round 3 (Settings → General) — ONE field, as the prototype draws Industry:
   * the list, or — once "Something else" is chosen — the words in the same
   * place, with a way back to the list. The value submitted is the same.
   */
  readonly single?: boolean;
  readonly backLabel?: string;
  /** The activated industry catalogue, in the reader's language. Empty = free text only. */
  readonly industries: readonly SearchableOption[];
  readonly saved: string | null;
  readonly labels: IndustryFieldLabels;
  /** Prefixes the controls' ids, so two forms on one page cannot collide. */
  readonly idPrefix: string;
  readonly testIdPrefix: string;
}) {
  const savedIndustry = saved ?? '';
  const savedIsKey = industries.some((option) => option.value === savedIndustry);
  const [choice, setChoice] = useState(
    savedIndustry === '' ? '' : savedIsKey ? savedIndustry : OTHER,
  );
  const [other, setOther] = useState(savedIsKey ? '' : savedIndustry);
  const value = choice === OTHER ? other : choice;
  const choiceId = `${idPrefix}industryChoice`;
  const otherId = `${idPrefix}industryOther`;

  if (single && industries.length > 0) {
    return (
      <Field
        label={labels.industry}
        htmlFor={choice === OTHER ? otherId : choiceId}
        hint={labels.industryHint}
      >
        <input type="hidden" name="industry" value={value} />
        {choice === OTHER ? (
          <span className="bsp-ind-other">
            <input
              className="bs-control"
              id={otherId}
              data-testid={`${testIdPrefix}-industry-other`}
              value={other}
              maxLength={120}
              aria-label={labels.industryOtherLabel}
              onChange={(event) => setOther(event.target.value)}
              style={inputStyle()}
            />
            <button
              type="button"
              className="bsp-ind-back"
              onClick={() => setChoice('')}
              data-testid={`${testIdPrefix}-industry-list`}
            >
              {backLabel ?? labels.industryNone}
            </button>
          </span>
        ) : (
          <select
            className="bs-control bs-select bsp-chevron"
            id={choiceId}
            data-testid={`${testIdPrefix}-industry`}
            value={choice}
            onChange={(event) => setChoice(event.target.value)}
            style={inputStyle()}
          >
            <option value="">{labels.industryNone}</option>
            {industries.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
            <option value={OTHER}>{labels.industryOther}</option>
          </select>
        )}
      </Field>
    );
  }

  return (
    <>
      <input type="hidden" name="industry" value={value} />
      {industries.length > 0 ? (
        <Field label={labels.industry} htmlFor={choiceId} hint={labels.industryHint}>
          <select
            className="bs-control bs-select"
            id={choiceId}
            data-testid={`${testIdPrefix}-industry`}
            value={choice}
            onChange={(event) => setChoice(event.target.value)}
            style={inputStyle()}
          >
            <option value="">{labels.industryNone}</option>
            {industries.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
            <option value={OTHER}>{labels.industryOther}</option>
          </select>
        </Field>
      ) : null}
      {industries.length === 0 || choice === OTHER ? (
        <Field
          label={industries.length === 0 ? labels.industry : labels.industryOtherLabel}
          htmlFor={otherId}
          hint={industries.length === 0 ? labels.industryHint : undefined}
        >
          <input
            className="bs-control"
            id={otherId}
            data-testid={`${testIdPrefix}-industry-other`}
            value={other}
            maxLength={120}
            onChange={(event) => {
              setOther(event.target.value);
              if (industries.length === 0) setChoice(OTHER);
            }}
            style={inputStyle()}
          />
        </Field>
      ) : null}
    </>
  );
}
