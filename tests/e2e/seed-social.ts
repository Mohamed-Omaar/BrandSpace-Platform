/**
 * One connected account and one publish job, so the Phase 6 suite has real rows
 * to render.
 *
 * WHY A FIXTURE AND NOT A REAL CONNECTION. Completing an OAuth flow needs a
 * provider to redirect to, and every platform in this phase requires business
 * verification and app review before it issues a credential (D-18, D-19) — an
 * owner-driven process measured in weeks. The end-to-end suite therefore seeds
 * the PRECONDITION and tests the screen, which is what it is a test of. The
 * flow's own security properties are settled against real PostgreSQL in
 * `tests/isolation/phase6-oauth-security.test.ts`, where they can be.
 *
 * NO REAL TOKEN AND NO REAL KEY IS USED. The credential below is sealed with a
 * visibly fake, test-only KEK and decrypts to a visibly fake token. Nothing
 * here would work against any platform.
 *
 * WRITTEN THROUGH THE TENANT CLIENT inside a workspace transaction, so RLS
 * applies to it exactly as it does to a real connection and a mistake fails
 * rather than writing across a tenant.
 *
 * Idempotent: keyed on fixed identifiers, so re-running resets the fixture
 * rather than growing it on every seed.
 */
import { readFileSync } from 'node:fs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { withWorkspace } from '@brandspace/database';
import { ConfigurationService, type ConfigActor, type Environment } from '@brandspace/config';
import { SecretService } from '@brandspace/secrets';
import { SocialTokenVault } from '@brandspace/social-connectors';
import { E2E_CREDENTIALS_FILE, loadE2eEnv, type E2eAdminCredentials } from './env';

loadE2eEnv();

const EXTERNAL_ACCOUNT_ID = 'e2e-linkedin-organization';
const DISPLAY_NAME = 'E2E Organization';
const PUBLISH_KEY = 'e2e-publish-fixture';
const ITEM_KEY = 'e2e-publishing-fixture';
const ITEM_TITLE = 'Declined announcement';
/** Fixed, so the screen renders the same string on every run. */
const SCHEDULED_LOCAL_TIME = '2026-01-15T09:00';

/**
 * A FIXED, TEST-ONLY key-encryption key.
 *
 * Explicit rather than read from the environment so the seed encrypts the same
 * way on every machine. It is visibly fake and protects nothing real.
 */
const E2E_SOCIAL_KEK = 'e2e-only-social-token-kek-00000000000000';

/** Visibly fake, and the only "credential" anywhere in this phase's tests. */
const CLIENT_SECRET_REF = 'social/linkedin/e2e-mock-client-secret';
const MOCK_CLIENT_SECRET = 'e2e-only-not-a-real-client-secret';

const ENVIRONMENT: Environment = 'DEVELOPMENT';
const REASON = 'End-to-end fixture: enable the social providers the suite renders.';

/**
 * ENABLE THE PROVIDERS, THROUGH THE REAL CONFIGURATION SERVICE.
 *
 * Providers are DISABLED by default — that is the safe default, and a newly
 * deployed environment must not offer a connection nobody has configured an
 * application for. So the fixture turns them on the way an owner would: a
 * draft, the same schema parse, the same cross-domain validation, the same
 * high-impact acknowledgement, and an activation. It weakens nothing.
 *
 * NO CREDENTIAL IS WRITTEN. `publishing` carries what a platform CAN do; app
 * ids and client secrets live in `integrations.social-apps`, which this seed
 * does not touch and which is never projected to tenants.
 */
/** The Platform Owner, with their real permission set. No private door. */
async function platformActor(prisma: PrismaClient): Promise<ConfigActor> {
  const owner = await prisma.platformUser.findFirstOrThrow({
    where: { status: 'ACTIVE' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, roleId: true },
  });
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

async function enableProviders(prisma: PrismaClient, actor: ConfigActor): Promise<void> {
  const configuration = new ConfigurationService({ prisma, cacheTtlMs: 0 });
  const current = await configuration.get('publishing', ENVIRONMENT);

  /*
   * EACH PROVIDER DECLARES THE SHAPES IT ACCEPTS, as an owner would. Text and
   * image everywhere keeps the publishing journeys independent of the format
   * work; the extras are what the Create Post format filter (D-283 §18) reads,
   * so a reel is offered on Instagram and TikTok and not on LinkedIn.
   */
  const capability = (scopes: string[], targetKind: string, extraKinds: string[]) => ({
    enabled: true,
    postKinds: ['text', 'image', ...extraKinds],
    maxBodyCharacters: 2_200,
    maxHashtags: 30,
    maxMediaItems: 10,
    supportsFirstComment: false,
    supportsDelete: false,
    supportsNativeScheduling: false,
    supportsPostLookup: true,
    scopes,
    targetKind,
  });

  const draft = await configuration.createDraft(actor, 'publishing', ENVIRONMENT, REASON, {
    ...current,
    providers: {
      facebook: capability(['pages_manage_posts'], 'page', ['carousel', 'video', 'reel', 'story']),
      instagram: capability(['instagram_content_publish'], 'business_account', [
        'carousel',
        'video',
        'reel',
        'story',
      ]),
      tiktok: capability(['video.publish'], 'creator_account', ['video', 'reel']),
      linkedin: capability(['w_member_social'], 'organization', ['carousel', 'video', 'article']),
      x: capability(['tweet.write'], 'profile', ['video', 'thread']),
    },
  });

  const report = await configuration.validateDraft(actor, draft.id);
  if (!report.valid) {
    throw new Error(
      `The publishing fixture failed validation: ${report.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  await configuration.activate(actor, draft.id, { acknowledgeHighImpact: true });
}

/**
 * CONFIGURE THE PLATFORM'S OWN MOCK APPLICATION, so the callback can be walked.
 *
 * WHY THIS EXISTS NOW AND DID NOT BEFORE. The first version of this fixture
 * stopped at the connect BUTTON: the suite rendered the screen and never
 * pressed it, because `applicationResolver()` needs an active row in
 * `integrations.social-apps` and a client secret to resolve — and neither was
 * seeded. That is exactly why the callback could be registered at a path no
 * provider would ever reach and CI stayed green (P6-R1). A route nothing
 * exercises is a route nothing tests.
 *
 * NOTHING REAL IS WRITTEN. The app id and the client secret are visibly fake
 * and would be rejected by any platform on first use. The secret goes through
 * the REAL Secret Service — encrypted at rest, masked on read, never returned
 * by an API — because a fixture that wrote a credential some other way would be
 * testing a path production does not have.
 */
async function configureMockApplication(prisma: PrismaClient, actor: ConfigActor): Promise<void> {
  /*
   * INFORMATIONAL ONLY, AND DELIBERATELY SO. `applicationResolver()` builds the
   * redirect from the API's OWN `PUBLIC_API_BASE_URL` at request time and
   * ignores whatever this document says, precisely so one activated
   * configuration is correct in every environment. The schema requires a URL, so
   * one is recorded; if it disagrees with the running API the exact-match check
   * in `complete()` is unaffected, because both sides of that comparison come
   * from the API.
   */
  const apiBase = process.env['PUBLIC_API_BASE_URL'] ?? 'http://127.0.0.1:3103';

  const secrets = new SecretService({ prisma });
  const secretActor = {
    platformUserId: actor.platformUserId,
    roleKey: actor.roleKey,
    mfaVerified: true,
    permissionKeys: actor.permissionKeys,
  };
  const existing = await prisma.secretRecord.findUnique({
    where: { ref_environment: { ref: CLIENT_SECRET_REF, environment: ENVIRONMENT } },
  });
  if (!existing) {
    await secrets.createSecret(secretActor, {
      ref: CLIENT_SECRET_REF,
      name: 'End-to-end mock LinkedIn client secret',
      category: 'social_oauth_app',
      environment: ENVIRONMENT,
      value: MOCK_CLIENT_SECRET,
      description: 'Test-only. Visibly fake, and rejected by every real platform.',
    });
  }

  const configuration = new ConfigurationService({ prisma, cacheTtlMs: 0 });
  const current = (await configuration.get('integrations.social-apps', ENVIRONMENT)) as {
    applications?: readonly unknown[];
  };
  const draft = await configuration.createDraft(
    actor,
    'integrations.social-apps',
    ENVIRONMENT,
    'End-to-end fixture: a visibly fake social application, so the callback is walkable.',
    {
      ...current,
      applications: [
        {
          providerKey: 'linkedin',
          appId: 'e2e-only-mock-app-id',
          // THE SAME URL `callbackUriFor()` BUILDS. If these ever disagree the
          // exact-match check in `complete()` refuses the callback, which is
          // the behaviour under test rather than a fixture detail.
          redirectUri: `${apiBase.replace(/\/+$/, '')}/v1/social/callback/linkedin`,
          scopes: ['w_member_social'],
          clientSecretRef: CLIENT_SECRET_REF,
          webhookSecretRef: null,
          status: 'active',
        },
      ],
    },
  );
  const report = await configuration.validateDraft(actor, draft.id);
  if (!report.valid) {
    throw new Error(
      `The social-application fixture failed validation: ${report.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  await configuration.activate(actor, draft.id, { acknowledgeHighImpact: true });
}

function credentials(): E2eAdminCredentials {
  return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
}

/**
 * RESOLVING A WORKSPACE BY SLUG IS A PLATFORM QUESTION, and the tenant client
 * cannot answer it: with no workspace context set, RLS returns nothing — which
 * is the policy working rather than a problem with it. So the lookup runs on the
 * platform client and EVERYTHING AFTER IT runs on the tenant client inside
 * `withWorkspace`, so the fixture rows are written under exactly the RLS a real
 * connection's are. The same split `seed-content.ts` uses.
 */
function platformClient(): PrismaClient {
  const connectionString = process.env['DATABASE_PLATFORM_URL'];
  if (!connectionString) throw new Error('DATABASE_PLATFORM_URL is required.');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

async function main(): Promise<void> {
  const tenantUrl = process.env['DATABASE_URL'];
  if (!tenantUrl) throw new Error('DATABASE_URL is required to seed the social fixture.');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: tenantUrl }) });
  const platform = platformClient();

  try {
    const { customer } = credentials();
    const workspace = await platform.workspace.findFirst({
      where: { slug: customer.workspaceSlug },
      select: { id: true },
    });
    if (!workspace) {
      throw new Error(
        `No workspace with slug "${customer.workspaceSlug}". ` +
          'Run `tsx tests/e2e/seed-admin.ts` first.',
      );
    }
    const workspaceId = workspace.id;

    const actor = await platformActor(platform);
    await enableProviders(platform, actor);
    await configureMockApplication(platform, actor);

    const vault = new SocialTokenVault({
      env: { SOCIAL_TOKEN_VAULT_KEK: E2E_SOCIAL_KEK } as NodeJS.ProcessEnv,
    });

    await withWorkspace(
      workspaceId,
      async (db) => {
        const brand = await db.brand.findFirst({
          where: { status: 'ACTIVE' },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        });
        if (!brand)
          throw new Error('The end-to-end workspace has no brand to connect an account to.');

        const user = await db.membership.findFirst({
          where: { status: 'ACTIVE' },
          orderBy: { createdAt: 'asc' },
          select: { userId: true },
        });

        /*
         * RESET RATHER THAN ACCUMULATE. A publish job holds a RESTRICT key on
         * its connection, so the jobs go first — which is the constraint doing
         * exactly what it was written for: a published post is a fact about the
         * outside world and must not be erased by deleting a connection.
         */
        const existing = await db.socialConnection.findFirst({
          where: { externalAccountId: EXTERNAL_ACCOUNT_ID },
        });
        if (existing) {
          await db.publishJob.deleteMany({ where: { socialConnectionId: existing.id } });
          await db.socialCredential.deleteMany({ where: { socialConnectionId: existing.id } });
          await db.socialConnection.delete({ where: { id: existing.id } });
        }

        const connection = await db.socialConnection.create({
          data: {
            workspaceId,
            brandId: brand.id,
            provider: 'LINKEDIN',
            externalAccountId: EXTERNAL_ACCOUNT_ID,
            displayName: DISPLAY_NAME,
            targetKind: 'organization',
            status: 'ACTIVE',
            grantedScopes: ['w_member_social'],
            connectedAt: new Date(),
            // Far enough out that the "expiring soon" notice does not fire and
            // make the screen assert differently on different days.
            tokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
            lastSyncedAt: new Date(),
            lastCheckedAt: new Date(),
            ...(user ? { connectedByUserId: user.userId } : {}),
          },
        });

        const sealed = await vault.seal({
          workspaceId,
          socialConnectionId: connection.id,
          version: 1,
          material: {
            accessToken: 'e2e-fake-access-token-not-real',
            refreshToken: 'e2e-fake-refresh-token-not-real',
          },
        });
        await db.socialCredential.create({
          data: {
            workspaceId,
            socialConnectionId: connection.id,
            version: 1,
            ciphertext: sealed.ciphertext,
            iv: sealed.iv,
            authTag: sealed.authTag,
            wrappedDataKey: sealed.wrappedDataKey,
            keyProvider: sealed.keyProvider,
            keyId: sealed.keyId,
            algorithm: sealed.algorithm,
            encryptionContext: sealed.encryptionContext,
            maskedHint: sealed.maskedHint,
            fingerprint: sealed.fingerprint,
            accessTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
            hasRefreshToken: true,
          },
        });

        /*
         * ITS OWN CONTENT, ITS OWN VARIANT, ITS OWN SLOT.
         *
         * The first version reached for whatever draft and slot happened to be
         * in the workspace, and passed — until a run where the calendar suite
         * had not left a live slot behind, at which point it silently created
         * no job and the publishing screen rendered empty. A fixture whose
         * starting state depends on whether another suite ran first is the
         * coupling `seed-content.ts` documents avoiding, and it produces a
         * failure that points nowhere near its cause.
         *
         * So this seeds the whole chain itself and shares nothing.
         */
        await db.publishJob.deleteMany({ where: { idempotencyKey: PUBLISH_KEY } });

        const existingItem = await db.contentItem.findFirst({
          where: { idempotencyKey: ITEM_KEY },
          include: { variants: true },
        });
        const item =
          existingItem ??
          (await db.contentItem.create({
            data: {
              workspaceId,
              brandId: brand.id,
              title: ITEM_TITLE,
              contentType: 'POST',
              primaryLocale: 'EN',
              status: 'FAILED',
              origin: 'HUMAN',
              idempotencyKey: ITEM_KEY,
            },
            include: { variants: true },
          }));
        // Reset the status, so a previous run that moved it does not change
        // what this run renders.
        await db.contentItem.update({ where: { id: item.id }, data: { status: 'FAILED' } });

        const variant =
          item.variants[0] ??
          (await db.contentVariant.create({
            data: {
              workspaceId,
              brandId: brand.id,
              contentItemId: item.id,
              platformKey: 'linkedin',
              locale: 'EN',
              body: 'A note the platform declined, so the history screen has a failure to explain.',
              hashtags: ['publishing'],
              characterCount: 76,
              validationState: 'VALID',
              origin: 'HUMAN',
            },
          }));

        const liveSlot = await db.calendarSlot.findFirst({
          where: { contentItemId: item.id, status: { not: 'CANCELLED' } },
        });
        const slot =
          liveSlot ??
          (await db.calendarSlot.create({
            data: {
              workspaceId,
              brandId: brand.id,
              contentItemId: item.id,
              scheduledAtUtc: new Date(Date.now() - 60 * 60 * 1_000),
              scheduledLocalTime: SCHEDULED_LOCAL_TIME,
              timezone: 'UTC',
              status: 'FAILED',
              platformKeys: ['linkedin'],
              ...(user ? { createdByUserId: user.userId } : {}),
            },
          }));
        await db.calendarSlot.update({ where: { id: slot.id }, data: { status: 'FAILED' } });

        /*
         * A FAILED JOB, because that is the interesting screen: it carries a
         * failure class the page translates, and it is the state whose retry
         * control the suite asserts on. A published job would render one link
         * and nothing else.
         */
        await db.publishJob.create({
          data: {
            workspaceId,
            brandId: brand.id,
            calendarSlotId: slot.id,
            contentItemId: item.id,
            contentVariantId: variant.id,
            socialConnectionId: connection.id,
            provider: 'LINKEDIN',
            status: 'FAILED',
            idempotencyKey: PUBLISH_KEY,
            scheduledAtUtc: new Date(Date.now() - 60 * 60 * 1_000),
            attemptCount: 1,
            maxAttempts: 5,
            failureClass: 'CONTENT_REJECTED',
            failureCode: 'mock.content_rejected',
            completedAt: new Date(),
            ...(user ? { createdByUserId: user.userId } : {}),
          },
        });
      },
      { prisma },
    );

    console.log(`\n✔ Connected account fixture reset: ${DISPLAY_NAME} (LinkedIn)`);
    console.log('  A fake, test-only token. Nothing here works against any platform.');
    console.log('✔ One FAILED publish job, so the history screen has a retry to show.');
    console.log(
      '✔ Five providers enabled through the Configuration Service. No credential written.',
    );
  } finally {
    await prisma.$disconnect();
    await platform.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
