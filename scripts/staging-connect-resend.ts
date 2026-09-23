/**
 * One-off STAGING Resend connection.
 * Refuses every environment except staging.
 */
import { getPlatformClient } from '@brandspace/database/platform';
import { ConfigurationService } from '@brandspace/config';
import { SecretService } from '@brandspace/secrets';
import { IntegrationsService } from '@brandspace/integrations';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  if (process.env['APP_ENV'] !== 'staging') {
    throw new Error('Refusing to run outside staging.');
  }

  const apiKey = required('STAGING_RESEND_API_KEY');
  const prisma = getPlatformClient();
  try {
    const owner = await prisma.platformUser.findUnique({
      where: { email: 'owner@staging.brandspace.cc' },
      include: {
        role: {
          include: {
            permissions: { include: { permission: true } },
          },
        },
      },
    });
    if (!owner) throw new Error('Staging Platform Owner not found.');

    const actor = {
      platformUserId: owner.id,
      roleKey: owner.role.key,
      mfaVerified: true,
      permissionKeys: owner.role.permissions.map((row) => row.permission.key),
    };

    const configuration = new ConfigurationService({ prisma });
    const secrets = new SecretService({ prisma });
    const integrations = new IntegrationsService({ prisma, configuration, secrets });

    await integrations.saveConfiguration({
      actor,
      category: 'email',
      providerKey: 'resend',
      environment: 'STAGING',
      settings: {
        fromEmail: 'no-reply@staging.brandspace.cc',
        fromName: 'BrandSpace',
        replyTo: '',
      },
      credentials: { apiKey },
      reason: 'Connect Resend for staging transactional email.',
    });

    const active = (await configuration.get('integrations.email', 'STAGING')) as {
      activeProviderKey: string | null;
      providers: Array<{
        key: string;
        name: string;
        status: string;
        settings: Record<string, string>;
        secretRefs: Record<string, string>;
      }>;
    };

    const next = structuredClone(active);
    const provider = next.providers.find((p) => p.key === 'resend');
    if (!provider) throw new Error('Resend provider record missing after save.');
    provider.status = 'active';
    next.activeProviderKey = 'resend';

    const draft = await configuration.createDraft(
      actor,
      'integrations.email',
      'STAGING',
      'Activate Resend for staging transactional email.',
      next,
    );
    await configuration.activate(actor, draft.id);

    const view = await integrations.get(actor, 'email', 'resend', 'STAGING');
    console.log('STAGING_RESEND_CONNECTED_OK');
    console.log(`enabled=${view.enabled}`);
    console.log(`configuration_complete=${view.configurationComplete}`);
    console.log(`credential_present=${view.credentials.find((c) => c.fieldKey === 'apiKey')?.present === true}`);
    console.log(`from_email=${view.settings['fromEmail'] ?? ''}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Staging Resend connection failed.');
  process.exitCode = 1;
});
