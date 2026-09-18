import { describe, expect, it } from 'vitest';

import {
  evaluateHealth,
  publicView,
  readinessHttpStatus,
  type DependencyCheck,
} from '@brandspace/observability';

/**
 * Liveness, readiness and degradation — Phase 10 §19.
 *
 * THE RULE THESE TESTS DEFEND is that "not ready" is reserved for something
 * REQUIRED being down. The tempting simplification — any failing check means
 * not ready — takes every instance out of the load balancer because object
 * storage is unreachable, which replaces a broken upload button with a
 * completely unreachable product.
 */

const ok = (name: string, required: boolean, capability?: string): DependencyCheck => ({
  name,
  state: 'ok',
  required,
  ...(capability ? { capability } : {}),
});

describe('evaluating a set of probe results', () => {
  it('is ready when everything answers', () => {
    const report = evaluateHealth([ok('database', true), ok('queue', false, 'background-jobs')]);
    expect(report.status).toBe('ready');
    expect(report.degradedCapabilities).toEqual([]);
    expect(readinessHttpStatus(report.status)).toBe(200);
  });

  it('is DEGRADED, not down, when an optional dependency is missing', () => {
    const report = evaluateHealth([
      ok('database', true),
      { name: 'queue', state: 'not_configured', required: false, capability: 'background-jobs' },
    ]);
    expect(report.status).toBe('degraded');
    expect(report.degradedCapabilities).toEqual(['background-jobs']);
    // 200: the product still serves. A 503 here would be self-inflicted.
    expect(readinessHttpStatus(report.status)).toBe(200);
  });

  it('is not ready when a REQUIRED dependency is down', () => {
    const report = evaluateHealth([
      { name: 'database', state: 'down', required: true },
      ok('queue', false, 'background-jobs'),
    ]);
    expect(report.status).toBe('not_ready');
    expect(readinessHttpStatus(report.status)).toBe(503);
  });

  it('treats a required dependency that is NOT CONFIGURED as down', () => {
    // The honest reading: a platform with no object storage configured cannot
    // store an upload, whether the bucket is missing or merely unnamed.
    const report = evaluateHealth([{ name: 'storage', state: 'not_configured', required: true }]);
    expect(report.status).toBe('not_ready');
  });

  it('names every affected capability once, in a stable order', () => {
    const report = evaluateHealth([
      ok('database', true),
      { name: 'queue', state: 'down', required: false, capability: 'background-jobs' },
      { name: 'media', state: 'degraded', required: false, capability: 'background-jobs' },
      { name: 'tracing', state: 'not_configured', required: false, capability: 'observability' },
    ]);
    expect(report.degradedCapabilities).toEqual(['background-jobs', 'observability']);
  });

  it('does not let an unknown state manufacture a degradation', () => {
    // `unknown` means the probe could not answer, which is not the same as the
    // dependency being broken — and reporting it as degradation would make
    // every slow probe look like an outage.
    const report = evaluateHealth([
      ok('database', true),
      { name: 'x', state: 'unknown', required: false },
    ]);
    expect(report.status).toBe('ready');
  });
});

describe('what an unauthenticated caller is told', () => {
  it('gets a state per named check and nothing else', () => {
    /*
     * A load balancer needs one word. It does not need the database role, the
     * storage endpoint or the text of a driver error, all of which describe how
     * the platform is assembled to anybody who can reach a URL.
     */
    const report = evaluateHealth([
      { name: 'database', state: 'ok', required: true, detail: 'brandspace_app', latencyMs: 3 },
    ]);
    const view = publicView(report);
    expect(view).toEqual({ status: 'ready', checks: [{ name: 'database', state: 'ok' }] });
    expect(JSON.stringify(view)).not.toContain('brandspace_app');
  });

  it('still says when it is not ready', () => {
    const report = evaluateHealth([
      { name: 'database', state: 'down', required: true, detail: 'connection refused at db:5432' },
    ]);
    const view = publicView(report);
    expect(view.status).toBe('not_ready');
    expect(JSON.stringify(view)).not.toContain('5432');
  });
});
