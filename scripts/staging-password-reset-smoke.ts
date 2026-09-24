/**
 * One-off STAGING password-reset smoke test.
 * Refuses every environment except staging.
 */
import { getPrisma } from '@brandspace/database';
import { ApiEmailProvider, CustomerAuthService } from '@brandspace/auth';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  if (process.env['APP_ENV'] !== 'staging') {
    throw new Error('Refusing to run outside staging.');
  }

  const email = required('SMOKE_RESET_EMAIL').toLowerCase();
  const dashboardBase = required('PUBLIC_DASHBOARD_BASE_URL').replace(/\/+$/, '');
  const prisma = getPrisma();

  try {
    const auth = new CustomerAuthService({ prisma });
    const issued = await auth.beginPasswordReset(email);
    if (!issued) throw new Error('No reset token was issued for the staging account.');

    const provider = new ApiEmailProvider();
    const sent = await provider.send({
      to: email,
      templateKey: 'auth.password_reset',
      locale: 'EN',
      link: `${dashboardBase}/en/reset/${encodeURIComponent(issued.token)}`,
    });

    console.log('STAGING_PASSWORD_RESET_SMOKE_OK');
    console.log(`message_id_present=${Boolean(sent.messageId)}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Staging password-reset smoke failed.');
  process.exitCode = 1;
});
