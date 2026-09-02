import { context, SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { sanitizeAttributes } from './redaction';

/**
 * OpenTelemetry tracing with OTLP export — closes F-05.
 *
 * THREE PROPERTIES THAT MATTER MORE THAN THE TRACES THEMSELVES:
 *
 *  1. DISABLED SAFELY when unconfigured. With no OTEL_EXPORTER_OTLP_ENDPOINT the
 *     provider runs with no exporter: spans are created, cost almost nothing,
 *     and go nowhere. Telemetry is never a deployment prerequisite.
 *
 *  2. TELEMETRY FAILURE NEVER BREAKS A REQUEST. The exporter is batched and
 *     asynchronous, and every helper here swallows its own errors. A collector
 *     outage must never turn into a customer-facing 500.
 *
 *  3. NO SECRETS OR PII IN SPANS. Every attribute goes through
 *     `sanitizeAttributes` — see redaction.ts.
 */

const TRACER_NAME = 'brandspace';

let provider: NodeTracerProvider | undefined;
let exporterConfigured = false;

export interface TracingOptions {
  readonly serviceName?: string;
  readonly serviceVersion?: string;
  readonly otlpEndpoint?: string | undefined;
  readonly environment?: string;
  /** Extra OTLP headers, e.g. a collector API key resolved from the vault. */
  readonly headers?: Record<string, string>;
}

export interface TracingStatus {
  readonly initialized: boolean;
  readonly exporting: boolean;
  readonly serviceName: string;
  /** Host only — never the full URL, which can carry credentials. */
  readonly endpointHost: string | null;
}

/**
 * Initialise tracing. Idempotent: calling twice is a no-op, so a module that is
 * imported by several entrypoints cannot install two providers.
 */
export function initializeTracing(options: TracingOptions = {}): TracingStatus {
  const serviceName = options.serviceName ?? process.env['OTEL_SERVICE_NAME'] ?? 'brandspace';
  if (provider) {
    return {
      initialized: true,
      exporting: exporterConfigured,
      serviceName,
      endpointHost: endpointHost(options.otlpEndpoint),
    };
  }

  const endpoint = options.otlpEndpoint ?? process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: options.serviceVersion ?? '0.1.0',
    'deployment.environment.name': options.environment ?? process.env['APP_ENV'] ?? 'development',
  });

  const spanProcessors = [];
  if (endpoint && endpoint.trim() !== '') {
    try {
      spanProcessors.push(
        new BatchSpanProcessor(
          new OTLPTraceExporter({
            url: `${endpoint.replace(/\/$/, '')}/v1/traces`,
            ...(options.headers ? { headers: options.headers } : {}),
          }),
        ),
      );
      exporterConfigured = true;
    } catch {
      // A bad endpoint must not stop the process from starting.
      exporterConfigured = false;
    }
  }

  provider = new NodeTracerProvider({ resource, spanProcessors });
  provider.register();

  return {
    initialized: true,
    exporting: exporterConfigured,
    serviceName,
    endpointHost: endpointHost(endpoint),
  };
}

function endpointHost(endpoint: string | undefined): string | null {
  if (!endpoint) return null;
  try {
    // Host only: an endpoint may embed credentials, and this value is shown in
    // the admin health screen.
    return new URL(endpoint).host;
  } catch {
    return null;
  }
}

export function tracingStatus(): TracingStatus {
  return {
    initialized: provider !== undefined,
    exporting: exporterConfigured,
    serviceName: process.env['OTEL_SERVICE_NAME'] ?? 'brandspace',
    endpointHost: endpointHost(process.env['OTEL_EXPORTER_OTLP_ENDPOINT']),
  };
}

export async function shutdownTracing(): Promise<void> {
  if (!provider) return;
  try {
    await provider.shutdown();
  } catch {
    // Shutdown failure is not worth propagating during process exit.
  } finally {
    provider = undefined;
    exporterConfigured = false;
  }
}

/**
 * Run `fn` inside a span.
 *
 * The span records the outcome and re-throws the original error unchanged —
 * instrumentation observes behaviour, it never alters it. If the tracer itself
 * throws, `fn` still runs.
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  let span: Span;
  try {
    span = tracer.startSpan(name, { attributes: sanitizeAttributes(attributes) });
  } catch {
    // Tracing must never be load-bearing.
    return fn({
      setAttribute: () => undefined,
      setAttributes: () => undefined,
      end: () => undefined,
      setStatus: () => undefined,
      recordException: () => undefined,
    } as unknown as Span);
  }

  try {
    return await context.with(trace.setSpan(context.active(), span), () => fn(span));
  } catch (error: unknown) {
    try {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        // The error NAME only. A message can carry a connection string.
        message: error instanceof Error ? error.name : 'UnknownError',
      });
      span.setAttribute('error.type', error instanceof Error ? error.name : 'UnknownError');
    } catch {
      // ignore
    }
    throw error;
  } finally {
    try {
      span.end();
    } catch {
      // ignore
    }
  }
}

/** Add sanitised attributes to the active span, if any. */
export function annotateActiveSpan(attributes: Attributes): void {
  try {
    trace.getActiveSpan()?.setAttributes(sanitizeAttributes(attributes));
  } catch {
    // ignore
  }
}

/** Correlation ids for structured logs — docs/ARCHITECTURE.md §3.10. */
export function currentTraceContext(): { traceId: string | null; spanId: string | null } {
  try {
    const spanContext = trace.getActiveSpan()?.spanContext();
    return { traceId: spanContext?.traceId ?? null, spanId: spanContext?.spanId ?? null };
  } catch {
    return { traceId: null, spanId: null };
  }
}
