/**
 * One-off STAGING customer smoke-account cleanup.
 * Refuses every environment except staging and refuses accounts with tenant data.
 */
import { getPlatformClient } from '@brandspace/database/platform';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  if (process.env['APP_ENV'] !== 'staging') {
    throw new Error('Refusing to run outside staging.');
  }

  const email = required('SMOKE_CLEANUP_EMAIL').toLowerCase();
  const prisma = getPlatformClient();

  try {
    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        status: true,
        _count: {
          select: {
            memberships: true,
            ownedWorkspaces: true,
          },
        },
      },
    });

    if (!user) {
      console.log('STAGING_CUSTOMER_CLEANUP_NOT_FOUND');
      return;
    }

    if (user._count.ownedWorkspaces !== 0 || user._count.memberships !== 0) {
      throw new Error(
        `Refusing cleanup: account has tenant data (workspaces=${user._count.ownedWorkspaces}, memberships=${user._count.memberships}).`,
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.customerSession.deleteMany({ where: { userId: user.id } });
      await tx.passwordResetToken.deleteMany({ where: { userId: user.id } });
      await tx.emailVerificationToken.deleteMany({ where: { userId: user.id } });
      await tx.userLegalAcceptance.deleteMany({ where: { userId: user.id } });
      await tx.userMfaRecoveryCode.deleteMany({ where: { userId: user.id } });
      await tx.user.delete({ where: { id: user.id } });
    });

    const remains = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (remains) throw new Error('Cleanup verification failed: customer account still exists.');

    console.log('STAGING_CUSTOMER_CLEANUP_OK');
    console.log('tenant_workspaces=0');
    console.log('tenant_memberships=0');
    console.log('customer_account_exists=false');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Staging customer cleanup failed.');
  process.exitCode = 1;
});
