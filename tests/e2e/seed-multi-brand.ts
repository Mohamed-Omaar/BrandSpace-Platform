/**
 * DEVELOPMENT FIXTURE — `feature.multi_brand` for the ONE fixture workspace
 * that has several brands (Q2b, D-327).
 *
 * WHAT PROBLEM THIS SOLVES. Multi-brand is OFF for every customer: the flag is
 * registered by nobody in code, so it resolves `unknown_feature` and fails
 * closed. The primary end-to-end workspace, though, deliberately has two
 * brands, and the brand-context, approvals and Phase 8 suites exercise the
 * brand selector against them. Those suites need multi-brand switched on — for
 * THAT workspace only — so every other workspace a run creates (sign-up,
 * onboarding, the Phase 2B-1 suites) meets the product exactly as a customer
 * does, with multi-brand off.
 *
 * HOW. The way an operator would: the feature is registered in the
 * `entitlements` document (boolean, default OFF) and a `feature-flags` rule
 * turns it on for that one workspace by id. Both go through
 * `ConfigurationService` (draft, validate, activate), add to the active
 * documents rather than replacing them, and refuse production and non-local
 * databases. Nothing here writes a plan, a price or a limit.
 */
import { readFileSync } from 'node:fs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { ConfigurationService, type ConfigActor, type Environment } from '@brandspace/config';
import { E2E_CREDENTIALS_FILE, loadE2eEnv, type E2eAdminCredentials } from './env';

loadE2eEnv();

const ENVIRONMENT: Environment = 'DEVELOPMENT';
const REASON = 'Development fixture: multi-brand for the one multi-brand fixture workspace.';
const FEATURE_KEY = 'feature.multi_brand';

function assertNotProduction(): void {
  if ((process.env['APP_ENV'] ?? 'development') === 'production') {
    throw new Error('This seed refuses to run against a production deployment.');
  }
  const url = process.env['DATABASE_PLATFORM_URL'] ?? '';
  if (!/localhost|127\.0\.0\.1/.test(url)) {
    throw new Error('This seed refuses to run against a non-local database.');
  }
}

function platformClient(): PrismaClient {
  const connectionString = process.env['DATABASE_PLATFORM_URL'];
  if (!connectionString) throw new Error('DATABASE_PLATFORM_URL is required.');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

async function actorFor(prisma: PrismaClient): Promise<ConfigActor> {
  const owner = await prisma.platformUser.findFirst({
    where: { deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true, roleId: true },
  });
  if (!owner) throw new Error('No platform user exists. Run the database seed first.');
  const grants = await prisma.rolePermission.findMany({
    where: { roleId: owner.roleId },
    include: { permission: true },
  });
  return {
    platformUserId: owner.id,
    roleKey: 'platform_owner',
    mfaVerified: true,
    permissionKeys: grants.map((grant) => grant.permission.key),
  };
}

async function activate(
  configuration: ConfigurationService,
  actor: ConfigActor,
  domain: 'entitlements' | 'feature-flags',
  payload: Record<string, unknown>,
): Promise<void> {
  const draft = await configuration.createDraft(actor, domain, ENVIRONMENT, REASON, payload);
  const report = await configuration.validateDraft(actor, draft.id);
  if (!report.valid) {
    throw new Error(
      `The multi-brand fixture failed validation: ${report.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  await configuration.activate(actor, draft.id, { acknowledgeHighImpact: true });
}

async function main(): Promise<void> {
  assertNotProduction();
  const credentials = JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
  const workspaceId = credentials.customer.workspaceId;

  const prisma = platformClient();
  try {
    const actor = await actorFor(prisma);
    const configuration = new ConfigurationService({ prisma, cacheTtlMs: 0 });
    console.log('› switching multi-brand on for the multi-brand fixture workspace …');

    const entitlements = await configuration.get('entitlements', ENVIRONMENT);
    if (!entitlements.features.some((feature) => feature.key === FEATURE_KEY)) {
      await activate(configuration, actor, 'entitlements', {
        ...entitlements,
        features: [
          ...entitlements.features,
          {
            key: FEATURE_KEY,
            name: { en: 'Several brands in one workspace', ar: 'عدة علامات تجارية في مساحة واحدة' },
            category: 'workspace',
            valueType: 'boolean',
            // OFF for everyone (Q2b): only the rule below turns it on.
            defaultValue: false,
            enumValues: [],
            dependsOn: [],
            status: 'active',
          },
        ],
      });
    }

    const flags = await configuration.get('feature-flags', ENVIRONMENT);
    const existing = flags.flags.find((flag) => flag.featureKey === FEATURE_KEY);
    if (existing?.enabledForWorkspaces.includes(workspaceId)) {
      console.log('✔ already on for the fixture workspace; nothing to do');
      return;
    }
    await activate(configuration, actor, 'feature-flags', {
      flags: [
        ...flags.flags.filter((flag) => flag.featureKey !== FEATURE_KEY),
        {
          featureKey: FEATURE_KEY,
          killSwitch: false,
          // Nobody, except the workspace listed below.
          globalEnabled: false,
          enabledForPlans: [],
          enabledForWorkspaces: [...(existing?.enabledForWorkspaces ?? []), workspaceId],
          disabledForWorkspaces: [],
          betaGroups: [],
          countries: [],
          activeFrom: null,
          activeUntil: null,
          percentageRollout: null,
        },
      ],
    });
    console.log(`✔ ${FEATURE_KEY} on for workspace ${workspaceId} only`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
