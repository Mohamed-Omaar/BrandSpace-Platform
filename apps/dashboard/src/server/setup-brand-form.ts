import { AppError } from '@brandspace/shared';
import { brandProfileFrom } from './brand-profile';
import type { NewBrandInput } from './brand-creation';

/**
 * THE SETUP WIZARD'S "ADD BRAND" FORM, DECODED BY THE BRAND PROFILE'S OWN RULES.
 *
 * §6 step 2 asks for only a few of the profile's fields: a name, a website, an
 * industry, the brand's languages and, optionally, its colours (the logo is a
 * file and arrives separately). A second decoder for those would be a second
 * copy of the rules that matter — http(s) websites only, hex colours only, the
 * default language always among the supported ones — so this delegates to
 * `brandProfileFrom` and keeps only what the wizard asked.
 *
 * THE FIELDS THE WIZARD DOES NOT RENDER ARE FORCED EMPTY, not read. The
 * profile decoder refuses an absent field (a request the screen cannot
 * produce), and the wizard never renders a description, the fonts or a logo
 * id; setting them blank here means a crafted request carrying them writes
 * nothing, because nothing below passes them on.
 *
 * THE LANGUAGES IT PUBLISHES IN DECIDE THE AI LANGUAGE WHEN THERE IS ONE
 * (D-335). At least one must be ticked — the screen requires it and this
 * refuses a request without one — and when exactly one is, the brand's default
 * content language is that one, whatever the select said: a brand that
 * publishes only in Arabic does not get English drafts. With both ticked the
 * select decides, and it starts at the creator's interface language (D-331).
 *
 * NOT `server-only` and not `'use server'`: pure, so the unit suite reaches it.
 */
const NOT_ASKED_BY_THE_WIZARD = [
  'description',
  'headingFont',
  'bodyFont',
  'primaryLogoAssetId',
  'secondaryLogoAssetId',
] as const;

export function setupBrandFrom(formData: FormData): NewBrandInput {
  const copy = new FormData();
  for (const [key, value] of formData.entries()) {
    if (typeof value === 'string') copy.append(key, value);
  }
  for (const field of NOT_ASKED_BY_THE_WIZARD) copy.set(field, '');

  const posting = [
    ...new Set(copy.getAll('supportedLocales').filter((v) => v === 'AR' || v === 'EN')),
  ];
  if (posting.length === 0) {
    throw new AppError('VALIDATION_FAILED', 'Choose at least one language the brand publishes in.');
  }
  // Only over a field the form sent: an absent one is still refused below.
  if (posting.length === 1 && copy.has('defaultLocale')) {
    copy.set('defaultLocale', String(posting[0]));
  }

  const profile = brandProfileFrom(copy);
  return {
    name: profile.name,
    industry: profile.industry,
    websiteUrl: profile.websiteUrl,
    defaultLocale: profile.defaultLocale,
    supportedLocales: profile.supportedLocales,
    colorPalette: profile.colorPalette,
  };
}
