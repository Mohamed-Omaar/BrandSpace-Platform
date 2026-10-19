/**
 * DEVELOPMENT FIXTURE — CONNECTED AI APPS ON, FOR EVERY PLAN (D-566).
 *
 * WHAT IT MIRRORS. The owner's answer Q5: on for all plans on staging, off in
 * production. This switches `ai-apps` on and grants `feature.ai_apps` to every
 * plan in the active catalogue — exactly what the owner does from Simple → AI
 * apps — so the consent screen, Settings → Connected AI apps and the Control
 * Center card are exercised against configuration, never against a code path
 * that skips it.
 *
 * WHY THE PER-ADDRESS CEILINGS ARE RAISED. Every app registration in the suite
 * comes from 127.0.0.1; at the shipped 20 an hour, a second local run inside
 * the hour would be refused. The ceilings themselves are proved in the
 * isolation suite.
 *
 * WHY HERE AND NOT IN A SPEC. Configuration is environment-wide and the
 * Control Center suites edit the `entitlements` drafts in parallel; activating
 * it once, before the run, keeps every spec read-only on configuration.
 *
 * It goes through `ConfigurationService` (draft, validate, activate), adds to
 * the active documents rather than replacing them, is idempotent, and refuses
 * production and non-local databases.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import {
  ConfigurationService,
  type ConfigActor,
  type ConfigDomain,
  type Environment,
} from '@brandspace/config';
import { AI_APPS_FEATURE, AI_APPS_FEATURE_DEFINITION } from '@brandspace/entitlements';
import { loadE2eEnv } from './env';

loadE2eEnv();

const ENVIRONMENT: Environment = 'DEVELOPMENT';
const REASON =
  'Development fixture: connected AI apps on for every plan (D-566, staging answer Q5).';

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
  domain: ConfigDomain,
  payload: unknown,
): Promise<void> {
  const draft = await configuration.createDraft(actor, domain, ENVIRONMENT, REASON, payload);
  const report = await configuration.validateDraft(actor, draft.id);
  if (!report.valid) {
    throw new Error(
      `The AI apps fixture failed validation (${domain}): ${report.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  await configuration.activate(actor, draft.id, { acknowledgeHighImpact: true });
  console.log(`  activated ${domain} v${draft.versionNumber}`);
}

async function main(): Promise<void> {
  assertNotProduction();
  const prisma = platformClient();
  try {
    const actor = await actorFor(prisma);
    const configuration = new ConfigurationService({ prisma, cacheTtlMs: 0 });
    console.log('› connected AI apps on for every plan (development only) …');

    const [aiApps, entitlements, plans] = await Promise.all([
      configuration.get('ai-apps', ENVIRONMENT),
      configuration.get('entitlements', ENVIRONMENT),
      configuration.get('plans', ENVIRONMENT),
    ]);

    const wantedAiApps = {
      ...aiApps,
      enabled: true,
      oauth: { ...aiApps.oauth, registrationPerIpPerHour: 1_000, tokenPerIpPerMinute: 1_000 },
    };
    if (JSON.stringify(wantedAiApps) !== JSON.stringify(aiApps)) {
      await activate(configuration, actor, 'ai-apps', wantedAiApps);
    }

    const planKeys = plans.plans.map((plan) => plan.key);
    const features = entitlements.features.some((feature) => feature.key === AI_APPS_FEATURE)
      ? entitlements.features
      : [
          ...entitlements.features,
          {
            ...AI_APPS_FEATURE_DEFINITION,
            name: { ...AI_APPS_FEATURE_DEFINITION.name },
            enumValues: [],
            dependsOn: [],
          },
        ];
    const missing = planKeys.filter(
      (planKey) =>
        !entitlements.planEntitlements.some(
          (row) => row.planKey === planKey && row.featureKey === AI_APPS_FEATURE && row.enabled,
        ),
    );
    if (missing.length > 0 || features.length !== entitlements.features.length) {
      await activate(configuration, actor, 'entitlements', {
        ...entitlements,
        features,
        planEntitlements: [
          ...entitlements.planEntitlements.filter(
            (row) => !(row.featureKey === AI_APPS_FEATURE && missing.includes(row.planKey)),
          ),
          ...missing.map((planKey) => ({
            planKey,
            featureKey: AI_APPS_FEATURE,
            enabled: true,
            limitValue: null,
            limitPeriod: null,
            enumValue: null,
          })),
        ],
      });
    }
    console.log(`✔ connected AI apps on; included in ${planKeys.length} plan(s)`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
