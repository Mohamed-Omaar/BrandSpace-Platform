import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  brandProfileBlock,
  brandProfileFor,
  fenceUntrusted,
  groundingFor,
  resolveBrandBrainPolicy,
} from '@brandspace/brand-brain';
import {
  CopilotOrchestrator,
  CopilotPlanService,
  TOOL_EXECUTORS,
  TenantCopilotPolicySource,
  findAgentTool,
  resolveLiveAuthorization,
  runAgentTurn,
  type AgentEvent,
  type AgentToolOutcome,
  type AgentToolPort,
  type LiveAuthorization,
} from '@brandspace/copilot';
import {
  ContentLibraryService,
  resolveContentExpiry,
  resolveContentPolicy,
} from '@brandspace/content';
import { findCreativeFormat } from '@brandspace/creative';
import { getPrisma, withWorkspace, type TenantScopedClient } from '@brandspace/database';
import type { ChatImage } from '@brandspace/ai-gateway';
import { createObjectStore, type ObjectStore } from '@brandspace/storage';
import {
  AppError,
  brandIdQueryFilter,
  brandInScope,
  createLogger,
  internalErrorFields,
  isAppError,
  maySpendCredits,
  systemClock,
} from '@brandspace/shared';
import { route } from '../route-contract';
import { automationRules, estimateFor, executionContextFor } from './copilot';
import { brandKnowledge } from './copilot-knowledge';
import { imageJobs } from './copilot-images';
import { startCreativeJob } from './creative';
import {
  configurationService,
  copilotDenialSink,
  currentEnvironment,
  gateway,
  resolveCaller,
  workspaceFacts,
} from './phase7-context';

/**
 * PR A (smart Copilot, D-603/D-604) — ONE MESSAGE, STREAMED, WITH TOOLS.
 *
 * `POST /v1/copilot/stream` answers as server-sent events:
 *
 *   knowledge  { percent }                        how complete the brand is
 *   activity   { key, state }                     "worked on: read Brand Kit…"
 *   delta      { text }                           the answer, word by word
 *   draft      { contentItemId, title }           a draft it made
 *   image      { jobId, contentItemId }           an image it started
 *   done       { answer, messageId, plan, … }     the end; `plan` is the card
 *   stopped    {}                                 Stop: nothing charged
 *   error      { code, details }                  a refusal, in the usual shape
 *
 * Everything before the first event is an ordinary JSON refusal (401, 404,
 * 422), so the dashboard reads a refusal the way it always has.
 *
 * STOP. The person's Stop closes the stream (and calls `/v1/copilot/stop`,
 * which marks the turn): the connection's close aborts the running model call,
 * which ends CANCELLED and is released. Nothing is charged for a stopped
 * message — `runAgentTurn` explains why that holds whichever round it was in.
 */

const log = createLogger({ context: { component: 'api.copilot.agent' } });

const COPILOT_PERMISSION = 'copilot.use';

const streamSchema = z.object({
  sessionId: z.string().uuid(),
  request: z.string().min(1).max(4_000),
  idempotencyKey: z.string().min(8).max(200),
  /** Images the person sent with the message: their own Asset Library ids. */
  imageAssetIds: z.array(z.string().uuid()).max(4).default([]),
});

/** The largest image the chat sends to a model. */
const MAX_CHAT_IMAGE_BYTES = 8 * 1024 * 1024;
const CHAT_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

let sharedStore: ObjectStore | null = null;
function objectStore(): ObjectStore {
  sharedStore ??= createObjectStore({ appEnv: process.env['APP_ENV'] ?? 'development' });
  return sharedStore;
}

function inWorkspace<T>(workspaceId: string, fn: (db: TenantScopedClient) => Promise<T>) {
  return withWorkspace(workspaceId, fn as never, { prisma: getPrisma() }) as Promise<T>;
}

export function registerCopilotAgentRoutes(app: FastifyInstance): void {
  route(
    app,
    'POST',
    '/v1/copilot/stream',
    {
      scope: 'workspace',
      permission: COPILOT_PERMISSION,
      rateLimit: 'ai.generate',
      spendsCredits: true,
      idempotent: true,
    },
    async (req, reply) => {
      const caller = await resolveCaller(req, reply, COPILOT_PERMISSION);
      if (!caller) return;
      const parsed = streamSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_FAILED' } });
      const body = parsed.data;

      let admitted: {
        authorization: LiveAuthorization;
        policy: Awaited<ReturnType<TenantCopilotPolicySource['load']>>;
        images: { assetIds: string[]; images: ChatImage[] };
      };
      let facts: Awaited<ReturnType<typeof workspaceFacts>>;
      let expiresAt: Date | null;
      let keyQuestions:
        Awaited<ReturnType<typeof resolveBrandBrainPolicy>>['questions'] | undefined;
      try {
        facts = await workspaceFacts(caller.workspaceId);
        const contentPolicy = await resolveContentPolicy(
          configurationService(),
          currentEnvironment(),
        );
        expiresAt = resolveContentExpiry(contentPolicy, facts, systemClock);
        keyQuestions = await resolveBrandBrainPolicy(configurationService(), currentEnvironment())
          .then((policy) => policy.questions)
          .catch(() => undefined);
        await untilScanned(caller.workspaceId, body.imageAssetIds);
        admitted = await inWorkspace(caller.workspaceId, async (db) => {
          const authorization = await resolveLiveAuthorization(
            db,
            caller.workspaceId,
            caller.userId,
          );
          if (!authorization) throw new AppError('NOT_FOUND', 'Conversation not found.');
          const policy = await new TenantCopilotPolicySource(db, currentEnvironment()).load();
          const images = await chatImages(
            db,
            caller.workspaceId,
            authorization,
            body.imageAssetIds,
          );
          return { authorization, policy, images };
        });
      } catch (error: unknown) {
        if (isAppError(error)) {
          return reply
            .code(error.httpStatus)
            .send({ error: { code: error.code, details: error.publicDetails } });
        }
        log.error('copilot stream admission failed', internalErrorFields(error));
        return reply.code(500).send({ error: { code: 'INTERNAL' } });
      }

      // --- From here on, the answer is a stream. ----------------------------
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-store, no-transform',
        connection: 'keep-alive',
        // Nginx-style proxies otherwise hold the events until the end.
        'x-accel-buffering': 'no',
      });
      const controller = new AbortController();
      let finished = false;
      req.raw.on('close', () => {
        if (!finished) controller.abort();
      });
      const send = (event: string, data: unknown) => {
        if (raw.writableEnded) return;
        raw.write(`event: ${event}\ndata: ${JSON.stringify(data, bigintSafe)}\n\n`);
      };
      // A comment line every 15 s keeps idle proxies from closing a long read.
      const heartbeat = setInterval(() => {
        if (!raw.writableEnded) raw.write(': keep-alive\n\n');
      }, 15_000);

      const planKey = facts.planKey;
      const turnKey = body.idempotencyKey;
      try {
        const result = await runAgentTurn(
          {
            gateway: gateway(),
            run: (fn) =>
              inWorkspace(caller.workspaceId, async (db) => {
                const automationRuleCheck = await automationRules(db, caller.workspaceId);
                return fn(
                  new CopilotOrchestrator({
                    db,
                    workspaceId: caller.workspaceId,
                    policy: admitted.policy,
                    gateway: gateway(),
                    automationRules: automationRuleCheck,
                  }),
                );
              }),
            tools: agentToolPort({
              workspaceId: caller.workspaceId,
              userId: caller.userId,
              planKey,
              turnKey,
              facts,
              expiresAt,
            }),
            emit: (event: AgentEvent) => send(event.type, event),
            signal: controller.signal,
            limits: {
              maxRounds: admitted.policy.agent.maxRounds,
              autoSpendLimitMilli: BigInt(admitted.policy.agent.autoSpendLimitCredits) * 1000n,
            },
          },
          {
            workspaceId: caller.workspaceId,
            sessionId: body.sessionId,
            request: body.request,
            authorization: admitted.authorization,
            planKey,
            idempotencyKey: turnKey,
            expiresAt,
            ...(keyQuestions ? { keyQuestions } : {}),
            images: admitted.images.images,
            imageAssetIds: admitted.images.assetIds,
          },
        );

        const card =
          result.proposed.length > 0
            ? await proposedPlan({
                workspaceId: caller.workspaceId,
                userId: caller.userId,
                sessionId: body.sessionId,
                brandId: result.brandId,
                planKey,
                steps: result.proposed,
                answer: result.answer,
                idempotencyKey: turnKey,
                expiresAt,
                policy: admitted.policy,
              })
            : null;

        send('done', {
          answer: result.answer,
          messageId: result.messageId,
          creditsChargedMilli: result.creditsChargedMilli.toString(),
          activity: result.activity,
          knowledge: result.knowledge ? { percent: result.knowledge.percent } : null,
          /*
           * The shape the conversation screen already renders (PR B): the
           * card's fields when something waits for confirmation, and always
           * the areas named, the missing-fact notice, the Brand Brain
           * hand-off and what the reads found. Closed keys and ids only.
           */
          plan: {
            ...(card ?? {}),
            notice:
              result.deniedPermissions.length > 0
                ? 'permission_denied'
                : result.missing
                  ? 'brand_brain_missing'
                  : null,
            deniedPermissions: result.deniedPermissions,
            missing: result.missing,
            brandFactAreas: result.brandFactAreas,
            saveFact: result.saveFact,
            inspection: result.inspection.length > 0 ? result.inspection : null,
          },
        });
      } catch (error: unknown) {
        if (
          isAppError(error) &&
          (error.publicDetails as { reason?: unknown } | undefined)?.reason === 'stopped'
        ) {
          send('stopped', {});
        } else if (isAppError(error)) {
          if (error.httpStatus >= 500) {
            log.error('copilot stream failed', { code: error.code, ...internalErrorFields(error) });
          }
          send('error', { code: error.code, details: error.publicDetails ?? null });
        } else {
          log.error('copilot stream failed', internalErrorFields(error));
          send('error', { code: 'INTERNAL', details: null });
        }
      } finally {
        finished = true;
        clearInterval(heartbeat);
        if (!raw.writableEnded) raw.end();
      }
    },
  );
}

function bigintSafe(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/**
 * A JUST-SENT IMAGE IS STILL BEING SCANNED. Wait for the library to finish
 * (short reads, never one long transaction), at most ~20 s; whatever is not
 * READY by then is refused by `chatImages` with the miss shape.
 */
async function untilScanned(workspaceId: string, assetIds: readonly string[]): Promise<void> {
  if (assetIds.length === 0) return;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const rows = await inWorkspace(workspaceId, (db) =>
      db.asset.findMany({
        where: { id: { in: [...assetIds] }, workspaceId, deletedAt: null },
        select: { status: true },
      }),
    );
    if (rows.length < assetIds.length) return;
    if (rows.every((row) => row.status !== 'UPLOADING' && row.status !== 'PROCESSING')) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/**
 * THE PERSON'S OWN IMAGES, READY AND IN SCOPE. An id that is not this
 * workspace's, not an image, not READY (still scanning, quarantined) or too
 * large is refused with the miss shape — the chat never sends a file that the
 * library itself would not show.
 */
async function chatImages(
  db: TenantScopedClient,
  workspaceId: string,
  authorization: LiveAuthorization,
  assetIds: readonly string[],
): Promise<{ assetIds: string[]; images: ChatImage[] }> {
  if (assetIds.length === 0) return { assetIds: [], images: [] };
  const rows = await db.asset.findMany({
    where: { id: { in: [...assetIds] }, workspaceId, deletedAt: null, status: 'READY' },
    select: { id: true, mimeType: true, sizeBytes: true, storageKey: true, brandId: true },
  });
  const images: ChatImage[] = [];
  for (const id of assetIds) {
    const row = rows.find((candidate) => candidate.id === id);
    if (
      !row ||
      !CHAT_IMAGE_TYPES.has(row.mimeType) ||
      row.sizeBytes > MAX_CHAT_IMAGE_BYTES ||
      (row.brandId !== null && !brandInScope(authorization.brandScope, row.brandId))
    ) {
      throw new AppError('NOT_FOUND', 'That image is not available.');
    }
    const bytes = await objectStore().get(row.storageKey);
    if (!bytes) throw new AppError('NOT_FOUND', 'That image is not available.');
    images.push({
      mimeType: row.mimeType as ChatImage['mimeType'],
      base64: Buffer.from(bytes).toString('base64'),
    });
  }
  return { assetIds: [...assetIds], images };
}

/** The steps the person must confirm, as the existing plan card. */
async function proposedPlan(input: {
  workspaceId: string;
  userId: string;
  sessionId: string;
  brandId: string | null;
  planKey: string | null;
  steps: readonly { toolKey: string; arguments: Record<string, unknown> }[];
  answer: string;
  idempotencyKey: string;
  expiresAt: Date | null;
  policy: Awaited<ReturnType<TenantCopilotPolicySource['load']>>;
}) {
  return inWorkspace(input.workspaceId, async (db) => {
    const authorization = await resolveLiveAuthorization(db, input.workspaceId, input.userId);
    if (!authorization) throw new AppError('NOT_FOUND', 'Conversation not found.');
    const plans = new CopilotPlanService({
      db,
      workspaceId: input.workspaceId,
      policy: input.policy,
      denialSink: copilotDenialSink(input.workspaceId),
    });
    const created = await plans.createPlan({
      sessionId: input.sessionId,
      brandId: input.brandId,
      authorization,
      steps: input.steps,
      summary: { ar: input.answer, en: input.answer },
      estimatedCreditsMilli: await estimateFor(input.steps, input.workspaceId, input.planKey),
      idempotencyKey: `plan:${input.idempotencyKey}`,
      expiresAt: input.expiresAt,
      automationRules: await automationRules(db, input.workspaceId),
    });
    return {
      planId: created.plan.id,
      planHash: created.plan.planHash,
      planVersion: created.plan.planVersion,
      requiresConfirmation: created.plan.requiresConfirmation,
      highestActionClass: created.plan.highestActionClass,
      estimatedCreditsMilli: created.plan.estimatedCreditsMilli.toString(),
      confirmationExpiresAt: created.plan.confirmationExpiresAt?.toISOString() ?? null,
      steps: created.steps.map((step) => ({
        ordinal: step.ordinal,
        toolKey: step.toolKey,
        messageKey: step.messageKey,
        actionClass: step.actionClass,
        spendsCredits: step.spendsCredits,
        undoable: step.undoable,
        preview: step.preview,
      })),
      // RETURNED EXACTLY ONCE. Only its hash is stored.
      confirmationToken: created.confirmationToken,
    };
  });
}

// ---------------------------------------------------------------------------
// The tools, as this person, on this brand.
// ---------------------------------------------------------------------------

function fenced(label: string, value: unknown): string {
  return fenceUntrusted(
    label,
    typeof value === 'string' ? value : JSON.stringify(value, bigintSafe),
  );
}

export function agentToolPort(context: {
  workspaceId: string;
  userId: string;
  planKey: string | null;
  turnKey: string;
  facts: Awaited<ReturnType<typeof workspaceFacts>>;
  expiresAt: Date | null;
}): AgentToolPort {
  const { workspaceId } = context;
  const live = async (db: TenantScopedClient) => {
    const authorization = await resolveLiveAuthorization(db, workspaceId, context.userId);
    if (!authorization) throw new AppError('NOT_FOUND', 'Conversation not found.');
    return authorization;
  };

  return {
    knowledge: (brandId, language) => brandKnowledge(workspaceId, brandId, language),

    async quoteImage({ quality, formatKey }) {
      const format = findCreativeFormat(formatKey) ?? findCreativeFormat('square');
      const quote = await gateway().quote({
        workspaceId,
        taskKey: 'image.generate',
        planKey: context.planKey,
        input: { kind: 'image', prompt: '', count: 1, size: format?.size ?? '1080x1080', quality },
      });
      return quote.estimateMilli;
    },

    async run({ key, args, brandId, aiRequestId, callId }): Promise<AgentToolOutcome> {
      const tool = findAgentTool(key);
      if (!tool) return { ok: false, content: 'ERROR: unknown tool.' };
      let startJob: string | null = null;
      const outcome = await inWorkspace(workspaceId, async (db): Promise<AgentToolOutcome> => {
        // LIVE, PER TOOL: a permission or brand removed mid-message stops the next tool.
        const authorization = await live(db);
        if (!authorization.permissionKeys.includes(tool.permission)) {
          return {
            ok: false,
            content: 'ERROR: the person does not have permission for this. Say so briefly.',
            deniedPermission: tool.permission,
          };
        }
        if (tool.brandScoped && (!brandId || !brandInScope(authorization.brandScope, brandId))) {
          return { ok: false, content: 'ERROR: this brand is not available.' };
        }
        const idempotencyKey = `copilot:${context.turnKey}:${callId}`;
        switch (key) {
          case 'brand.profile':
            return { ok: true, content: await brandSettings(db, brandId as string) };
          case 'brand.context': {
            const grounding = await groundingFor(
              db,
              {
                brandId: brandId as string,
                question: String(args['question']),
                purpose: 'writing',
                maxItems: 12,
                maxChars: 8_000,
              },
              systemClock,
            );
            if (!grounding.enabled) {
              return { ok: true, content: 'Brand Brain is switched off for this brand.' };
            }
            return {
              ok: true,
              content:
                grounding.items.length > 0
                  ? fenceUntrusted('BRAND BRAIN FACTS', grounding.contextText)
                  : 'No approved Brand Brain fact matches that question.',
            };
          }
          case 'content.search':
            return { ok: true, content: await posts(db, brandId as string, authorization, args) };
          case 'calendar.lookup':
            return {
              ok: true,
              content: await calendar(db, workspaceId, brandId as string, authorization, args),
            };
          case 'approvals.summary':
          case 'campaign.list':
          case 'credits.balance': {
            const build = await executionContextFor({
              db,
              workspaceId,
              planKey: context.planKey,
              retention: context.facts,
              correlationId: idempotencyKey,
            });
            const executor = TOOL_EXECUTORS[key];
            /* c8 ignore next -- every key above has an executor. */
            if (!executor) return { ok: false, content: 'ERROR: unknown tool.' };
            const result = await executor(build(authorization), {
              ...args,
              ...(tool.brandScoped ? { brandId } : {}),
            });
            return {
              ok: true,
              content: fenced(key.toUpperCase(), result.result),
              // "What the Copilot found": the same metadata the read-only plan showed.
              inspection: result.result,
            };
          }
          case 'post.create_draft': {
            const policy = await resolveContentPolicy(configurationService(), currentEnvironment());
            const hashtags = (args['hashtags'] as string[] | undefined) ?? [];
            const created = await new ContentLibraryService({
              db,
              workspaceId,
              policy,
            }).createManualItem({
              brandId: brandId as string,
              title: String(args['title']),
              locale: (args['locale'] as 'AR' | 'EN' | undefined) ?? 'EN',
              variants: (args['platformKeys'] as string[]).map((platformKey) => ({
                platformKey,
                body: String(args['caption']),
                hashtags,
              })),
              actorUserId: context.userId,
              actorBrandScope: authorization.brandScope,
              expiresAt: context.expiresAt,
              idempotencyKey,
              provenance: {
                origin: 'AI_GENERATED',
                aiRequestId: aiRequestId || null,
                actorType: 'COPILOT',
              },
            });
            return {
              ok: true,
              content: `Draft created: id ${created.item.id}, title "${created.item.title}", ${created.variants.length} platform(s). It is a draft: not scheduled, not published.`,
              draft: { contentItemId: created.item.id, title: created.item.title },
            };
          }
          case 'post.generate_image': {
            if (!maySpendCredits(authorization.permissionKeys, 'assets.upload')) {
              return { ok: false, content: 'ERROR: the person cannot spend credits on images.' };
            }
            const queued = await imageJobs(db, workspaceId).generate({
              brandId: brandId as string,
              contentItemId: String(args['contentItemId']),
              brief: String(args['brief']),
              formatKey: String(args['formatKey'] ?? 'square'),
              quality: (args['quality'] as 'low' | 'medium' | 'high' | undefined) ?? 'medium',
              idempotencyKey,
              actor: authorization,
            });
            startJob = queued.jobId;
            return {
              ok: true,
              content: `Image started for draft ${String(args['contentItemId'])}: it is attached to the draft when ready (about a minute).`,
              image: { jobId: queued.jobId, contentItemId: String(args['contentItemId']) },
            };
          }
          default:
            return { ok: false, content: 'ERROR: this tool cannot run here.' };
        }
      }).catch((error: unknown): AgentToolOutcome => {
        if (isAppError(error) && error.httpStatus < 500) {
          return { ok: false, content: `ERROR: ${error.code}: ${error.message}`.slice(0, 300) };
        }
        log.error('copilot tool failed', { key, ...internalErrorFields(error) });
        return { ok: false, content: 'ERROR: the tool could not run right now.' };
      });
      // After the commit, so the job row exists for the runner.
      if (startJob) {
        startCreativeJob(workspaceId, startJob, context.planKey);
        const spent = await this.quoteImage({
          quality: (args['quality'] as 'low' | 'medium' | 'high' | undefined) ?? 'medium',
          formatKey: String(args['formatKey'] ?? 'square'),
        }).catch(() => 0n);
        return { ...outcome, spentMilli: spent };
      }
      return outcome;
    },
  };
}

/** The brand's settings, for the model: the profile and the descriptive fields. */
async function brandSettings(db: TenantScopedClient, brandId: string): Promise<string> {
  const [profile, brand] = await Promise.all([
    brandProfileFor(db, brandId),
    db.brand.findFirst({
      where: { id: brandId, deletedAt: null },
      select: { industry: true, description: true, voiceProfile: true, defaultLocale: true },
    }),
  ]);
  const lines = [
    brandProfileBlock(profile) ?? '',
    fenceUntrusted(
      'BRAND SETTINGS',
      [
        `Industry: ${brand?.industry ?? 'not set'}`,
        `Description: ${brand?.description ?? 'not set'}`,
        `Default language: ${brand?.defaultLocale ?? 'EN'}`,
        `Voice: ${brand?.voiceProfile ? JSON.stringify(brand.voiceProfile).slice(0, 2_000) : 'not set'}`,
      ].join('\n'),
    ),
  ];
  return lines.filter((line) => line !== '').join('\n\n');
}

async function posts(
  db: TenantScopedClient,
  brandId: string,
  authorization: LiveAuthorization,
  args: Record<string, unknown>,
): Promise<string> {
  const items = await db.contentItem.findMany({
    where: {
      deletedAt: null,
      ...brandIdQueryFilter({ brandId, brandScope: authorization.brandScope }),
      ...(args['query'] ? { title: { contains: String(args['query']), mode: 'insensitive' } } : {}),
    },
    orderBy: { updatedAt: 'desc' },
    take: Number(args['limit'] ?? 10),
    select: {
      id: true,
      title: true,
      status: true,
      updatedAt: true,
      variants: { select: { platformKey: true, body: true, assetIds: true }, take: 6 },
    },
  });
  if (items.length === 0) return 'No posts match.';
  return fenced(
    'POSTS',
    items.map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      updatedAt: item.updatedAt.toISOString(),
      platforms: item.variants.map((variant) => variant.platformKey),
      captionStart: (item.variants[0]?.body ?? '').slice(0, 280),
      images: item.variants.reduce((n, variant) => n + variant.assetIds.length, 0),
    })),
  );
}

async function calendar(
  db: TenantScopedClient,
  workspaceId: string,
  brandId: string,
  authorization: LiveAuthorization,
  args: Record<string, unknown>,
): Promise<string> {
  const now = systemClock.now();
  const until = new Date(now.getTime() + Number(args['daysAhead'] ?? 14) * 86_400_000);
  const [workspace, slots] = await Promise.all([
    db.workspace.findFirst({ where: { id: workspaceId }, select: { timezone: true } }),
    db.calendarSlot.findMany({
      where: {
        status: { not: 'CANCELLED' },
        ...brandIdQueryFilter({ brandId, brandScope: authorization.brandScope }),
        scheduledAtUtc: { gte: now, lte: until },
      },
      orderBy: { scheduledAtUtc: 'asc' },
      take: 50,
      select: {
        scheduledAtUtc: true,
        status: true,
        platformKeys: true,
        item: { select: { id: true, title: true } },
      },
    }),
  ]);
  if (slots.length === 0)
    return `Nothing is scheduled in the next ${Number(args['daysAhead'] ?? 14)} days.`;
  return fenced('CALENDAR', {
    timezone: workspace?.timezone ?? 'UTC',
    slots: slots.map((slot) => ({
      at: slot.scheduledAtUtc.toISOString(),
      status: slot.status,
      platforms: slot.platformKeys,
      contentItemId: slot.item.id,
      title: slot.item.title,
    })),
  });
}
