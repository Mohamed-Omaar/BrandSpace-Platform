import type { TemplateFields } from '@brandspace/content';
import { AppError } from '@brandspace/shared';
import { parseContentType } from '../app/[locale]/content/content-types';

/**
 * THE TEMPLATE FORM, DECODED (E4 / B2, Phase 2B-2).
 *
 * Outside the `'use server'` module so it can be asserted without a browser
 * (D-183's reason). It FAILS CLOSED: a format the composer does not offer is
 * refused rather than silently becoming POST, and the service then bounds and
 * checks every field again.
 */
export function templateFieldsFrom(formData: FormData): TemplateFields {
  const contentType = parseContentType(formData.get('contentType'));
  if (!contentType) {
    throw new AppError('VALIDATION_FAILED', 'Choose a format.', { field: 'contentType' });
  }
  const text = (name: string): string | null => {
    const value = String(formData.get(name) ?? '').trim();
    return value === '' ? null : value;
  };
  return {
    name: String(formData.get('name') ?? ''),
    contentType,
    platformKeys: formData.getAll('platformKeys').map((value) => String(value)),
    body: text('body'),
    hashtags: String(formData.get('hashtags') ?? '')
      .split(/[\s,]+/)
      .filter((tag) => tag.length > 0),
    firstComment: text('firstComment'),
  };
}
