import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateConfiguration } from '@brandspace/config';
import { simpleCopy } from '../../apps/admin/src/i18n/simple';

/**
 * PR A2 (item 8) — the D-13 privacy questions in the Simple AI set-up, and a
 * refused activation that names its fields instead of a generic sentence.
 */

const provider = (extra: Record<string, unknown>) => ({
  providers: [
    {
      key: 'openai',
      adapterKey: 'openai',
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      apiKeySecretRef: 'secret://ai/openai',
      status: 'active',
      timeoutMs: 30_000,
      maxConcurrency: 4,
      ...extra,
    },
  ],
});

function d13Paths(document: unknown): string[] {
  return validateConfiguration('ai.providers', document)
    .issues.filter((issue) => issue.severity === 'error')
    .map((issue) => issue.path)
    .filter((issue) => /noTrainingGuarantee|dataRetentionPolicy|privacyReviewRef/.test(issue));
}

describe('item 8 — the three D-13 questions', () => {
  it('an active provider with none answered is refused on each, by path', () => {
    expect(d13Paths(provider({ noTrainingGuarantee: false }))).toEqual([
      'providers.0.noTrainingGuarantee',
      'providers.0.dataRetentionPolicy',
      'providers.0.privacyReviewRef',
    ]);
  });

  it('the answers the Simple form saves clear all three', () => {
    expect(
      d13Paths(
        provider({
          noTrainingGuarantee: true,
          dataRetentionPolicy: 'zero_retention',
          privacyReviewRef: 'DPA-2026-11',
        }),
      ),
    ).toEqual([]);
  });

  it('"keeps our data" is still refused, whatever else is answered', () => {
    expect(
      d13Paths(
        provider({
          noTrainingGuarantee: true,
          dataRetentionPolicy: 'retains_data',
          privacyReviewRef: 'DPA-2026-11',
        }),
      ),
    ).toEqual(['providers.0.dataRetentionPolicy']);
  });

  it.each(['en', 'ar'])('%s: every question, answer and refusal line exists', (locale) => {
    const copy = simpleCopy(locale);
    for (const key of [
      'd13.training',
      'd13.trainingYes',
      'd13.trainingNo',
      'd13.retention',
      'd13.retention.zero_retention',
      'd13.retention.limited_retention',
      'd13.retention.retains_data',
      'd13.review',
      'd13.refused',
    ] as const) {
      expect(copy(key), key).toBeTruthy();
    }
  });
});

describe('item 8 / M-11 — the Integrations Hub activation validates and leaves no stray draft', () => {
  const source = readFileSync(
    path.join(__dirname, '../../apps/admin/src/app/[locale]/console/integrations/actions.ts'),
    'utf8',
  );
  it('validates before it activates, discards a refused draft, and passes the failing paths on', () => {
    const apply = source.slice(source.indexOf('async function applyState('));
    expect(apply).toMatch(/validateDraft\(service, draft\.id\)/);
    expect(apply.indexOf('validateDraft')).toBeLessThan(apply.indexOf('.activate('));
    expect(apply).toMatch(/discardDraft\(/);
    expect(apply).toMatch(/fields: errors\.map\(\(issue\) => issue\.path\)/);
    expect(source).toMatch(/\.\.\.\(fields \? \{ fields \} : \{\}\)/);
  });
});
