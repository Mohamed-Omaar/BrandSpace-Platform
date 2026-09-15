import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { asPlatform } from '@brandspace/database';
import { ALL_PERMISSIONS, ROLE_DEFINITIONS } from '@brandspace/shared';

/**
 * Two workspaces with deliberately overlapping data shapes, so a test that passes
 * by accident (because one side has no comparable row) is not possible.
 */

export interface TenantFixture {
  readonly workspaceId: string;
  readonly slug: string;
  readonly userId: string;
  readonly userEmail: string;
  readonly membershipId: string;
  readonly auditEventId: string;
  readonly customRoleId: string;
  readonly supportSessionId: string;
  // --- Phase 2B ---
  readonly invitationId: string;
  readonly invitationEmail: string;
  readonly overrideId: string;
  readonly walletId: string;
  readonly creditTransactionId: string;
  readonly emailMessageId: string;
  readonly customerSessionId: string;
  readonly passwordResetTokenId: string;
  // --- Phase 3 ---
  readonly subscriptionId: string;
  readonly creditGrantId: string;
  readonly creditReservationId: string;
  readonly usageCounterId: string;
  readonly usageEventId: string;
  readonly cohortMembershipId: string;
  // --- Phase 4 ---
  readonly aiRequestId: string;
  readonly aiLedgerId: string;
  // --- Phase 5 ---
  readonly brandId: string;
  readonly brandSlug: string;
  readonly knowledgeItemId: string;
  readonly knowledgeItemKey: string;
  readonly knowledgeVersionId: string;
  readonly sourceDocumentId: string;
  readonly sourceChecksum: string;
  readonly sourceChunkId: string;
  readonly candidateId: string;
  readonly ingestionJobId: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly messageIdempotencyKey: string;
  // --- Phase 5B-1 (Asset Library) ---
  readonly assetFolderId: string;
  readonly workspaceFolderId: string;
  readonly assetId: string;
  readonly workspaceAssetId: string;
  readonly assetChecksum: string;
  readonly assetVersionId: string;
  readonly assetDerivativeId: string;
  readonly uploadSessionId: string;
  readonly uploadIdempotencyKey: string;
  readonly assetProcessingJobId: string;
  // --- Phase 5B-2 (AI Content Studio) ---
  readonly contentItemId: string;
  readonly contentVariantId: string;
  readonly contentIdempotencyKey: string;
  /** Phase 5B-2 — the Content Calendar. A live slot for the draft above. */
  readonly calendarSlotId: string;
}

export interface IsolationFixtures {
  readonly a: TenantFixture;
  readonly b: TenantFixture;
  readonly platformUserId: string;
  /** An audit event with workspaceId = null: a platform-only event. */
  readonly platformAuditEventId: string;
}

const FIXTURE_REQUEST_ID = 'test-fixture-request';

const SEED_ACTOR = {
  platformUserId: '00000000-0000-4000-8000-0000000000ff',
  roleKey: 'platform_owner',
  mfaVerified: true,
} as const;

/** A client on the APPLICATION role — the role whose access the tests constrain. */
export function appRoleClient(): PrismaClient {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) throw new Error('DATABASE_URL is required.');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

/**
 * A client on the PLATFORM role. Fixtures provision data across tenants, which
 * is a platform operation, so they use the platform identity exactly as
 * production platform code does. Nothing gets a private door.
 */
export function platformRoleClient(): PrismaClient {
  const connectionString = process.env['DATABASE_PLATFORM_URL'];
  if (!connectionString) throw new Error('DATABASE_PLATFORM_URL is required for fixtures.');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

/**
 * A client on the MIGRATOR role — the OWNER of every table.
 *
 * Used by exactly one kind of assertion: proving that a database TRIGGER, not
 * a revoked privilege, is what refuses a write. PostgreSQL checks privileges
 * before firing triggers, so a role that has been revoked never reaches the
 * trigger; the owner holds its privileges implicitly and cannot be revoked
 * from, which makes it the only identity that can demonstrate the backstop.
 *
 * Never used to provision fixtures or to sidestep RLS in an ordinary test.
 */
export function migrationRoleClient(): PrismaClient {
  const connectionString = process.env['DATABASE_MIGRATION_URL'];
  if (!connectionString) throw new Error('DATABASE_MIGRATION_URL is required for trigger tests.');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

/**
 * Ensure the `platform_owner` role exists and return its id.
 *
 * Exported because a suite must never ASSUME the role is there. CI runs
 * migrations only — no seed — so a test that reads the role and asserts it is
 * non-null passes on a developer machine that has been seeded and fails on a
 * fresh database. Every suite bootstraps what it needs.
 */
export async function ensurePlatformRole(prisma: PrismaClient): Promise<string> {
  return asPlatform(
    SEED_ACTOR,
    {
      action: 'test.fixture.role',
      reason: 'Isolation test fixture bootstrap',
      requestId: FIXTURE_REQUEST_ID,
    },
    async (db) => {
      const existing = await db.role.findFirst({
        where: { key: 'platform_owner', workspaceId: null },
      });
      if (existing) return existing.id;
      const created = await db.role.create({
        data: {
          key: 'platform_owner',
          workspaceId: null,
          realm: 'PLATFORM',
          nameEn: 'Platform Owner',
          nameAr: 'مالك المنصة',
          isSystem: true,
        },
      });
      return created.id;
    },
    { prisma, bootstrap: true },
  );
}

/**
 * Bootstrap the full permission catalogue and every PLATFORM role, exactly as
 * the repository seed does.
 *
 * The RBAC suite reads each role's permissions back OUT of the database rather
 * than trusting the constant, so it proves the whole chain: definition ->
 * seeded rows -> service enforcement. Mirrors `packages/database/prisma/seed.ts`
 * deliberately; if the two ever disagree, `tests/unit/rbac-matrix.test.ts`
 * fails on the definitions and this suite fails on behaviour.
 */
export async function ensurePlatformRbac(prisma: PrismaClient): Promise<void> {
  for (const permission of ALL_PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: permission.key },
      update: {
        resource: permission.resource,
        action: permission.action,
        minScope: permission.minScope,
        description: permission.description,
      },
      create: {
        key: permission.key,
        resource: permission.resource,
        action: permission.action,
        minScope: permission.minScope,
        description: permission.description,
      },
    });
  }

  await asPlatform(
    SEED_ACTOR,
    {
      action: 'test.fixture.rbac',
      reason: 'Isolation test fixture bootstrap',
      requestId: FIXTURE_REQUEST_ID,
    },
    async (db) => {
      for (const definition of ROLE_DEFINITIONS.filter((d) => d.realm === 'platform')) {
        const existing = await db.role.findFirst({
          where: { key: definition.key, workspaceId: null },
        });
        const role =
          existing ??
          (await db.role.create({
            data: {
              key: definition.key,
              workspaceId: null,
              realm: 'PLATFORM',
              nameEn: definition.nameEn,
              nameAr: definition.nameAr,
              isSystem: true,
            },
          }));

        // Replace, never merge: a permission removed from a role must actually
        // disappear, or a demotion would be cosmetic.
        await db.rolePermission.deleteMany({ where: { roleId: role.id } });
        for (const key of definition.permissionKeys) {
          const permission = await db.permission.findUniqueOrThrow({ where: { key } });
          await db.rolePermission.create({
            data: { roleId: role.id, permissionId: permission.id },
          });
        }
      }
    },
    { prisma, bootstrap: true },
  );
}

/**
 * Bootstrap the WORKSPACE role catalogue, with permissions.
 *
 * CI RUNS MIGRATIONS ONLY — no seed — so a suite that reads `workspace_admin`
 * or `analyst` and assumes it is there passes on a developer machine that has
 * been seeded and fails on a fresh database. That is exactly what happened to
 * the Phase 2B suites: green locally, red on a clean checkout.
 *
 * Permissions are REPLACED rather than merged, for the same reason as the
 * platform catalogue: a permission removed from a role must actually disappear,
 * or a demotion would be cosmetic and a test asserting the denial would pass
 * against a role that still holds it.
 */
export async function ensureWorkspaceRbac(prisma: PrismaClient): Promise<void> {
  for (const permission of ALL_PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: permission.key },
      update: {
        resource: permission.resource,
        action: permission.action,
        minScope: permission.minScope,
        description: permission.description,
      },
      create: {
        key: permission.key,
        resource: permission.resource,
        action: permission.action,
        minScope: permission.minScope,
        description: permission.description,
      },
    });
  }

  await asPlatform(
    SEED_ACTOR,
    {
      action: 'test.fixture.workspace_rbac',
      reason: 'Isolation test fixture bootstrap',
      requestId: FIXTURE_REQUEST_ID,
    },
    async (db) => {
      for (const definition of ROLE_DEFINITIONS.filter((d) => d.realm === 'workspace')) {
        const existing = await db.role.findFirst({
          where: { key: definition.key, workspaceId: null },
        });
        const role =
          existing ??
          (await db.role.create({
            data: {
              key: definition.key,
              workspaceId: null,
              realm: 'WORKSPACE',
              nameEn: definition.nameEn,
              nameAr: definition.nameAr,
              isSystem: true,
            },
          }));

        await db.rolePermission.deleteMany({ where: { roleId: role.id } });
        for (const key of definition.permissionKeys) {
          const permission = await db.permission.findUniqueOrThrow({ where: { key } });
          await db.rolePermission.create({
            data: { roleId: role.id, permissionId: permission.id },
          });
        }
      }
    },
    { prisma, bootstrap: true },
  );
}

async function ensureWorkspaceRole(prisma: PrismaClient): Promise<string> {
  return asPlatform(
    SEED_ACTOR,
    {
      action: 'test.fixture.role',
      reason: 'Isolation test fixture bootstrap',
      requestId: FIXTURE_REQUEST_ID,
    },
    async (db) => {
      const existing = await db.role.findFirst({
        where: { key: 'workspace_owner', workspaceId: null },
      });
      if (existing) return existing.id;
      const created = await db.role.create({
        data: {
          key: 'workspace_owner',
          workspaceId: null,
          realm: 'WORKSPACE',
          nameEn: 'Workspace Owner',
          nameAr: 'مالك مساحة العمل',
          isSystem: true,
        },
      });
      return created.id;
    },
    { prisma, bootstrap: true },
  );
}

async function createTenant(
  prisma: PrismaClient,
  slug: string,
  email: string,
  workspaceRoleId: string,
  platformUserId: string,
): Promise<TenantFixture> {
  const user = await prisma.user.create({
    data: { email, name: `User ${slug}`, status: 'ACTIVE', emailVerifiedAt: new Date() },
  });

  return asPlatform(
    SEED_ACTOR,
    {
      action: 'test.fixture.workspace',
      reason: `Isolation test fixture: provision ${slug}`,
      requestId: FIXTURE_REQUEST_ID,
    },
    async (db) => {
      const id = crypto.randomUUID();
      const workspace = await db.workspace.create({
        data: {
          id,
          workspaceId: id,
          slug,
          name: `Workspace ${slug}`,
          ownerUserId: user.id,
          status: 'ACTIVE',
        },
      });
      const membership = await db.membership.create({
        data: {
          workspaceId: id,
          userId: user.id,
          roleId: workspaceRoleId,
          status: 'ACTIVE',
          acceptedAt: new Date(),
          brandScope: [],
        },
      });
      // A workspace-private custom role, to prove custom roles do not leak.
      const customRole = await db.role.create({
        data: {
          workspaceId: id,
          key: `custom_${slug}`,
          realm: 'WORKSPACE',
          nameEn: `Custom ${slug}`,
          nameAr: `مخصص ${slug}`,
          isSystem: false,
        },
      });
      const audit = await db.auditEvent.create({
        data: {
          workspaceId: id,
          actorType: 'SYSTEM',
          action: 'workspace.created',
          resourceType: 'workspace',
          resourceId: id,
          reason: `fixture ${slug}`,
        },
      });
      const support = await db.supportModeSession.create({
        data: {
          workspaceId: id,
          platformUserId,
          reason: `fixture support session ${slug}`,
          expiresAt: new Date(Date.now() + 3600_000),
        },
      });

      // --- Phase 2B rows. Every one carries the tenant key, so each is a
      // direct target for the cross-tenant assertions the D-29 gate demands.
      const invitationEmail = `invitee-${slug}@example.local`;
      const invitation = await db.invitation.create({
        data: {
          workspaceId: id,
          email: invitationEmail,
          roleId: workspaceRoleId,
          brandScope: [],
          tokenHash: `fixture-token-hash-${slug}`,
          expiresAt: new Date(Date.now() + 7 * 24 * 3600_000),
          invitedByPlatformUserId: platformUserId,
        },
      });
      const override = await db.workspaceOverride.create({
        data: {
          workspaceId: id,
          featureKey: 'fixture.feature',
          enabled: true,
          reason: `fixture override ${slug}`,
          grantedByPlatformUserId: platformUserId,
        },
      });
      const wallet = await db.creditWallet.create({
        data: { workspaceId: id, balanceMilliCredits: 5000n },
      });
      const creditTransaction = await db.creditTransaction.create({
        data: {
          workspaceId: id,
          walletId: wallet.id,
          type: 'ADMIN_ADJUSTMENT',
          amountMilliCredits: 5000n,
          balanceAfterMilliCredits: 5000n,
          reason: `fixture grant ${slug}`,
          idempotencyKey: `fixture-credit-${slug}`,
          actorType: 'PLATFORM_USER',
          actorId: platformUserId,
        },
      });
      // --- Phase 3 rows. Same rule: every one carries the tenant key and is a
      // direct target for the cross-tenant assertions the D-29 gate demands.
      const subscription = await db.workspaceSubscription.create({
        data: {
          workspaceId: id,
          planKey: `fixture-plan-${slug}`,
          status: 'ACTIVE',
          currency: 'SAR',
          pinnedMonthlyMinor: 1000,
          pinnedAnnualMinor: 10_000,
          pinnedMonthlyCredits: 100,
          currentPeriodStart: new Date(Date.now() - 3600_000),
          currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600_000),
        },
      });
      const creditGrant = await db.creditGrant.create({
        data: {
          workspaceId: id,
          walletId: wallet.id,
          source: 'ADMIN_ADJUSTMENT',
          amountMilliCredits: 5000n,
          remainingMilliCredits: 5000n,
          // The bucket must RECORD the hold the reservation below claims.
          // Without this the fixture fabricates a state the product cannot
          // produce — a reservation allocating credits the bucket does not know
          // are held — and the sweeper, correctly, refuses to release it: the
          // decrement would take `reserved` below zero, which a CHECK
          // constraint exists to prevent.
          reservedMilliCredits: 1000n,
          sourceTransactionId: creditTransaction.id,
          reason: `fixture grant bucket ${slug}`,
        },
      });
      const creditReservation = await db.creditReservation.create({
        data: {
          workspaceId: id,
          walletId: wallet.id,
          idempotencyKey: `fixture-reservation-${slug}`,
          estimateMilliCredits: 1000n,
          allocations: [{ grantId: creditGrant.id, milliCredits: '1000' }],
          purpose: 'fixture.task',
          /*
           * A-11 / F-61. FAR IN THE FUTURE, NOT ONE HOUR.
           *
           * This reservation exists so the isolation suites have a
           * tenant-owned row of every Phase 3 model to test RLS against. It is
           * never settled or released, because that is not what it is for.
           *
           * With a one-hour deadline, every fixture workspace ever created
           * turned into an ABANDONED reservation sixty minutes later — twenty
           * per full isolation run, accumulating for ever. That was the supply
           * line that eventually starved the sweeper (F-62): a candidate set
           * full of rows no sweep could usefully act on.
           *
           * F-62 is fixed, so a starved sweep is no longer the consequence.
           * But a fixture that manufactures fake leaks is still wrong: it puts
           * noise into the exact metric docs/BILLING-AND-CREDITS.md §10.3 says
           * must stay at zero. A deadline a century out keeps the row for the
           * isolation tests and out of the abandoned set entirely.
           */
          expiresAt: new Date(Date.now() + 100 * 365 * 86_400_000),
        },
      });
      const usageCounter = await db.usageCounter.create({
        data: {
          workspaceId: id,
          featureKey: 'limit.scheduled_posts',
          periodStart: new Date(Date.UTC(2026, 0, 1)),
          periodEnd: new Date(Date.UTC(2026, 1, 1)),
          usedValue: 3,
        },
      });
      const usageEvent = await db.usageEvent.create({
        data: {
          workspaceId: id,
          featureKey: 'limit.scheduled_posts',
          idempotencyKey: `fixture-usage-${slug}`,
          amount: 3,
          counterId: usageCounter.id,
        },
      });
      /*
       * Phase 4. An AI request and the ledger row it produced.
       *
       * SUCCEEDED with a charge, deliberately: a row that never charged
       * anything would satisfy the isolation assertions while proving nothing
       * about the leak that actually matters — one tenant reading another
       * tenant's AI spend.
       */
      const aiRequest = await db.aiRequest.create({
        data: {
          workspaceId: id,
          taskKey: 'caption.generate',
          idempotencyKey: `fixture-ai-${slug}`,
          routingTaskKey: 'caption.generate',
          resolvedModelKey: 'fixture-model',
          attemptedModelKeys: ['fixture-model'],
          status: 'SUCCEEDED',
          // Audit-safe metadata only, exactly as the gateway writes it.
          inputSummary: { promptTokens: 120, language: 'en' },
          promptTokens: 120,
          completionTokens: 80,
          providerCostMicroMinor: 4_000_000n,
          creditsReservedMilli: 2000n,
          creditsChargedMilli: 1500n,
          deadlineAt: new Date(Date.now() + 60_000),
          completedAt: new Date(),
        },
      });
      const aiLedger = await db.aiUsageLedger.create({
        data: {
          workspaceId: id,
          aiRequestId: aiRequest.id,
          taskKey: 'caption.generate',
          providerKey: 'fixture-provider',
          modelKey: 'fixture-model',
          usageUnits: { promptTokens: 120, completionTokens: 80 },
          providerCostMicroMinor: 4_000_000n,
          creditsChargedMilli: 1500n,
          environment: 'DEVELOPMENT',
        },
      });

      const cohortMembership = await db.betaCohortMembership.create({
        data: {
          workspaceId: id,
          cohortKey: `fixture-cohort-${slug}`,
          addedByPlatformUserId: platformUserId,
          reason: `fixture cohort ${slug}`,
        },
      });

      const emailMessage = await db.emailMessage.create({
        data: {
          workspaceId: id,
          toEmail: invitationEmail,
          templateKey: 'workspace.invitation',
          locale: 'EN',
          status: 'SENT',
        },
      });
      const customerSession = await db.customerSession.create({
        data: {
          userId: user.id,
          tokenHash: `fixture-session-hash-${slug}`,
          activeWorkspaceId: id,
          expiresAt: new Date(Date.now() + 3600_000),
          absoluteExpiresAt: new Date(Date.now() + 24 * 3600_000),
        },
      });
      const resetToken = await db.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: `fixture-reset-hash-${slug}`,
          expiresAt: new Date(Date.now() + 3600_000),
        },
      });

      /*
       * Phase 5 — a complete Brand Brain for this tenant.
       *
       * The two tenants get the SAME brand slug, the same knowledge item key
       * and the same document checksum. Every one of those is a unique index
       * scoped to the workspace (or to the brand), so identical values across
       * tenants are exactly what proves the scoping is real: if any of those
       * uniques were global, provisioning tenant B would fail outright.
       */
      const brand = await db.brand.create({
        data: {
          workspaceId: id,
          // Deliberately IDENTICAL across tenants.
          slug: 'house-brand',
          name: `House Brand (${slug})`,
          industry: 'retail',
          status: 'ACTIVE',
          defaultLocale: 'EN',
          supportedLocales: ['EN', 'AR'],
        },
      });

      const sourceDocument = await db.brandSourceDocument.create({
        data: {
          workspaceId: id,
          brandId: brand.id,
          fileName: 'brand-guidelines.pdf',
          mimeType: 'application/pdf',
          byteSize: 24_000,
          // Identical across tenants: the same file uploaded by two customers
          // is two documents, not a collision.
          checksum: 'fixture-checksum-0000000000000000000000000000000000000000',
          storageKey: `ws/${id}/brand/${brand.id}/fixture.pdf`,
          status: 'READY',
          pageCount: 24,
          chunkCount: 1,
          textLength: 512,
          idempotencyKey: `fixture-upload-${slug}`,
          processedAt: new Date(),
        },
      });

      const sourceChunk = await db.brandSourceChunk.create({
        data: {
          workspaceId: id,
          brandId: brand.id,
          sourceDocumentId: sourceDocument.id,
          chunkIndex: 0,
          // Tenant-distinguishing content. A test that reads a chunk across the
          // boundary must be able to tell WHOSE text it got.
          text: `Confidential positioning for ${slug}: we serve independent retailers.`,
          locator: 'page 1',
          indexVector: [0.1, 0.2, 0.3],
          indexModelKey: 'fixture-index-v1',
        },
      });

      const knowledgeItem = await db.brandKnowledgeItem.create({
        data: {
          workspaceId: id,
          brandId: brand.id,
          area: 'IDENTITY',
          memory: 'CANONICAL',
          origin: 'HUMAN',
          status: 'ACTIVE',
          // Identical across tenants.
          itemKey: 'identity.positioning',
          title: { en: 'Positioning', ar: 'التموضع' },
          body: {
            en: `${slug} positioning statement`,
            ar: `بيان تموضع ${slug}`,
          },
          createdByUserId: user.id,
          version: 1,
        },
      });

      const knowledgeVersion = await db.brandKnowledgeVersion.create({
        data: {
          workspaceId: id,
          brandId: brand.id,
          knowledgeItemId: knowledgeItem.id,
          version: 1,
          area: 'IDENTITY',
          memory: 'CANONICAL',
          origin: 'HUMAN',
          status: 'ACTIVE',
          title: { en: 'Positioning', ar: 'التموضع' },
          body: { en: `${slug} positioning statement`, ar: `بيان تموضع ${slug}` },
          changedByUserId: user.id,
          changeKind: 'created',
        },
      });

      const candidate = await db.brandKnowledgeCandidate.create({
        data: {
          workspaceId: id,
          brandId: brand.id,
          sourceDocumentId: sourceDocument.id,
          targetItemId: knowledgeItem.id,
          area: 'IDENTITY',
          itemKey: 'identity.mission',
          extractedTitle: { en: 'Mission', ar: 'الرسالة' },
          extractedBody: { en: `${slug} mission`, ar: `رسالة ${slug}` },
          confidenceMilli: 720,
          evidence: [{ chunkId: sourceChunk.id, locator: 'page 1' }],
          status: 'PENDING',
        },
      });

      const ingestionJob = await db.brandIngestionJob.create({
        data: {
          workspaceId: id,
          brandId: brand.id,
          sourceDocumentId: sourceDocument.id,
          // COMPLETED so the partial unique index on live stages stays free —
          // a suite that later enqueues a job for this document must not be
          // blocked by a fixture that parked one in QUEUED forever.
          stage: 'COMPLETED',
          attempts: 1,
          chunksCreated: 1,
          candidatesCreated: 1,
          completedAt: new Date(),
        },
      });

      const conversation = await db.brandBrainConversation.create({
        data: {
          workspaceId: id,
          brandId: brand.id,
          area: 'IDENTITY',
          title: `Fixture conversation ${slug}`,
          startedByUserId: user.id,
          expiresAt: new Date(Date.now() + 30 * 24 * 3600_000),
        },
      });

      const message = await db.brandBrainMessage.create({
        data: {
          workspaceId: id,
          brandId: brand.id,
          conversationId: conversation.id,
          role: 'assistant',
          body: `Grounded answer for ${slug} only.`,
          citations: [{ itemId: knowledgeItem.id, area: 'IDENTITY', version: 1 }],
          idempotencyKey: `fixture-message-${slug}`,
          expiresAt: new Date(Date.now() + 30 * 24 * 3600_000),
        },
      });

      /*
       * Phase 5B-1 — a complete Asset Library for this tenant.
       *
       * TWO FOLDERS AND TWO ASSETS EACH, and the pairing is the point. One of
       * each is BRAND-SCOPED and one is WORKSPACE-LEVEL (brandId null), because
       * docs/DATABASE.md §4.6 makes a null brand mean "belongs to the
       * workspace". A suite that only ever saw brand-scoped rows would never
       * exercise the MATCH SIMPLE exemption, and the exemption is precisely the
       * thing a reader would most doubt.
       *
       * The two tenants share an IDENTICAL asset checksum, which is what proves
       * the live-dedupe unique index is workspace-scoped: if it were global,
       * provisioning tenant B would fail outright.
       */
      const assetFolder = await db.assetFolder.create({
        data: {
          workspaceId: id,
          brandId: brand.id,
          name: 'Campaign photography',
          createdByUserId: user.id,
        },
      });

      const workspaceFolder = await db.assetFolder.create({
        data: {
          workspaceId: id,
          // NULL: a workspace-level folder, shared across every brand.
          brandId: null,
          name: 'Legal and contracts',
          createdByUserId: user.id,
        },
      });

      const asset = await db.asset.create({
        data: {
          workspaceId: id,
          brandId: brand.id,
          folderId: assetFolder.id,
          name: 'hero-shot.png',
          kind: 'IMAGE',
          mimeType: 'image/png',
          sizeBytes: 148_221,
          width: 1600,
          height: 900,
          storageKey: `ws/${id}/brand/${brand.id}/asset/fixture-hero`,
          // Deliberately IDENTICAL across tenants.
          checksumSha256: 'fixture-asset-checksum-000000000000000000000000000000',
          tags: ['hero', 'campaign'],
          scanStatus: 'CLEAN',
          scannedAt: new Date(),
          status: 'READY',
          currentVersion: 1,
          uploadedByUserId: user.id,
        },
      });

      const workspaceAsset = await db.asset.create({
        data: {
          workspaceId: id,
          brandId: null,
          folderId: workspaceFolder.id,
          name: 'master-services-agreement.pdf',
          kind: 'DOCUMENT',
          mimeType: 'application/pdf',
          sizeBytes: 92_004,
          storageKey: `ws/${id}/asset/fixture-msa`,
          checksumSha256: `fixture-workspace-asset-${slug}`,
          tags: ['legal'],
          scanStatus: 'CLEAN',
          scannedAt: new Date(),
          status: 'READY',
          currentVersion: 1,
          uploadedByUserId: user.id,
        },
      });

      const assetVersion = await db.assetVersion.create({
        data: {
          workspaceId: id,
          brandId: brand.id,
          assetId: asset.id,
          versionNumber: 1,
          storageKey: asset.storageKey,
          checksumSha256: asset.checksumSha256,
          mimeType: asset.mimeType,
          sizeBytes: asset.sizeBytes,
          width: asset.width,
          height: asset.height,
          scanStatus: 'CLEAN',
          createdByUserId: user.id,
        },
      });

      const assetDerivative = await db.assetDerivative.create({
        data: {
          workspaceId: id,
          assetId: asset.id,
          kind: 'THUMBNAIL',
          storageKey: `${asset.storageKey}/thumbnail`,
          mimeType: 'image/png',
          sizeBytes: 8_120,
          width: 320,
          height: 180,
        },
      });

      const uploadSession = await db.assetUploadSession.create({
        data: {
          workspaceId: id,
          brandId: brand.id,
          folderId: assetFolder.id,
          assetId: asset.id,
          declaredFileName: 'hero-shot.png',
          declaredMimeType: 'image/png',
          declaredSizeBytes: 148_221,
          storageKey: asset.storageKey,
          // COMPLETED so the expiry sweep never claims a fixture row.
          status: 'COMPLETED',
          idempotencyKey: `fixture-asset-upload-${slug}`,
          createdByUserId: user.id,
          expiresAt: new Date(Date.now() + 3600_000),
          completedAt: new Date(),
        },
      });

      const assetProcessingJob = await db.assetProcessingJob.create({
        data: {
          workspaceId: id,
          brandId: brand.id,
          assetId: asset.id,
          // COMPLETED for the same reason the ingestion fixture is: a suite
          // that later enqueues real work must not find a fixture parked in
          // QUEUED forever and reconciled out from under it.
          stage: 'COMPLETED',
          attempts: 1,
          derivativesCreated: 1,
          completedAt: new Date(),
        },
      });

      /*
       * Phase 5B-2 — one AI-generated draft with one platform variant.
       *
       * The BODY carries the tenant slug, so a test that reads a caption across
       * the boundary can tell WHOSE words it got rather than merely counting
       * rows. The idempotency key is tenant-distinct for the same reason the
       * Brand Brain one is: `unique(workspaceId, idempotencyKey)` must be
       * provably workspace-scoped, and two tenants sharing a key is what proves
       * it.
       */
      const contentItem = await db.contentItem.create({
        data: {
          workspaceId: id,
          brandId: brand.id,
          title: `Spring launch — ${slug}`,
          contentType: 'POST',
          primaryLocale: 'EN',
          status: 'DRAFT',
          origin: 'AI_GENERATED',
          createdByUserId: user.id,
          arabicDialect: 'msa',
          idempotencyKey: `fixture-content-${slug}`,
          citations: [
            { kind: 'knowledge', id: knowledgeItem.id, label: 'Positioning', version: 1 },
          ],
        },
      });

      const contentVariant = await db.contentVariant.create({
        data: {
          workspaceId: id,
          brandId: brand.id,
          contentItemId: contentItem.id,
          platformKey: 'instagram',
          locale: 'EN',
          body: `Confidential campaign caption for ${slug} only.`,
          hashtags: ['launch'],
          characterCount: 48,
          validationState: 'VALID',
          origin: 'AI_GENERATED',
        },
      });

      /*
       * A LIVE CALENDAR SLOT for the draft above.
       *
       * Scheduled a year out and at a fixed wall-clock, so the fixture never
       * drifts into the past and never depends on when the suite runs. The
       * instant is computed here rather than by the service because the fixture
       * is provisioning state, not exercising the scheduling rules.
       */
      const slotLocalTime = `${new Date().getUTCFullYear() + 1}-03-12T09:00`;
      const calendarSlot = await db.calendarSlot.create({
        data: {
          workspaceId: id,
          brandId: brand.id,
          contentItemId: contentItem.id,
          scheduledAtUtc: new Date(`${slotLocalTime}:00.000Z`),
          scheduledLocalTime: slotLocalTime,
          timezone: 'Asia/Riyadh',
          status: 'SCHEDULED',
          platformKeys: ['instagram'],
          createdByUserId: user.id,
          usageIdempotencyKey: `fixture-calendar-${slug}`,
        },
      });

      return {
        workspaceId: workspace.id,
        slug,
        userId: user.id,
        userEmail: email,
        membershipId: membership.id,
        auditEventId: audit.id,
        customRoleId: customRole.id,
        supportSessionId: support.id,
        invitationId: invitation.id,
        invitationEmail,
        overrideId: override.id,
        walletId: wallet.id,
        creditTransactionId: creditTransaction.id,
        emailMessageId: emailMessage.id,
        customerSessionId: customerSession.id,
        passwordResetTokenId: resetToken.id,
        subscriptionId: subscription.id,
        creditGrantId: creditGrant.id,
        creditReservationId: creditReservation.id,
        usageCounterId: usageCounter.id,
        usageEventId: usageEvent.id,
        cohortMembershipId: cohortMembership.id,
        aiRequestId: aiRequest.id,
        aiLedgerId: aiLedger.id,
        brandId: brand.id,
        brandSlug: brand.slug,
        knowledgeItemId: knowledgeItem.id,
        knowledgeItemKey: knowledgeItem.itemKey,
        knowledgeVersionId: knowledgeVersion.id,
        sourceDocumentId: sourceDocument.id,
        sourceChecksum: sourceDocument.checksum,
        sourceChunkId: sourceChunk.id,
        candidateId: candidate.id,
        ingestionJobId: ingestionJob.id,
        conversationId: conversation.id,
        messageId: message.id,
        messageIdempotencyKey: message.idempotencyKey ?? '',
        assetFolderId: assetFolder.id,
        workspaceFolderId: workspaceFolder.id,
        assetId: asset.id,
        workspaceAssetId: workspaceAsset.id,
        assetChecksum: asset.checksumSha256,
        assetVersionId: assetVersion.id,
        assetDerivativeId: assetDerivative.id,
        uploadSessionId: uploadSession.id,
        uploadIdempotencyKey: uploadSession.idempotencyKey,
        assetProcessingJobId: assetProcessingJob.id,
        contentItemId: contentItem.id,
        contentVariantId: contentVariant.id,
        contentIdempotencyKey: `fixture-content-${slug}`,
        calendarSlotId: calendarSlot.id,
      };
    },
    { prisma, bootstrap: true },
  );
}

/** Build a fresh pair of tenants with unique identifiers for one test run. */
export async function createIsolationFixtures(
  _appPrisma: PrismaClient,
): Promise<IsolationFixtures> {
  // Fixtures are provisioned on the PLATFORM pool. The app pool cannot create
  // data for two different tenants — which is the property under test.
  const prisma = platformRoleClient();
  const run = crypto.randomUUID().slice(0, 8);
  const platformRoleId = await ensurePlatformRole(prisma);
  // The full workspace catalogue FIRST, so `workspace_owner` carries its real
  // permissions rather than an empty set — the fixtures must look like the
  // product, not like a stub that happens to satisfy a foreign key.
  await ensureWorkspaceRbac(prisma);
  const workspaceRoleId = await ensureWorkspaceRole(prisma);

  const platformUser = await prisma.platformUser.create({
    data: {
      email: `platform-${run}@brandspace.local`,
      name: 'Fixture Platform User',
      status: 'ACTIVE',
      roleId: platformRoleId,
    },
  });

  const a = await createTenant(
    prisma,
    `tenant-a-${run}`,
    `a-${run}@example.local`,
    workspaceRoleId,
    platformUser.id,
  );
  const b = await createTenant(
    prisma,
    `tenant-b-${run}`,
    `b-${run}@example.local`,
    workspaceRoleId,
    platformUser.id,
  );

  // A platform-only audit event (workspaceId = null).
  const platformAuditEventId = await asPlatform(
    SEED_ACTOR,
    {
      action: 'test.fixture.audit',
      reason: 'Isolation test fixture: platform-only event',
      requestId: FIXTURE_REQUEST_ID,
    },
    async (db) => {
      const created = await db.auditEvent.create({
        data: {
          workspaceId: null,
          actorType: 'PLATFORM_USER',
          actorId: platformUser.id,
          action: 'platform.internal.event',
          reason: 'platform-only fixture event',
        },
      });
      return created.id;
    },
    { prisma, bootstrap: true },
  );

  await prisma.$disconnect();
  return { a, b, platformUserId: platformUser.id, platformAuditEventId };
}
