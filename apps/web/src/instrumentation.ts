/**
 * Next.js instrumentation hook — runs once per server process, before any
 * request is handled.
 *
 * THE MARKETING SITE HOLDS NOTHING, AND THAT IS WORTH CHECKING. It is the most
 * exposed service in the fleet and serves only public pages, so it carries no
 * database role, no session key, no key domain and no AWS credentials. A
 * variable that drifts onto it — copied from another service while debugging,
 * or left behind by a template — would hand whoever reaches this process a
 * capability the product never intended it to have.
 *
 * In production this throws and the site does not come up; everywhere else it
 * warns.
 */
export async function register(): Promise<void> {
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') return;

  const { validateStartupConfiguration } = await import('@brandspace/shared');
  const configuration = validateStartupConfiguration(process.env, 'web');
  if (!configuration.ok) {
    console.warn(
      `[web] configuration is incomplete (${configuration.environment}):\n` +
        configuration.problems.join('\n'),
    );
  }
}
