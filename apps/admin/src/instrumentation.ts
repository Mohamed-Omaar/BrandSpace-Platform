/**
 * Next.js instrumentation hook — runs once per server process before any
 * request is handled. Initialising tracing here means admin API requests,
 * configuration reads and secret operations are all inside a trace.
 */
export async function register(): Promise<void> {
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') return;
  const { initializeTracing } = await import('@brandspace/observability');
  initializeTracing({ serviceName: process.env['OTEL_SERVICE_NAME'] ?? 'brandspace-admin' });
}
