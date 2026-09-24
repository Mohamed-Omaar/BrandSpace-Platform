/**
 * DEVELOPMENT FIXTURE — a small, real feature registry for the Simple Features
 * screen (D-314).
 *
 * WHAT PROBLEM THIS SOLVES. The end-to-end database had flags for five
 * features and an EMPTY registry, so the owner's Features screen could only
 * ever show its empty state, and the ON/OFF flow could only be exercised
 * against a feature a test invented on the spot. This registers four features
 * the product actually documents (docs/PRODUCT.md §10A.4), so the flow runs
 * against seeded, product-shaped data.
 *
 * WHY THESE FOUR, AND WHY IT IS SAFE TO FLIP THEM IN A SHARED RUN. Team
 * approvals, Marketing Intelligence, Advanced governance and SSO are documented
 * boolean capabilities that NO code path gates on yet — each key has zero
 * `entitlements.can(...)` callers. Registering them, or switching one on for
 * everyone for a few seconds, changes what the registry and the customer's
 * plan page SAY and nothing any other suite exercises.
 *
 * WHAT IT DOES NOT DO. It invents no price, no limit and no plan. The one grant
 * it writes — Team approvals on the Growth fixture plan — mirrors the product
 * matrix, and is written only when that plan exists in the active catalogue.
 * It goes through `ConfigurationService` (draft, validate, activate) exactly as
 * an operator's change would, adds to the active document rather than
 * replacing it, and refuses production and non-local databases.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { ConfigurationService, type ConfigActor, type Environment } from '@brandspace/config';
import { loadE2eEnv } from './env';

loadE2eEnv();

const ENVIRONMENT: Environment = 'DEVELOPMENT';
const REASON = 'Development fixture: register documented product features for the owner screens.';

const FEATURES = [
  {
    key: 'approvals.workflow',
    name: { en: 'Team approvals', ar: 'موافقات الفريق' },
    category: 'collaboration',
  },
  {
    key: 'intelligence.market',
    name: { en: 'Marketing Intelligence', ar: 'ذكاء التسويق' },
    category: 'intelligence',
  },
  {
    key: 'governance.advanced',
    name: { en: 'Advanced governance', ar: 'الحوكمة المتقدمة' },
    category: 'governance',
  },
  {
    key: 'security.sso',
    name: { en: 'Single sign-on (SSO)', ar: 'تسجيل الدخول الموحّد (SSO)' },
    category: 'security',
  },
] as const;

/** Mirrors the product matrix: Team approvals from Growth up. */
const GRANTS = [{ planKey: 'fixture-growth', featureKey: 'approvals.workflow' }] as const;

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

/** A real platform user with the permissions its role actually holds. */
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

async function main(): Promise<void> {
  assertNotProduction();
  const prisma = platformClient();
  try {
    const actor = await actorFor(prisma);
    const configuration = new ConfigurationService({ prisma, cacheTtlMs: 0 });
    console.log('› registering documented product features (development only) …');

    const [current, plans] = await Promise.all([
      configuration.get('entitlements', ENVIRONMENT),
      configuration.get('plans', ENVIRONMENT),
    ]);
    const planKeys = new Set(plans.plans.map((plan) => plan.key));

    // ADD TO the active document; an existing definition or grant wins.
    const features = [
      ...current.features,
      ...FEATURES.filter((feature) => !current.features.some((f) => f.key === feature.key)).map(
        (feature) => ({
          key: feature.key,
          name: { ...feature.name },
          category: feature.category,
          valueType: 'boolean' as const,
          defaultValue: false,
          enumValues: [],
          dependsOn: [],
          status: 'active' as const,
        }),
      ),
    ];
    const planEntitlements = [
      ...current.planEntitlements,
      ...GRANTS.filter(
        (grant) =>
          planKeys.has(grant.planKey) &&
          !current.planEntitlements.some(
            (row) => row.planKey === grant.planKey && row.featureKey === grant.featureKey,
          ),
      ).map((grant) => ({
        planKey: grant.planKey,
        featureKey: grant.featureKey,
        enabled: true,
        limitValue: null,
        limitPeriod: null,
        enumValue: null,
      })),
    ];

    if (
      features.length === current.features.length &&
      planEntitlements.length === current.planEntitlements.length
    ) {
      console.log('✔ already registered; nothing to do');
      return;
    }

    const draft = await configuration.createDraft(actor, 'entitlements', ENVIRONMENT, REASON, {
      ...current,
      features,
      planEntitlements,
    });
    const report = await configuration.validateDraft(actor, draft.id);
    if (!report.valid) {
      throw new Error(
        `The feature fixture failed validation: ${report.issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join('; ')}`,
      );
    }
    await configuration.activate(actor, draft.id, { acknowledgeHighImpact: true });
    console.log(`\n✔ ${FEATURES.map((feature) => feature.key).join(', ')} registered`);
    console.log('  No price, no limit and no plan was written.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
