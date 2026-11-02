import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createKnowledgeItemSchema } from '@brandspace/brand-brain';
import { internalErrorFields, validationFieldOf } from '@brandspace/shared';
import { statusMessage } from '../../apps/dashboard/src/i18n/messages';

/**
 * PR A2 (item 11) — Brand Brain "Add & approve" with no Area said "Something
 * went wrong": the form's schema refused it, and a schema error was reduced to
 * INTERNAL. It is now a FIELD error, and every generic error is logged with its
 * reference and its cause — never the words that were typed.
 */
const SECRET = 'Our secret launch is on 12 March';

function refusal(): unknown {
  const parsed = createKnowledgeItemSchema.safeParse({
    brandId: '00000000-0000-4000-8000-000000000001',
    area: '',
    itemKey: 'chat.abcd1234',
    title: { en: SECRET },
    body: { en: SECRET },
  });
  expect(parsed.success).toBe(false);
  return parsed.success ? null : parsed.error;
}

describe('PR A2 (item 11) — a missing Area is a field error, and the log has the cause', () => {
  it('the schema refusal names the field', () => {
    expect(validationFieldOf(refusal())).toBe('area');
    expect(validationFieldOf(new Error('boom'))).toBeNull();
  });

  it('the screen says which field, in both languages, with the reference', () => {
    const ref = '0b5a1c2e-3d4f-4a6b-8c9d-0e1f2a3b4c5d';
    expect(statusMessage('VALIDATION_FAILED:area', 'en', ref)).toBe(
      `Choose the area this fact belongs to. (reference: ${ref})`,
    );
    expect(statusMessage('VALIDATION_FAILED:area', 'ar')).toBe(
      'اختر المجال الذي تنتمي إليه هذه المعلومة.',
    );
    for (const field of ['title', 'body']) {
      expect(statusMessage(`VALIDATION_FAILED:${field}`, 'en')).not.toBeNull();
      expect(statusMessage(`VALIDATION_FAILED:${field}`, 'ar')).not.toBeNull();
    }
  });

  it('a validation failure is logged by its paths and codes, never by what was typed', () => {
    const fields = internalErrorFields(refusal());
    expect(fields).toMatchObject({ errorName: 'ZodError', errorCode: 'VALIDATION_FAILED' });
    expect(fields['issues']).toContainEqual({ path: 'area', code: 'invalid_enum_value' });
    expect(JSON.stringify(fields)).not.toContain(SECRET);
    expect(fields).not.toHaveProperty('errorMessage');
  });

  it('any other error is logged with its name, its code and its cause', () => {
    const error = new Error('db down', { cause: new TypeError('socket') });
    expect(internalErrorFields(error)).toEqual({
      errorName: 'Error',
      errorMessage: 'db down',
      causeName: 'TypeError',
    });
  });

  it('both Brand Brain failure paths map a schema refusal to the field, with a logged reference', () => {
    const actions = readFileSync('apps/dashboard/src/app/[locale]/brand-brain/actions.ts', 'utf8');
    expect(actions).toContain('`VALIDATION_FAILED:${field}`');
    const chat = readFileSync(
      'apps/dashboard/src/app/[locale]/brand-brain/chat-actions.ts',
      'utf8',
    );
    expect(chat).toMatch(
      /validationFieldOf\(error\)[\s\S]*correlationId: ref[\s\S]*return \{ ok: false, code, ref \}/,
    );
  });
});
