import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AssetUploadService, TenantAssetPolicySource, type AssetPolicy } from '@brandspace/assets';
import {
  CREATIVE_KNOWLEDGE_AREAS,
  CREATIVE_KNOWLEDGE_LINES,
  CreativeGenerationJobs,
  CreativeStudioService,
  type BrandIdentityInput,
  type CreativeJobRunHost,
  brandTypography,
  findCreativeFormat,
  runCreativeGenerationJob,
} from '@brandspace/creative';
import { resolveLiveAuthorization } from '@brandspace/copilot';
import { createLogger, internalErrorFields, maySpendCredits } from '@brandspace/shared';
import { writingFactsInAreas } from '@brandspace/brand-brain';
import { createObjectStore, type ObjectStore } from '@brandspace/storage';
import { getPrisma, withWorkspace, type TenantScopedClient } from '@brandspace/database';
import type { PrismaClient } from '@brandspace/database';
import {
  EntitlementService,
  QUOTA_FEATURES,
  TenantCatalogueSource,
  UsageService,
} from '@brandspace/entitlements';
import { brandInScope, creditSpendingPermissions } from '@brandspace/shared';
import { route } from '../route-contract';
import {
  currentEnvironment,
  fail,
  gateway,
  resolveCaller,
  workspaceFacts,
  type Caller,
} from './phase7-context';

/**
 * THE AI CREATIVE STUDIO'S GENERATION SURFACE (AC-28).
 *
 * IT LIVES HERE FOR THE REASON THE CONTENT STUDIO DOES. The gateway reads
 * platform-owned `ai.*` configuration and settles credits in its own
 * transactions, so it needs the PLATFORM database identity, and F-07 forbids
 * the customer dashboard from holding one. `apps/api` is the designated
 * platform surface; the dashboard calls these two routes and does the rest
 * itself under RLS.
 *
 * TWO IDENTITIES, NEITHER BORROWING THE OTHER'S REACH. The brand read, the
 * asset write and the audit event all run inside `withWorkspace`, so RLS
 * constrains them. The gateway alone uses the platform identity, and it never
 * touches a tenant table.
 *
 * THE BRAND IS READ HERE, NOT TAKEN FROM THE REQUEST. A body can name any uuid;
 * the identity that shapes the prompt comes from the brand row itself, inside
 * the workspace, after the scope check.
 */

const READ_PERMISSION = 'assets.read';
const CREATE_PERMISSION = 'assets.upload';

/** PR A (item 6, F-106) — the image quality the customer chose; absent is the route's default. */
const qualitySchema = z.enum(['low', 'medium', 'high']).optional();

const quoteSchema = z.object({
  formatKey: z.string().min(1).max(40),
  quality: qualitySchema,
});

const generateSchema = z.object({
  brandId: z.string().uuid(),
  brief: z.string().min(1).max(1_000),
  formatKey: z.string().min(1).max(40),
  quality: qualitySchema,
  /** A generation spends credits, so a retry must never bill twice. */
  idempotencyKey: z.string().min(8).max(200),
  /**
   * PR 1 (D-597) — the post variant to attach the image to, when it was
   * asked for from a post. Checked to be this brand's variant in this
   * workspace; anything else is the same miss as a brand out of scope.
   */
  contentVariantId: z.string().uuid().optional(),
});

const jobIdSchema = z.object({ id: z.string().uuid() });
const recentSchema = z.object({
  brandId: z.string().uuid(),
  contentVariantIds: z.string().max(2_000).optional(),
  unfinished: z.enum(['1']).optional(),
});

const log = createLogger({ context: { component: 'api.creative.jobs' } });

let sharedStore: ObjectStore | null = null;

function objectStore(): ObjectStore {
  // APP_ENV, not NODE_ENV: every built app has NODE_ENV=production, including
  // the one the E2E suite serves. The development store is in-process and is
  // what Phase 8 uses; production object storage is Phase 10.
  sharedStore ??= createObjectStore({ appEnv: process.env['APP_ENV'] ?? 'development' });
  return sharedStore;
}

/**
 * The asset policy, read the way every other tenant surface reads it.
 *
 * FROM THE TENANT-READABLE PROJECTION, not from the Configuration Service
 * directly: `entitlement_catalogue_snapshot` is what the activation writes and
 * what the tenant role may read, and reading the platform document here would
 * be a second path to the same setting (CLAUDE.md §2.2).
 */
async function assetPolicyFor(db: TenantScopedClient): Promise<AssetPolicy> {
  return new TenantAssetPolicySource(db, currentEnvironment()).load();
}

/**
 * The scoped client as the services that take a `PrismaClient` want it.
 *
 * The same cast `apps/dashboard`'s customer context makes, and for the same
 * reason: the scoped client is a `PrismaClient` minus the connection-lifecycle
 * and transaction methods, which is exactly the surface these services use —
 * they detect the absence of `$transaction` and run inline. The alternative is
 * handing them the raw pool, and `usage_counter` is tenant-owned, so RLS
 * refuses the write.
 */
function scopedFor(db: TenantScopedClient): PrismaClient {
  return db as unknown as PrismaClient;
}

/**
 * PR A (H-4) — a creative studio, and the upload path it stores through, bound
 * to ONE short tenant transaction.
 */
async function creativeStudioFor(
  caller: Pick<Caller, 'workspaceId'>,
  db: TenantScopedClient,
): Promise<CreativeStudioService> {
  const uploads = new AssetUploadService({
    db,
    workspaceId: caller.workspaceId,
    store: objectStore(),
    policy: await assetPolicyFor(db),
    usage: new UsageService({ prisma: scopedFor(db) }),
    /*
     * THE STORAGE CEILING COMES FROM THE ENTITLEMENTS ENGINE (D-10),
     * resolved through plan, override, flag and default — not from a
     * number in this file. A generated image counts against the same
     * quota a person's own upload does, because it is the same
     * library.
     *
     * READ FROM THE TENANT-SIDE CATALOGUE PROJECTION, exactly as the
     * dashboard and the Copilot's gate read it. This was built with
     * the PLATFORM client and no catalogue source at all, which the
     * service refuses outright — so every generation through this
     * route answered 500 before it reached the gateway. The
     * isolation suite could not see it: it constructs the service
     * itself and supplies the ceiling directly, which is the right
     * shape for a domain test and leaves the WIRING untested. The
     * functional end-to-end flow is what found it.
     *
     * `entitlement_catalogue_snapshot` is the projection the
     * Configuration Service writes on activation; two sources for one
     * answer is how a limit comes out different on two surfaces.
     */
    storageLimitGb: await new EntitlementService({
      prisma: scopedFor(db),
      catalogueSource: new TenantCatalogueSource(scopedFor(db), currentEnvironment()),
      environment: currentEnvironment(),
    }).limit(caller.workspaceId, QUOTA_FEATURES.storageGb),
  });

  return new CreativeStudioService({
    db,
    workspaceId: caller.workspaceId,
    gateway: gateway(),
    uploads,
  });
}

export function registerCreativeRoutes(app: FastifyInstance): void {
  /*
   * AC-28.5 — the price BEFORE it is spent.
   *
   * A READ: it reserves nothing, writes no `ai_request` and moves no credit.
   * Gated on `assets.read` rather than on the upload permission, so a member
   * who may look at the library can be shown what a generation would cost.
   */
  route(
    app,
    'POST',
    '/v1/creative/quote',
    {
      scope: 'workspace',
      permission: READ_PERMISSION,
      rateLimit: 'ai.quote',
      confirmation: 'not_required',
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const caller = await resolveCaller(req, reply, READ_PERMISSION);
      if (!caller) return reply;

      const parsed = quoteSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_FAILED' } });
      if (!findCreativeFormat(parsed.data.formatKey)) {
        return reply.code(422).send({ error: { code: 'VALIDATION_FAILED' } });
      }

      const facts = await workspaceFacts(caller.workspaceId);
      try {
        const quote = await withWorkspace(
          caller.workspaceId,
          async (db) =>
            new CreativeStudioService({
              db,
              workspaceId: caller.workspaceId,
              gateway: gateway(),
              /*
               * A QUOTE STORES NOTHING, so the upload service it is handed is
               * never used. It is required by the constructor because the same
               * object answers both questions, and building a real one here
               * costs one catalogue read rather than a special case.
               */
              uploads: new AssetUploadService({
                db,
                workspaceId: caller.workspaceId,
                store: objectStore(),
                policy: await assetPolicyFor(db),
                /*
                 * THE SCOPED CLIENT, NOT THE POOL. `usage_counter` is
                 * tenant-owned and RLS-protected, so a service holding the raw
                 * client writes a row the policy refuses. The dashboard's asset
                 * context has always passed the scoped client here; this route
                 * has to as well.
                 */
                usage: new UsageService({ prisma: scopedFor(db) }),
                storageLimitGb: null,
              }),
            }).quote({
              formatKey: parsed.data.formatKey,
              planKey: facts.planKey,
              ...(parsed.data.quality ? { quality: parsed.data.quality } : {}),
            }),
          { prisma: getPrisma() },
        );
        // THE ESTIMATE AND NOTHING ELSE. No provider, no model, no prompt.
        return reply.send({ estimateMilli: quote.estimateMilli.toString() });
      } catch (error: unknown) {
        return fail(reply, 'creative-quote', error);
      }
    },
  );

  /*
   * AC-28.1 … AC-28.8, PR 1 (D-597) — ONE GENERATION, AS A BACKGROUND JOB.
   *
   * The request writes the job and answers 202 at once; the image is made in
   * this process right after, and the recovery sweep (`scheduler.ts`) finishes
   * any job a restart left behind. Nothing waits on the provider here: on
   * staging the synchronous wait failed at 90 s (three 30 s attempts).
   */
  route(
    app,
    'POST',
    '/v1/creative/generate',
    {
      scope: 'workspace',
      permission: CREATE_PERMISSION,
      spendsCredits: true,
      idempotent: true,
      rateLimit: 'ai.generate',
      confirmation: 'not_required',
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const caller = await resolveCaller(req, reply, creditSpendingPermissions(CREATE_PERMISSION));
      if (!caller) return reply;

      const parsed = generateSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_FAILED' } });

      /*
       * BEFORE THE QUERY. A brand outside the caller's scope must be
       * indistinguishable from one that does not exist, and a read that happens
       * first is a read that happened (docs/SECURITY.md §4.2).
       */
      if (!brandInScope(caller.brandScope, parsed.data.brandId)) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
      }

      try {
        const queued = await withWorkspace(
          caller.workspaceId,
          async (db) =>
            new CreativeGenerationJobs({ db, workspaceId: caller.workspaceId }).enqueue({
              brandId: parsed.data.brandId,
              requestedByUserId: caller.userId,
              brandScope: caller.brandScope,
              idempotencyKey: parsed.data.idempotencyKey,
              brief: parsed.data.brief,
              formatKey: parsed.data.formatKey,
              ...(parsed.data.quality ? { quality: parsed.data.quality } : {}),
              ...(parsed.data.contentVariantId
                ? { contentVariantId: parsed.data.contentVariantId }
                : {}),
            }),
          { prisma: getPrisma() },
        );

        if (queued.job.status === 'QUEUED') {
          const facts = await workspaceFacts(caller.workspaceId);
          startCreativeJob(caller.workspaceId, queued.job.id, facts.planKey);
        }
        // A JOB ID AND ITS STATE. Never a model, a provider or a prompt.
        return reply.code(202).send({ jobId: queued.job.id, job: queued.job });
      } catch (error: unknown) {
        return fail(reply, 'creative-generate', error);
      }
    },
  );

  /* PR 1 (D-597) — one job's state, for the person who asked. */
  route(
    app,
    'GET',
    '/v1/creative/jobs/:id',
    {
      scope: 'workspace',
      permission: READ_PERMISSION,
      rateLimit: 'read',
      confirmation: 'not_required',
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const caller = await resolveCaller(req, reply, READ_PERMISSION);
      if (!caller) return reply;
      const parsed = jobIdSchema.safeParse(req.params);
      if (!parsed.success) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
      try {
        const job = await withWorkspace(
          caller.workspaceId,
          async (db) =>
            new CreativeGenerationJobs({ db, workspaceId: caller.workspaceId }).get(
              parsed.data.id,
              {
                userId: caller.userId,
                brandScope: caller.brandScope,
              },
            ),
          { prisma: getPrisma() },
        );
        return reply.header('cache-control', 'no-store').send({ job });
      } catch (error: unknown) {
        return fail(reply, 'creative-job', error);
      }
    },
  );

  /* PR 1 (D-597) — the person's recent jobs on a brand (Studio page, the editor). */
  route(
    app,
    'GET',
    '/v1/creative/jobs',
    {
      scope: 'workspace',
      permission: READ_PERMISSION,
      rateLimit: 'read',
      confirmation: 'not_required',
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const caller = await resolveCaller(req, reply, READ_PERMISSION);
      if (!caller) return reply;
      const parsed = recentSchema.safeParse(req.query);
      if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_FAILED' } });
      if (!brandInScope(caller.brandScope, parsed.data.brandId)) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
      }
      const variantIds = parsed.data.contentVariantIds
        ?.split(',')
        .map((id) => id.trim())
        .filter((id) => z.string().uuid().safeParse(id).success)
        .slice(0, 20);
      try {
        const jobs = await withWorkspace(
          caller.workspaceId,
          async (db) =>
            new CreativeGenerationJobs({ db, workspaceId: caller.workspaceId }).recent({
              userId: caller.userId,
              brandId: parsed.data.brandId,
              ...(variantIds ? { contentVariantIds: variantIds } : {}),
              unfinishedOnly: parsed.data.unfinished === '1',
            }),
          { prisma: getPrisma() },
        );
        return reply.header('cache-control', 'no-store').send({ jobs });
      } catch (error: unknown) {
        return fail(reply, 'creative-jobs', error);
      }
    },
  );
}

/**
 * A stored JSON array of strings, read defensively.
 *
 * The columns are `Json?`, so what comes back is whatever was written. A reader
 * that assumed an array of strings would throw while building a prompt.
 */
function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * One line of approved knowledge, in whichever language it was written.
 *
 * `body` is `{ ar?, en? }` and the boundary schema refuses one with neither, so
 * either half is a real line. English first only because the prompt's own
 * scaffolding is English; the CONTENT is the brand's, in the brand's language.
 */
function localizedLine(value: unknown): string {
  if (typeof value !== 'object' || value === null) return '';
  const record = value as Record<string, unknown>;
  const en = typeof record['en'] === 'string' ? record['en'] : '';
  const ar = typeof record['ar'] === 'string' ? record['ar'] : '';
  return (en || ar).slice(0, 300);
}

/**
 * PR 1 (D-597) — THE BRAND'S IDENTITY FOR A PROMPT (AC-28.1), read inside the
 * workspace so RLS constrains it. A request cannot supply a palette: the
 * point is that the image looks like THIS brand. Only APPROVED Brand Brain
 * knowledge, a handful of lines, through the one grounding layer (Q20, D9,
 * D-354): nothing at all when "Use Brand Brain" is off.
 */
export async function creativeIdentity(
  db: TenantScopedClient,
  brandId: string,
): Promise<BrandIdentityInput | null> {
  const brand = await db.brand.findFirst({
    where: { id: brandId, deletedAt: null },
    select: {
      id: true,
      name: true,
      industry: true,
      description: true,
      colorPalette: true,
      typography: true,
    },
  });
  if (!brand) return null;
  const knowledge = await writingFactsInAreas(db, {
    brandId: brand.id,
    areas: CREATIVE_KNOWLEDGE_AREAS,
    maxItems: CREATIVE_KNOWLEDGE_LINES,
  });
  return {
    name: brand.name,
    industry: brand.industry,
    description: brand.description,
    palette: stringArray(brand.colorPalette),
    typography: brandTypography(brand.typography),
    knowledge: knowledge.map((item) => localizedLine(item.body)).filter((line) => line !== ''),
  };
}

/**
 * PR 1 (D-597) — what a job run needs from this process. The requester's
 * authorization is read LIVE when the job runs: a person removed, or no
 * longer allowed to spend credits or upload, since asking gets nothing made.
 */
export function creativeJobHost(workspaceId: string, planKey: string | null): CreativeJobRunHost {
  return {
    workspaceId,
    planKey,
    inWorkspace: (fn) => withWorkspace(workspaceId, fn, { prisma: getPrisma() }),
    studioFor: (db) => creativeStudioFor({ workspaceId }, db),
    identityFor: creativeIdentity,
    authorize: async (db, userId, brandId) => {
      const live = await resolveLiveAuthorization(db, workspaceId, userId);
      if (!live) return null;
      if (!maySpendCredits(live.permissionKeys, CREATE_PERMISSION)) return null;
      if (!brandInScope(live.brandScope, brandId)) return null;
      return {
        userId,
        permissionKeys: [CREATE_PERMISSION, READ_PERMISSION],
        brandScope: live.brandScope,
      };
    },
  };
}

/**
 * Start a job in this process, after the response. Never awaited by the
 * request and never throws: a run that dies here leaves the row QUEUED or
 * RUNNING, and the recovery sweep finishes it.
 */
export function startCreativeJob(workspaceId: string, jobId: string, planKey: string | null): void {
  void runCreativeGenerationJob(creativeJobHost(workspaceId, planKey), jobId)
    .then((outcome) => {
      log.info('creative job finished', { workspaceId, jobId, outcome });
    })
    .catch((error: unknown) => {
      log.error('creative job run failed', { workspaceId, jobId, ...internalErrorFields(error) });
    });
}
