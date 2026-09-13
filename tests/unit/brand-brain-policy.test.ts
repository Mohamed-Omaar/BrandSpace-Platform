import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultPayload, parseConfigPayload } from '@brandspace/config';
import { brandBrainPolicyFrom } from '@brandspace/brand-brain';
import { messages } from '../../apps/dashboard/src/i18n/messages';

/**
 * Brand Brain policy comes from configuration, and cannot quietly stop doing so.
 *
 * The isolation suite proves the live path end to end against a real database
 * (`tests/isolation/brand-brain-policy.test.ts`). This proves the two things a
 * database test cannot: that the mapping carries EVERY field the schema
 * declares, and that no application source has grown its own copy of a value
 * the owner is supposed to control.
 *
 * The second half is the one that matters. Phase 5A's defect was not a wrong
 * number — the numbers agreed with the schema on the day they were written.
 * It was a SECOND copy, which is a second setting, and which no test noticed.
 */

const ROOT = path.resolve(__dirname, '../..');

describe('the configuration document is mapped completely', () => {
  it('every value in the policy comes from the document it was given', () => {
    const document = parseConfigPayload('brand-brain', {
      upload: {
        allowedMimeTypes: ['text/plain'],
        maxFileBytes: 111,
        maxDocumentsPerBrand: 222,
      },
      ingestion: {
        maxAttempts: 4,
        retryBackoffSeconds: 333,
        stuckAfterSeconds: 444,
        chunkTargetChars: 555,
        chunkOverlapChars: 66,
        maxChunksPerDocument: 777,
      },
      knowledge: { reviewIntervalDays: 88, minimumCandidateConfidenceMilli: 999 },
      chat: {
        retentionDays: 12,
        maxContextItems: 13,
        maxContextChunks: 14,
        maxContextChars: 1500,
      },
    });

    expect(brandBrainPolicyFrom(document)).toEqual({
      ingestion: {
        allowedMimeTypes: ['text/plain'],
        maxFileBytes: 111,
        maxDocumentsPerBrand: 222,
        maxAttempts: 4,
        retryBackoffSeconds: 333,
        chunkTargetChars: 555,
        chunkOverlapChars: 66,
        maxChunksPerDocument: 777,
        minimumCandidateConfidenceMilli: 999,
      },
      staleness: { reviewIntervalDays: 88 },
      chat: {
        retentionDays: 12,
        maxContextItems: 13,
        maxContextChunks: 14,
        maxContextChars: 1500,
      },
      stuckAfterSeconds: 444,
    });
  });

  it('an empty document yields the SCHEMA defaults, not a default written elsewhere', () => {
    // The bootstrap path: nothing activated yet. The values come from the one
    // place an operator edits, so there is nothing to drift from.
    const policy = brandBrainPolicyFrom(defaultPayload('brand-brain'));
    expect(policy.chat.retentionDays).toBeGreaterThan(0);
    expect(policy.ingestion.allowedMimeTypes.length).toBeGreaterThan(0);
    expect(policy.staleness.reviewIntervalDays).toBeGreaterThan(0);
  });
});

describe('no application source carries its own copy of a policy value', () => {
  /**
   * The settings an owner controls, by the property name each is written under.
   *
   * A literal assignment to any of these outside the configuration schema is a
   * second setting — which is exactly what this test exists to refuse, whatever
   * the accompanying comment says about "mirroring" the schema.
   */
  const POLICY_PROPERTIES = [
    'retentionDays',
    'reviewIntervalDays',
    'maxFileBytes',
    'maxDocumentsPerBrand',
    'stuckAfterSeconds',
    'chunkTargetChars',
    'chunkOverlapChars',
    'maxChunksPerDocument',
    'minimumCandidateConfidenceMilli',
    'maxContextItems',
    'maxContextChunks',
    'maxContextChars',
    'retryBackoffSeconds',
  ];

  /** `retentionDays: 90` and `maxFileBytes: 25 * 1024 * 1024` both count. */
  const literalAssignment = new RegExp(
    `\\b(${POLICY_PROPERTIES.join('|')})\\s*:\\s*[0-9]`,
    // Not global: one match per line is enough to fail.
    '',
  );

  function sources(dir: string): string[] {
    const absolute = path.join(ROOT, dir);
    const out: string[] = [];
    const walk = (current: string): void => {
      for (const entry of readdirSync(current)) {
        const full = path.join(current, entry);
        if (statSync(full).isDirectory()) {
          if (entry === 'node_modules' || entry === '.next') continue;
          walk(full);
        } else if (/\.tsx?$/.test(entry)) {
          out.push(path.relative(ROOT, full));
        }
      }
    };
    walk(absolute);
    return out;
  }

  const files = [
    ...sources('apps/dashboard/src'),
    ...sources('apps/api/src'),
    ...sources('apps/worker/src'),
    ...sources('apps/admin/src'),
  ];

  it('scans a meaningful number of files, so a passing result is not vacuous', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('assigns no Brand Brain policy value as a literal', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(path.join(ROOT, file), 'utf8');
      for (const [index, line] of source.split('\n').entries()) {
        const trimmed = line.trim();
        // Comments and JSDoc legitimately name these properties.
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
          continue;
        }
        if (literalAssignment.test(line)) offenders.push(`${file}:${index + 1} ${trimmed}`);
      }
    }
    expect(
      offenders,
      'a policy value is written down in an application instead of being read from configuration',
    ).toEqual([]);
  });

  it('detects a planted literal, so the scan is known to work', () => {
    expect(literalAssignment.test('  retentionDays: 90,')).toBe(true);
    expect(literalAssignment.test('  maxFileBytes: 25 * 1024 * 1024,')).toBe(true);
    expect(literalAssignment.test('  retentionDays: policy.chat.retentionDays,')).toBe(false);
  });
});

describe('the retention notice states the configured window', () => {
  it('both locales interpolate the number rather than naming one', () => {
    for (const locale of ['en', 'ar'] as const) {
      const template = messages[locale]['bb.chatRetention'];
      // The placeholder is the whole point: a notice with a number written into
      // it would go on promising ninety days after an owner changed the window.
      expect(template, `${locale} retention notice has no {days} placeholder`).toContain('{days}');
      expect(template, `${locale} retention notice hard-codes a number`).not.toMatch(/\b\d+\b/);
    }
  });
});
