import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  AI_FAILURE_CLASSES,
  AiProviderError,
  customerMessageFor,
  gatewayError,
  isFallbackEligible,
  isRetryable,
  type AiFailureClass,
} from '@brandspace/ai-gateway';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

/**
 * `satisfies` rather than a bare literal so that renaming or removing a class
 * breaks compilation here instead of silently reducing these tests to a loop
 * over nothing.
 */
const DETERMINISTIC_REJECTIONS = [
  'INVALID_REQUEST',
  'CONTENT_FILTERED',
  'CONTEXT_TOO_LONG',
] as const satisfies readonly AiFailureClass[];

const OUR_ACCOUNT_FAILURES = [
  'AUTH_ERROR',
  'QUOTA_EXCEEDED',
] as const satisfies readonly AiFailureClass[];

/**
 * The provider error taxonomy — docs/AI-GATEWAY.md §3.
 *
 * WHAT THESE TESTS ARE FOR. Every reliability decision the gateway makes —
 * retry, fall back to another model, charge or refund, what the customer is
 * told — is derived from a failure CLASS. If those derivations were read from
 * a provider's own error strings, a provider's release note could silently
 * change whether BrandSpace retries a paid request. So the properties asserted
 * here are the ones that must hold for the whole class set, not a restatement
 * of the two membership sets: a test that merely echoed the sets would pass no
 * matter how wrong they were.
 */
describe('AI failure taxonomy', () => {
  it('matches the Prisma enum exactly, in both directions', () => {
    // The class is persisted on `ai_request.failureClass`. A TypeScript member
    // with no enum value is a write that fails at runtime; an enum value with
    // no TypeScript member is a row nothing can classify.
    const schema = readFileSync(
      path.join(repoRoot, 'packages/database/prisma/schema.prisma'),
      'utf8',
    );
    const block = /enum AiFailureClass \{([^}]*)\}/.exec(schema);
    expect(block, 'AiFailureClass enum missing from schema.prisma').not.toBeNull();

    const schemaValues = (block?.[1] ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('//'));

    expect([...schemaValues].sort()).toEqual([...AI_FAILURE_CLASSES].sort());
  });

  it('classifies every class without falling through', () => {
    for (const failureClass of AI_FAILURE_CLASSES) {
      expect(typeof isRetryable(failureClass), failureClass).toBe('boolean');
      expect(typeof isFallbackEligible(failureClass), failureClass).toBe('boolean');
      expect(customerMessageFor(failureClass).length, failureClass).toBeGreaterThan(0);
    }
  });

  it('treats anything worth retrying as also worth falling back from', () => {
    // A condition transient enough to retry on the SAME model cannot be a
    // reason to refuse a different one. The converse does not hold, which is
    // the point of keeping the two sets separate.
    for (const failureClass of AI_FAILURE_CLASSES) {
      if (isRetryable(failureClass)) {
        expect(isFallbackEligible(failureClass), failureClass).toBe(true);
      }
    }
  });

  it('never retries or reroutes a deterministic rejection', () => {
    // These fail identically everywhere. Retrying burns the customer's
    // deadline to reach the same answer; falling back is worse — a different
    // model that does NOT refuse would mean quietly routing around a
    // moderation decision instead of surfacing it.
    for (const failureClass of DETERMINISTIC_REJECTIONS) {
      expect(isRetryable(failureClass), failureClass).toBe(false);
      expect(isFallbackEligible(failureClass), failureClass).toBe(false);
    }
  });

  it('surfaces our own account failures instead of hiding them behind a fallback', () => {
    // A missing key or an exhausted provider quota is BrandSpace's outage. If
    // the gateway silently served those requests from a second provider, the
    // operator would learn about the first one from an invoice.
    for (const failureClass of OUR_ACCOUNT_FAILURES) {
      expect(isFallbackEligible(failureClass), failureClass).toBe(false);
      expect(isRetryable(failureClass), failureClass).toBe(false);
    }
  });

  it('does not assume an unclassified failure is transient', () => {
    // UNKNOWN means the adapter could not tell what happened. Retrying it
    // would gamble a second provider charge on a guess.
    expect(isRetryable('UNKNOWN')).toBe(false);
    expect(isFallbackEligible('UNKNOWN')).toBe(false);
  });

  it('keeps MODEL_UNAVAILABLE fallback-eligible but not retryable', () => {
    // The distinction that makes two sets necessary: the same model will still
    // be unavailable on a second attempt; another one may not be.
    expect(isRetryable('MODEL_UNAVAILABLE')).toBe(false);
    expect(isFallbackEligible('MODEL_UNAVAILABLE')).toBe(true);
  });
});

describe('customer-facing failure messages', () => {
  it('derives the message from the class alone, never from provider detail', () => {
    const withUrl = new AiProviderError(
      'RATE_LIMITED',
      customerMessageFor('RATE_LIMITED'),
      'HTTP 429 from https://api.example.test/v1/chat for org org_9f21 (key sk-live-a91f)',
    );
    const withoutDetail = new AiProviderError('RATE_LIMITED', customerMessageFor('RATE_LIMITED'));

    expect(withUrl.message).toBe(withoutDetail.message);
    expect(customerMessageFor(withUrl.failureClass)).toBe(
      customerMessageFor(withoutDetail.failureClass),
    );
  });

  it('never discloses credentials, endpoints, providers or account state', () => {
    // A provider error can echo the request, the endpoint, the organisation id
    // — and with some providers, the prompt itself. None of that may reach the
    // customer path, so the customer message is a fixed string per class.
    const forbidden = [
      /api[ _-]?key/i,
      /\bsk-/,
      /\btoken\b/i,
      /\bhttps?:\/\//i,
      /\bopenai\b/i,
      /\banthropic\b/i,
      /\bquota\b/i,
      /\bbilling\b/i,
      /\borg[_-]/i,
    ];
    for (const failureClass of AI_FAILURE_CLASSES) {
      const message = customerMessageFor(failureClass);
      for (const pattern of forbidden) {
        expect(pattern.test(message), `${failureClass}: "${message}" matched ${pattern}`).toBe(
          false,
        );
      }
    }
  });

  it('tells the customer nothing actionable about our configuration failures', () => {
    // AUTH_ERROR is ours to fix, not theirs. "Invalid API key" would be both a
    // disclosure and useless advice; the operator sees the real class on the
    // request record instead.
    expect(customerMessageFor('AUTH_ERROR')).toBe(customerMessageFor('QUOTA_EXCEEDED'));
  });

  it('keeps operator detail off the error message', () => {
    const detail = 'upstream said: invalid_api_key for key sk-live-a91f';
    const error = new AiProviderError('AUTH_ERROR', customerMessageFor('AUTH_ERROR'), detail);

    expect(error.message).not.toContain('sk-live');
    expect(error.message).not.toContain(detail);
    expect(error.operatorDetail).toBe(detail);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AiProviderError');
  });

  it('leaves operator detail undefined rather than inventing one', () => {
    const error = new AiProviderError('TIMEOUT', customerMessageFor('TIMEOUT'));
    expect(error.operatorDetail).toBeUndefined();
  });
});

describe('gateway refusals', () => {
  it('maps each caller-fixable refusal to its stable HTTP status', () => {
    expect(gatewayError('VALIDATION_FAILED', 'bad input').httpStatus).toBe(422);
    expect(gatewayError('CONFLICT', 'already running').httpStatus).toBe(409);
    expect(gatewayError('NOT_FOUND', 'no such request').httpStatus).toBe(404);
    expect(gatewayError('FORBIDDEN', 'not permitted').httpStatus).toBe(403);
  });

  it('does not put the internal message in the client-facing payload', () => {
    const error = gatewayError('NOT_FOUND', 'ai_request 3f21 not in workspace ws_7');
    const payload = error.toPublicJSON('req_1');

    expect(JSON.stringify(payload)).not.toContain('ws_7');
    expect(payload.error.code).toBe('NOT_FOUND');
  });
});
