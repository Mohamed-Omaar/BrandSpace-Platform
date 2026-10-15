import { fill, simpleCopy, type SimpleKey } from './simple';

/**
 * PLAIN NAMES FOR STORED KEYS ON THE OWNER'S PAGES (owner review of the Simple
 * card pages): a configuration document, a plan limit and a plan read in the
 * interface language, never as the key the platform stores them under.
 */

function lookup(locale: string, key: string): string | null {
  const text = simpleCopy(locale)(key as SimpleKey) as string | undefined;
  return typeof text === 'string' ? text : null;
}

/** "usage limits", "حدود الاستخدام" — a document never reads as its id. */
export function domainName(locale: string, domain: string): string {
  return lookup(locale, `domain.${domain}`) ?? simpleCopy(locale)('domain.unknown');
}

/** "Team members" for `seats`; an unknown limit reads as "another limit". */
export function quotaName(locale: string, quota: string): string {
  return lookup(locale, `quota.${quota}`) ?? simpleCopy(locale)('quota.unknown');
}

export function listJoin(locale: string, values: readonly string[]): string {
  return values.join(locale === 'ar' ? '، ' : ', ');
}

/**
 * The facts behind a readiness sentence, in the reader's words: the trial
 * plan by the name customers see, its unset limits by their plain names.
 */
export function plainDetail(
  locale: string,
  detail: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = { ...detail };
  const name =
    locale === 'ar' ? detail['planAr'] || detail['planEn'] : detail['planEn'] || detail['planAr'];
  if (detail['plan'] !== undefined) out['plan'] = name || simpleCopy(locale)('plans.unnamedPlan');
  if (detail['quotas'] !== undefined) {
    out['quotas'] = listJoin(
      locale,
      detail['quotas']
        .split(',')
        .map((quota) => quota.trim())
        .filter(Boolean)
        .map((quota) => quotaName(locale, quota)),
    );
  }
  return out;
}

export function pendingName(locale: string, domain: string): string {
  return (
    lookup(locale, `pending.${domain}`) ??
    fill(simpleCopy(locale)('pending.other'), { domain: domainName(locale, domain) })
  );
}
