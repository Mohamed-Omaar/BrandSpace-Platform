import { AREA_COPY, type AreaCopyKey } from '../../i18n/simple-areas';
import { arrayOf, num, rec, str } from './json';
import type { AreaContext, Docs } from './types';

/**
 * PLAIN WORDS FOR WHAT THE CONFIGURATION STORES AS KEYS (owner review of the
 * Simple card pages): a plan reads by the name customers see, a stored choice
 * ("exclusive", "none") by what it means, a number by its unit in the reader's
 * language. Anything with no plain name yet reads "Set by your developer"
 * rather than leaking the key it is stored under.
 */

const known = (key: string): key is AreaCopyKey => key in AREA_COPY.en;

/** One word per stored choice, or the developer's line when none is written. */
export function choiceName(ctx: AreaContext, group: string, value: string): string {
  if (value === '') return '—';
  const key = `v.${group}.${value}`;
  return known(key) ? ctx.t(key) : ctx.t('w.developerValue');
}

/** "30 days", "٣٠ يومًا" — or "—" when the value is missing. */
export function amount(ctx: AreaContext, value: unknown, unit: AreaCopyKey): string {
  const n = num(value);
  return n === null ? '—' : `${n} ${ctx.t(unit)}`;
}

export function joined(ctx: AreaContext, values: readonly string[]): string {
  return values.length === 0 ? '—' : values.join(ctx.locale === 'ar' ? '، ' : ', ');
}

/** The name customers see for a plan stored in `docs`, never its key. */
export function planName(docs: Docs, key: string, ctx: AreaContext): string {
  const plan = arrayOf(docs.plans?.['plans'])
    .map(rec)
    .find((p) => str(p['key']) === key);
  const name = rec(plan?.['name']);
  return (
    str(ctx.locale === 'ar' ? name['ar'] : name['en']) ||
    str(name['en']) ||
    str(name['ar']) ||
    ctx.t('plans.unnamed')
  );
}

/** A writing style by its name, from the copy (its stored key is a code). */
export function dialectName(ctx: AreaContext, key: string): string {
  const copyKey = `dialect.${key}`;
  return known(copyKey) ? ctx.t(copyKey) : ctx.t('w.developerValue');
}

/**
 * A Brand Brain question set by a name a person reads: the copy's name for the
 * sets the product ships, otherwise the set's own first question.
 */
export function questionSetName(docs: Docs, key: string, ctx: AreaContext): string {
  if (key === '') return '—';
  const copyKey = `qs.${key}`;
  if (known(copyKey)) return ctx.t(copyKey);
  const first = rec(arrayOf(rec(rec(docs['brand-brain']?.['questions'])['offersSets'])[key])[0]);
  const prompt = rec(first['prompt']);
  return str(ctx.locale === 'ar' ? prompt['ar'] : prompt['en']) || ctx.t('w.developerValue');
}
