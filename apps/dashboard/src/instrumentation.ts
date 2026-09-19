/**
 * Next.js instrumentation hook — runs once per server process, before any
 * request is handled.
 *
 * WHAT IT IS HERE FOR: the customer application's key-domain boundary (F-07,
 * D-206). This process verifies a TOTP code at sign-in, so it holds the
 * CUSTOMER MFA key and must hold neither of the other two — a login request
 * that could unwrap a platform provider credential or another customer's OAuth
 * token is precisely the reach the three domains exist to deny.
 *
 * That rule was written in `docs/SECURITY.md`, in the Railway blueprint and in
 * the environment matrix, and checked by nothing at boot. It is checked now: in
 * production this throws and the dashboard does not come up; everywhere else it
 * warns, because a developer with half an environment should still get a
 * running server.
 */
export async function register(): Promise<void> {
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') return;

  const { validateStartupConfiguration } = await import('@brandspace/shared');
  const configuration = validateStartupConfiguration(process.env, 'dashboard');
  if (!configuration.ok) {
    console.warn(
      `[dashboard] configuration is incomplete (${configuration.environment}):\n` +
        configuration.problems.join('\n'),
    );
  }
}
