/**
 * Next.js instrumentation hook — runs once per server process before any
 * request is handled. Initialising tracing here means admin API requests,
 * configuration reads and secret operations are all inside a trace.
 */
export async function register(): Promise<void> {
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') return;

  /*
   * THE ENVIRONMENT CONTRACT, ACTUALLY RUN (D-215).
   *
   * The Control Center holds the platform secret vault key and no other key
   * domain. Until now only `api` and `worker` checked their own boundary at
   * boot, so the rule that this service must NOT hold the social-token or
   * customer-MFA key was written down in three documents and enforced by
   * nothing. In production this throws and the process does not come up;
   * everywhere else it warns, because a developer with half an environment
   * should get a readable message and a running server.
   */
  const { validateStartupConfiguration } = await import('@brandspace/shared');
  const configuration = validateStartupConfiguration(process.env, 'admin');
  if (!configuration.ok) {
    console.warn(
      `[admin] configuration is incomplete (${configuration.environment}):\n` +
        configuration.problems.join('\n'),
    );
  }

  const { initializeTracing } = await import('@brandspace/observability');
  initializeTracing({ serviceName: process.env['OTEL_SERVICE_NAME'] ?? 'brandspace-admin' });
}
