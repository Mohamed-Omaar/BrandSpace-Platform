/**
 * Enable the QUOTA FEATURES development and end-to-end runs need.
 *
 * WHAT PROBLEM THIS SOLVES. The entitlements engine fails CLOSED, deliberately:
 * a feature nothing grants resolves to `enabled: false`, and `limit()` reports
 * 0 for a disabled feature — "not unlimited, none". That is right in
 * production, where an operator has not finished configuring the platform, and
 * it means that on a freshly seeded database `limit.storage_gb` is zero and
 * EVERY upload is refused. The whole pipeline is then untestable through the
 * product, which is how a capability ends up existing only in unit tests.
 *
 * WHAT IT DOES NOT DO, and this is the part that matters.
 *
 *   - IT ACTIVATES NO PLAN. D-06 and D-07 settled plan names and prices, but
 *     they are COMMERCIAL VALUES and CLAUDE.md §2.2 keeps them out of source —
 *     `AC-04.3` fails the build if one appears. A seed that wrote "Growth,
 *     $79, 50 GB" to make a test pass would be putting exactly that in source,
 *     under the cover of being a fixture.
 *
 *   - IT INVENTS NO LIMIT. A `feature-flags` document with `globalEnabled`
 *     turns the feature ON; the LIMIT then comes from the plan, and with no
 *     plan assigned that is `null`, which the engine already means as
 *     unlimited. So development gets a working library and the number nobody
 *     has approved is never written down anywhere.
 *
 *   - IT WEAKENS NO VALIDATION. The draft is written and activated through
 *     `ConfigurationService`, which runs the same schema parse, the same
 *     cross-domain semantic validation and the same high-impact acknowledgement
 *     an activation from Platform Admin runs.
 *
 *   - IT DOES NOT RUN ANYWHERE THAT LOOKS LIKE PRODUCTION. Two independent
 *     guards below, and both must pass.
 *
 * Idempotent: re-running activates a fresh version of the same payload.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { ConfigurationService, type ConfigActor, type Environment } from '@brandspace/config';
import { loadE2eEnv } from './env';

loadE2eEnv();

const ENVIRONMENT: Environment = 'DEVELOPMENT';
const REASON = 'Development fixture: enable the quota features the product needs to be usable.';

/**
 * The quota features that must be switched on for the product to be usable at
 * all on a freshly seeded database.
 *
 * EXACTLY THESE TWO, and each is one a customer-facing path actually consults —
 * uploading a file, and putting a post on the calendar. Turning on anything
 * else would be granting capabilities a test does not need, which is the habit
 * F-15 warns about.
 *
 * `limit.scheduled_posts` is here for precisely the reason `limit.storage_gb`
 * is: the engine fails closed, so an ungranted quota feature reports a limit of
 * ZERO — "not unlimited, none" — and every scheduling attempt is refused with a
 * quota error. The Content Calendar is then untestable through the product.
 */
/**
 * The features an end-to-end run needs switched on.
 *
 * TWO LIMITS AND ONE CAPABILITY, and the capability is here for the same reason
 * the limits are: the entitlements engine fails CLOSED, so a feature nothing
 * grants resolves to `enabled: false` and the Copilot refuses every plan that
 * would change anything. That is correct in production, where an operator has
 * not finished configuring the platform, and it makes the assistant untestable
 * through the product — which is how a capability comes to exist only in unit
 * tests.
 *
 * `ai.copilot` STILL CARRIES NO LIMIT AND NO PRICE. The flag turns it on; what
 * it costs comes from the credit rules and what a plan allows comes from the
 * plan, neither of which this seed writes.
 */
const QUOTA_FEATURES = ['limit.storage_gb', 'limit.scheduled_posts', 'ai.copilot'] as const;

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

/**
 * The seed's platform actor.
 *
 * A real `platform_user` row, with the REAL permissions read back from the role
 * it holds — never a list written here. A seed that granted itself permissions
 * would be exercising a path production does not have.
 */
async function actorFor(prisma: PrismaClient): Promise<ConfigActor> {
  const owner = await prisma.platformUser.findFirst({
    where: { deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true, roleId: true },
  });
  if (!owner) {
    throw new Error('No platform user exists. Run the database seed first (pnpm db:seed).');
  }
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

    console.log('› enabling the quota features the product needs (development only) …');

    /*
     * READ THE CURRENT FLAGS AND ADD TO THEM, rather than replacing the
     * document. A configuration document is the whole state for its domain, so
     * writing a payload with only this flag would silently REVOKE every other
     * flag an operator had set — a seed that quietly turns features off is
     * worse than one that does nothing.
     */
    const current = await configuration.get('feature-flags', ENVIRONMENT);
    const others = current.flags.filter(
      (flag) => !(QUOTA_FEATURES as readonly string[]).includes(flag.featureKey),
    );

    const draft = await configuration.createDraft(actor, 'feature-flags', ENVIRONMENT, REASON, {
      flags: [
        ...others,
        ...QUOTA_FEATURES.map((featureKey) => ({
          featureKey,
          // ON, with no limit stated. The limit comes from the plan, and with
          // no plan assigned the engine already reads that as unlimited.
          globalEnabled: true,
          killSwitch: false,
          /*
           * EVERY FIELD, EXPLICITLY, even the empty ones.
           *
           * `createDraft` stores what it is handed, so a partial flag used to
           * reach the precedence engine with `undefined` where an array was
           * expected. The projection reader now parses and fills the defaults
           * either way, but a fixture that relies on that is a fixture that
           * stops exercising the shape a real document has.
           */
          enabledForPlans: [],
          enabledForWorkspaces: [],
          disabledForWorkspaces: [],
          betaGroups: [],
          countries: [],
          activeFrom: null,
          activeUntil: null,
          percentageRollout: null,
        })),
      ],
    });

    // The SAME validation an activation from Platform Admin runs.
    const report = await configuration.validateDraft(actor, draft.id);
    if (!report.valid) {
      throw new Error(
        `The quota fixture failed validation: ${report.issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join('; ')}`,
      );
    }
    await configuration.activate(actor, draft.id, { acknowledgeHighImpact: true });

    console.log(`\n✔ ${QUOTA_FEATURES.join(', ')} enabled with no configured ceiling`);
    console.log('  No plan, no price and no quota value was written.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
