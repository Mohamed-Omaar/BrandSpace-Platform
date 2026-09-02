import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { trace } from '@opentelemetry/api';
import {
  annotateActiveSpan,
  currentTraceContext,
  initializeTracing,
  sanitizeAttributes,
  shutdownTracing,
  tracingStatus,
  withSpan,
} from '@brandspace/observability';

/**
 * Observability — F-05.
 *
 * The traces themselves are not what these tests are about. Three properties are:
 *
 *   1. tracing is OPTIONAL: with no collector configured the platform runs
 *      normally, because telemetry must never become a deployment prerequisite;
 *   2. tracing is NEVER LOAD-BEARING: an exporter failure, a bad endpoint or a
 *      collector outage must not change what a request returns;
 *   3. NO CREDENTIALS OR PERSONAL DATA reach a span, because spans leave the
 *      building and are retained by a third party.
 */

const OTEL_ENV_KEYS = ['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_SERVICE_NAME', 'APP_ENV'] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  savedEnv = Object.fromEntries(OTEL_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const key of OTEL_ENV_KEYS) delete process.env[key];
  await shutdownTracing();
});

afterEach(async () => {
  await shutdownTracing();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe('OTLP exporter configuration', () => {
  it('initialises with no exporter when no collector is configured', () => {
    const status = initializeTracing({ serviceName: 'brandspace-test' });

    expect(status.initialized).toBe(true);
    expect(status.exporting).toBe(false);
    expect(status.endpointHost).toBeNull();
  });

  it('configures an OTLP exporter when an endpoint is provided', () => {
    const status = initializeTracing({
      serviceName: 'brandspace-test',
      otlpEndpoint: 'http://collector.internal:4318',
    });

    expect(status.initialized).toBe(true);
    expect(status.exporting).toBe(true);
    expect(status.endpointHost).toBe('collector.internal:4318');
  });

  it('reads the endpoint from OTEL_EXPORTER_OTLP_ENDPOINT when not passed explicitly', () => {
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://otel.example:4318';
    const status = initializeTracing({ serviceName: 'brandspace-test' });
    expect(status.exporting).toBe(true);
  });

  it('treats a blank endpoint as "not configured" rather than as a broken one', () => {
    const status = initializeTracing({ serviceName: 'brandspace-test', otlpEndpoint: '   ' });
    expect(status.exporting).toBe(false);
  });

  it('reports only the endpoint HOST, never a URL that could carry credentials', () => {
    const status = initializeTracing({
      serviceName: 'brandspace-test',
      otlpEndpoint: 'https://user:hunter2@collector.example.com:4318/path',
    });

    // This value is rendered on the admin health screen.
    expect(status.endpointHost).toBe('collector.example.com:4318');
    expect(status.endpointHost).not.toContain('hunter2');
    expect(status.endpointHost).not.toContain('user');
    expect(JSON.stringify(status)).not.toContain('hunter2');
  });

  it('reports no host for an unparseable endpoint instead of echoing the raw string', () => {
    const status = initializeTracing({
      serviceName: 'brandspace-test',
      otlpEndpoint: 'not a url at all',
    });
    expect(status.endpointHost).toBeNull();
  });

  it('is idempotent: a second initialise does not install a second provider', () => {
    const first = initializeTracing({
      serviceName: 'brandspace-test',
      otlpEndpoint: 'http://collector.internal:4318',
    });
    const second = initializeTracing({ serviceName: 'brandspace-test' });

    expect(first.initialized).toBe(true);
    expect(second.initialized).toBe(true);
    expect(second.exporting).toBe(true);
  });

  it('reports "not initialised" before startup and after shutdown', async () => {
    expect(tracingStatus().initialized).toBe(false);
    initializeTracing({ serviceName: 'brandspace-test' });
    expect(tracingStatus().initialized).toBe(true);
    await shutdownTracing();
    expect(tracingStatus().initialized).toBe(false);
  });

  it('shuts down cleanly when it was never started', async () => {
    await expect(shutdownTracing()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tracing is never load-bearing
// ---------------------------------------------------------------------------

describe('tracing never changes what a request does', () => {
  it('returns the function result when tracing is not initialised at all', async () => {
    const result = await withSpan('probe', { 'brandspace.probe': true }, async () => 42);
    expect(result).toBe(42);
  });

  it('returns the function result when an exporter points at a dead collector', async () => {
    initializeTracing({
      serviceName: 'brandspace-test',
      // Nothing is listening here. The batch exporter will fail in the
      // background; the request must not notice.
      otlpEndpoint: 'http://127.0.0.1:1',
    });

    const result = await withSpan('probe', {}, async () => 'ok');
    expect(result).toBe('ok');
  });

  it('re-throws the original error unchanged', async () => {
    initializeTracing({ serviceName: 'brandspace-test' });
    const original = new Error('domain failure');

    const thrown = await withSpan('probe', {}, async () => {
      throw original;
    }).catch((e: unknown) => e);

    expect(thrown).toBe(original);
    expect((thrown as Error).message).toBe('domain failure');
  });

  it('runs the function even if the tracer itself throws', async () => {
    const realGetTracer = trace.getTracer.bind(trace);
    // A tracer that cannot start a span is the worst realistic case.
    (trace as unknown as { getTracer: unknown }).getTracer = () => ({
      startSpan: () => {
        throw new Error('tracer exploded');
      },
    });

    try {
      await expect(withSpan('probe', {}, async () => 'still ran')).resolves.toBe('still ran');
    } finally {
      (trace as unknown as { getTracer: unknown }).getTracer = realGetTracer;
    }
  });

  it('annotating with no active span is a no-op, not an error', () => {
    expect(() => annotateActiveSpan({ 'brandspace.workspace_count': 3 })).not.toThrow();
  });

  it('reports a null trace context outside any span', () => {
    expect(currentTraceContext()).toEqual({ traceId: null, spanId: null });
  });

  it('reports a usable trace context inside a span, for log correlation', async () => {
    initializeTracing({ serviceName: 'brandspace-test' });
    const seen = await withSpan('probe', {}, async () => currentTraceContext());

    expect(seen.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(seen.spanId).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ---------------------------------------------------------------------------
// Nothing sensitive reaches a span
// ---------------------------------------------------------------------------

describe('span attributes carry no credentials or personal data', () => {
  it.each([
    'password',
    'user_password',
    'secret',
    'vault.secret_value',
    'token',
    'session_token',
    'apiKey',
    'api_key',
    'x-api-key',
    'credential',
    'authorization',
    'cookie',
    'session',
    'user.email',
    'customer_phone',
    'sentry.dsn',
    'connection_string',
    'DATABASE_URL',
  ])('drops the attribute %s entirely', (key) => {
    const out = sanitizeAttributes({ [key]: 'anything at all', kept: 'yes' });

    expect(out).not.toHaveProperty(key);
    expect(out['kept']).toBe('yes');
  });

  it.each([
    ['a postgres connection string', 'postgresql://user:pw@db.internal:5432/brandspace'],
    ['a redis url', 'redis://:password@cache.internal:6379'],
    ['a provider api key', 'sk-abcdefghijklmnopqrstuvwxyz012345'],
    ['a bearer token', 'Bearer abcdefghijklmnopqrstuvwxyz0123456789'],
  ])('drops %s even under an innocent key name', (_label, value) => {
    const out = sanitizeAttributes({ note: value });
    expect(out).not.toHaveProperty('note');
  });

  it('keeps the identifiers that make a trace useful', () => {
    const out = sanitizeAttributes({
      'brandspace.workspace_id': '3f1c0b0e-0000-4000-8000-000000000001',
      'brandspace.configuration_domain': 'ai.providers',
      'brandspace.version': 7,
      'brandspace.activated': true,
    });

    expect(out).toEqual({
      'brandspace.workspace_id': '3f1c0b0e-0000-4000-8000-000000000001',
      'brandspace.configuration_domain': 'ai.providers',
      'brandspace.version': 7,
      'brandspace.activated': true,
    });
  });

  it('drops null and undefined instead of recording them', () => {
    const out = sanitizeAttributes({
      a: null as unknown as string,
      b: undefined as unknown as string,
      c: 'kept',
    });
    expect(out).toEqual({ c: 'kept' });
  });

  it('caps long strings so a span never becomes a payload dump', () => {
    const out = sanitizeAttributes({ body: 'x'.repeat(5_000) });
    expect(String(out['body'])).toHaveLength(512);
  });

  it('sanitises arrays element by element and drops non-primitive members', () => {
    const out = sanitizeAttributes({
      'brandspace.domains': ['plans', 'ai.models', { nested: true } as unknown as string],
    });
    expect(out['brandspace.domains']).toEqual(['plans', 'ai.models']);
  });

  it('applies the same redaction that the logger uses, to values it keeps', () => {
    const out = sanitizeAttributes({
      note: 'contact is ghp_abcdefghijklmnopqrstuvwxyz0123456789 for access',
    });
    // Either dropped or redacted — what must never happen is the raw token
    // surviving into a span.
    expect(JSON.stringify(out)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('sanitises the attributes passed to withSpan, not just direct callers', async () => {
    initializeTracing({ serviceName: 'brandspace-test' });

    const recorded: Record<string, unknown> = {};
    await withSpan('probe', { password: 'hunter2', 'brandspace.ok': 1 }, async (span) => {
      // Capture what the span was actually given.
      Object.assign(recorded, (span as unknown as { attributes?: Attributes }).attributes ?? {});
      return null;
    });

    // Non-vacuity: the span really did receive attributes, and the safe one
    // survived. Only the forbidden one was dropped.
    expect(recorded['brandspace.ok']).toBe(1);
    expect(recorded).not.toHaveProperty('password');
    expect(JSON.stringify(recorded)).not.toContain('hunter2');
  });

  it('records only the error NAME on a failed span, never its message', async () => {
    initializeTracing({ serviceName: 'brandspace-test' });

    let capturedStatus: unknown;
    await withSpan('probe', {}, async (span) => {
      const realSetStatus = span.setStatus.bind(span);
      span.setStatus = (status) => {
        capturedStatus = status;
        return realSetStatus(status);
      };
      throw new TypeError('postgresql://user:pw@db.internal:5432/brandspace is unreachable');
    }).catch(() => undefined);

    expect(capturedStatus).toBeDefined();
    expect(JSON.stringify(capturedStatus)).toContain('TypeError');
    expect(JSON.stringify(capturedStatus)).not.toContain('postgresql://');
  });
});

type Attributes = Record<string, unknown>;
