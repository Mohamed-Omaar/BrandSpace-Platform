import { createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  AnalyticsQueryService,
  TenantAnalyticsPolicySource,
  countPublishedPosts,
  createAnalyticsRegistry,
} from '@brandspace/analytics';
import { approvedFactsFor, localizedFrom } from '@brandspace/brand-brain';
import {
  ContentApprovalService,
  ContentCalendarService,
  ContentLibraryService,
  readRetentionFacts,
  resolveContentExpiry,
  resolveContentPolicy,
  type ContentPolicy,
} from '@brandspace/content';
import { withWorkspace, writeAuditEvent, type TenantScopedClient } from '@brandspace/database';
import {
  EntitlementService,
  TenantCatalogueSource,
  readAccessibleBrands,
} from '@brandspace/entitlements';
import { brandIdQueryFilter, isAppError, systemClock } from '@brandspace/shared';
import {
  platformsByFormat,
  resolvePublishingPolicy,
  unreachableChannelGate,
} from '@brandspace/social-connectors';
import { scheduleQuota } from '../routes/schedule-quota';
import type { AiAppsContext } from './context';
import {
  HELP_COPY,
  HELP_TOPICS,
  WHAT_ONLY_A_PERSON_CAN_DO,
  WHAT_THE_AI_CAN_DO,
  type HelpTopic,
} from './help';
import { mcpServerIcons } from '../brand-icons';

/**
 * D-566 — THE ELEVEN TOOLS AN AI APP MAY CALL, AND NOTHING ELSE.
 *
 * Every tool runs AS THE PERSON who connected the app: in the connection's
 * workspace (never one named in the input), limited to the brands the
 * connection names intersected with the member's own brand scope, with the
 * member's permissions read live for this request. Brandspace runs no AI for
 * any of these and spends no credits: nothing here reaches the AI gateway, the
 * Copilot or content generation (CLAUDE.md §2.4).
 *
 * THE AI PROPOSES, A PERSON DECIDES (CLAUDE.md §2.5, the Copilot contract in
 * packages/copilot/src/tools.ts). A tool may write a DRAFT, change a draft,
 * give it a proposed time and send it for review. No tool can approve, request
 * changes, reject, schedule, publish, archive, delete, connect or disconnect an
 * account, or touch billing, members or roles — those code paths are not
 * imported here, and `tests/unit/ai-apps-tools.test.ts` pins the list.
 *
 * TOOL INPUT IS UNTRUSTED. Every input is a strict schema (an unknown field is
 * refused), every id a UUID, every text bounded, control characters stripped;
 * nothing is evaluated, rendered as HTML or put into SQL. Errors come back
 * INSIDE the result (`isError`), in plain words, and an id from another
 * workspace or outside the connection's brands is "not found", worded exactly
 * like a genuine miss (CLAUDE.md §2.1).
 */

export const TOOL_NAMES = [
  'whoami',
  'list_brands',
  'get_brand_summary',
  'get_help',
  'list_posts',
  'get_post',
  'create_post',
  'update_post',
  'get_calendar',
  'get_performance',
  'get_report',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** The person, connection and live authority one MCP request runs as. */
export interface McpCaller {
  readonly connectionId: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly timezone: string;
  readonly userId: string;
  readonly personName: string;
  readonly personEmail: string;
  readonly locale: 'en' | 'ar';
  readonly appName: string;
  readonly scopes: readonly string[];
  /** Empty = every brand the member may see, including brands added later. */
  readonly connectionBrandIds: readonly string[];
  readonly roleKey: string;
  readonly permissionKeys: readonly string[];
  /** The member's own brand scope; empty = unrestricted. */
  readonly memberBrandScope: readonly string[];
  /** Why AI apps are refused for this workspace right now, or null. */
  readonly refusal: 'off' | 'plan' | null;
}

/** A scope that matches nothing, for a connection whose brands the member can no longer see. */
const NO_BRAND = '00000000-0000-0000-0000-000000000000';

/**
 * The brand scope a tool runs under: the member's scope intersected with the
 * connection's brands. Empty means unrestricted, as everywhere in the product.
 */
export function effectiveBrandScope(
  memberScope: readonly string[],
  connectionBrands: readonly string[],
): readonly string[] {
  if (connectionBrands.length === 0) return memberScope;
  if (memberScope.length === 0) return connectionBrands;
  const both = connectionBrands.filter((id) => memberScope.includes(id));
  return both.length > 0 ? both : [NO_BRAND];
}

const CONTENT_FORMATS = [
  'POST',
  'CAROUSEL',
  'STORY',
  'REEL',
  'VIDEO',
  'ARTICLE',
  'THREAD',
] as const;
const FORMAT_INPUT = z.enum(['post', 'carousel', 'story', 'reel', 'video', 'article', 'thread']);
const STATUS_INPUT = z.enum([
  'draft',
  'in_review',
  'changes_requested',
  'approved',
  'scheduled',
  'publishing',
  'published',
  'partially_published',
  'failed',
  'archived',
]);
const LOCAL_TIME = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d$/;
const LOCAL_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const HASHTAG = /^#?[\p{L}\p{N}_]{1,100}$/u;
const CHANNEL = z
  .string()
  .regex(/^[a-z0-9_-]{1,40}$/, 'A channel is a short key such as "instagram".');

/** Plain text only: control characters (other than line breaks and tabs) are removed. */
export function cleanText(value: string): string {
  // eslint-disable-next-line no-control-regex -- removing control characters is the point.
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

const cleanTags = (tags: readonly string[] | undefined) =>
  tags?.map((tag) => tag.replace(/^#/, '')) ?? undefined;

class ToolRefusal extends Error {
  constructor(
    message: string,
    readonly outcome: 'DENIED' | 'ERROR' = 'DENIED',
  ) {
    super(message);
  }
}

const NOT_FOUND = 'Not found. It does not exist, or this connection cannot see it.';

function ok(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

function refused(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** What `get_post` and the write tools return about a post. */
function postView(
  item: {
    id: string;
    brandId: string;
    title: string;
    status: string;
    contentType: string;
    proposedLocalTime: string | null;
    updatedAt: Date;
  },
  variants: readonly {
    platformKey: string;
    body: string | null;
    hashtags: readonly string[];
    firstComment: string | null;
  }[],
  policy: ContentPolicy,
  link: string,
) {
  return {
    id: item.id,
    brandId: item.brandId,
    title: item.title,
    status: item.status.toLowerCase(),
    format: item.contentType.toLowerCase(),
    proposedTime: item.proposedLocalTime,
    updatedAt: item.updatedAt.toISOString(),
    channels: variants.map((stored) => {
      const variant = { ...stored, body: stored.body ?? '' };
      const platform = policy.platforms.find((p) => p.key === variant.platformKey);
      const problems: string[] = [];
      if (platform && variant.body.length > platform.maxBodyChars) {
        problems.push(
          `The caption is ${variant.body.length} characters; ${variant.platformKey} allows ${platform.maxBodyChars}.`,
        );
      }
      if (platform && variant.hashtags.length > platform.maxHashtags) {
        problems.push(
          `${variant.hashtags.length} hashtags; ${variant.platformKey} allows ${platform.maxHashtags}.`,
        );
      }
      if (platform && variant.firstComment && !platform.allowsFirstComment) {
        problems.push(`${variant.platformKey} does not take a first comment.`);
      }
      return {
        key: variant.platformKey,
        caption: variant.body,
        hashtags: [...variant.hashtags],
        firstComment: variant.firstComment,
        characterCount: variant.body.length,
        problems,
      };
    }),
    link,
  };
}

export function buildMcpServer(caller: McpCaller, ctx: AiAppsContext): McpServer {
  const api = ctx.addresses()?.api ?? '';
  const server = new McpServer(
    {
      name: 'brandspace',
      version: '1.0.0',
      title: 'Brandspace',
      // MCP 2025-11-25 `Implementation.icons` and `websiteUrl` (D-572).
      ...(api ? { icons: mcpServerIcons(api) } : {}),
      ...(ctx.addresses()?.dashboard ? { websiteUrl: ctx.addresses()!.dashboard } : {}),
    },
    {
      instructions:
        'Brandspace is this person’s brand and social media workspace. Write posts as drafts, give them a ' +
        'proposed time and send them for review; a person in Brandspace approves, schedules and publishes. ' +
        'Call get_help to learn the channels and their limits. Use only the facts get_brand_summary returns.',
    },
  );
  const scope = effectiveBrandScope(caller.memberBrandScope, caller.connectionBrandIds);
  const dashboard = ctx.addresses()?.dashboard ?? '';
  const linkTo = (postId: string) => `${dashboard}/${caller.locale}/compose?item=${postId}`;
  const holds = (key: string) => caller.permissionKeys.includes(key);

  /** Run one tool: gate, permission, workspace transaction, audit. */
  const run = async (
    tool: ToolName,
    needs: { readonly write?: boolean; readonly permissions: readonly string[] },
    work: (
      db: TenantScopedClient,
    ) => Promise<{ data: Record<string, unknown>; postId?: string; brandId?: string }>,
  ): Promise<CallToolResult> => {
    let outcome: 'SUCCESS' | 'DENIED' | 'ERROR' = 'SUCCESS';
    let result: CallToolResult;
    let subject: { postId?: string; brandId?: string } = {};
    try {
      if (caller.refusal === 'off')
        throw new ToolRefusal('AI apps are turned off for this workspace.');
      if (caller.refusal === 'plan') {
        throw new ToolRefusal('AI apps are not included in this workspace’s plan.');
      }
      if (!caller.scopes.includes('brandspace.read')) {
        throw new ToolRefusal('This connection cannot read Brandspace. Connect again.');
      }
      if (needs.write && !caller.scopes.includes('brandspace.write')) {
        throw new ToolRefusal(
          'This connection can only read. Connect Brandspace again and allow writing drafts.',
        );
      }
      const missing = needs.permissions.find((key) => !holds(key));
      if (missing)
        throw new ToolRefusal(
          PERMISSION_WORDS[missing] ?? 'You do not have permission to do that.',
        );
      const done = await withWorkspace(caller.workspaceId, work, {
        prisma: ctx.tenant,
        timeoutMs: 30_000,
      });
      subject = {
        ...(done.postId ? { postId: done.postId } : {}),
        ...(done.brandId ? { brandId: done.brandId } : {}),
      };
      result = ok(done.data);
    } catch (error: unknown) {
      if (error instanceof ToolRefusal) {
        outcome = error.outcome;
        result = refused(error.message);
      } else if (isAppError(error)) {
        outcome = error.code === 'NOT_FOUND' ? 'DENIED' : 'ERROR';
        result = refused(error.code === 'NOT_FOUND' ? NOT_FOUND : error.message);
      } else {
        outcome = 'ERROR';
        result = refused('Something went wrong in Brandspace. Try again in a moment.');
      }
    }
    // Every call is audited — who, which app, what — in its own transaction, so
    // a refusal survives the rollback of the work it refused. Inputs are not
    // copied: captions can be long and personal.
    await withWorkspace(
      caller.workspaceId,
      (db) =>
        writeAuditEvent(db, caller.workspaceId, {
          action: 'ai_app.tool.called',
          actorType: 'USER',
          actorId: caller.userId,
          resourceType: 'ai_app_connection',
          resourceId: caller.connectionId,
          outcome,
          severity: outcome === 'SUCCESS' ? 'INFO' : 'WARNING',
          ...(subject.brandId ? { brandId: subject.brandId } : {}),
          after: {
            app: caller.appName,
            connectionId: caller.connectionId,
            tool,
            outcome,
            ...subject,
          },
        }),
      { prisma: ctx.tenant },
    ).catch(() => undefined);
    return result;
  };

  const services = async (db: TenantScopedClient) => {
    const policy = await resolveContentPolicy(ctx.configuration, ctx.environment);
    const library = new ContentLibraryService({ db, workspaceId: caller.workspaceId, policy });
    const approvals = new ContentApprovalService({ db, workspaceId: caller.workspaceId, policy });
    const calendar = new ContentCalendarService({
      db,
      workspaceId: caller.workspaceId,
      policy,
      timezone: caller.timezone,
      quota: scheduleQuota(db, caller.workspaceId),
      channelGate: unreachableChannelGate(db, caller.workspaceId, ctx.environment),
      approvalGate: approvals,
    });
    return { policy, library, approvals, calendar };
  };

  const brands = (db: TenantScopedClient) =>
    readAccessibleBrands(
      db as never,
      new EntitlementService({
        prisma: db as never,
        catalogueSource: new TenantCatalogueSource(db as never, ctx.environment),
        environment: ctx.environment,
      }),
      caller.workspaceId,
      scope,
    );

  const requireBrand = async (db: TenantScopedClient, brandId: string) => {
    const visible = await brands(db);
    const brand = visible.find((b) => b.id === brandId);
    if (!brand) throw new ToolRefusal(NOT_FOUND);
    return brand;
  };

  const READ = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
  const WRITE = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  };
  const brandIdInput = z.string().uuid('A brand id is a UUID from list_brands.');
  const postIdInput = z.string().uuid('A post id is a UUID from list_posts.');

  // 1 ---------------------------------------------------------------------
  server.registerTool(
    'whoami',
    {
      title: 'Who am I',
      description:
        'Who you are in Brandspace: your name, workspace, role, what you may do, and the brands this connection can see.',
      inputSchema: z.object({}).strict(),
      annotations: READ,
    },
    async () =>
      run('whoami', { permissions: [] }, async (db) => ({
        data: {
          person: { name: caller.personName, email: caller.personEmail },
          workspace: { id: caller.workspaceId, name: caller.workspaceName },
          role: caller.roleKey,
          permissions: {
            canReadPosts: holds('content.read'),
            canCreatePosts: holds('content.create') && caller.scopes.includes('brandspace.write'),
            canEditPosts: holds('content.edit') && caller.scopes.includes('brandspace.write'),
            canSendForReview: holds('content.submit') && caller.scopes.includes('brandspace.write'),
            canReadPerformance: holds('analytics.read'),
            canReadBrandBrain: holds('brand_brain.read'),
            canApproveScheduleOrPublish: false,
          },
          brands: (await brands(db)).map((b) => ({ id: b.id, name: b.name })),
          app: { name: caller.appName },
          timezone: caller.timezone,
          locale: caller.locale,
        },
      })),
  );

  // 2 ---------------------------------------------------------------------
  server.registerTool(
    'list_brands',
    {
      title: 'List brands',
      description:
        'The brands this connection can see, with the social accounts connected to each.',
      inputSchema: z.object({}).strict(),
      annotations: READ,
    },
    async () =>
      run('list_brands', { permissions: [] }, async (db) => {
        const visible = await brands(db);
        const accounts = visible.length
          ? await db.socialConnection.findMany({
              where: { brandId: { in: visible.map((b) => b.id) }, status: 'ACTIVE' },
              select: { brandId: true, provider: true },
            })
          : [];
        return {
          data: {
            brands: visible.map((brand) => ({
              id: brand.id,
              name: brand.name,
              status: brand.status.toLowerCase(),
              connectedAccounts: [
                ...new Set(
                  accounts
                    .filter((a) => a.brandId === brand.id)
                    .map((a) => a.provider.toLowerCase()),
                ),
              ],
            })),
          },
        };
      }),
  );

  // 3 ---------------------------------------------------------------------
  server.registerTool(
    'get_brand_summary',
    {
      title: 'Brand summary',
      description:
        'The facts Brand Brain has approved for a brand: audience, voice, offers, rules. Only approved facts; use these and nothing invented.',
      inputSchema: z.object({ brandId: brandIdInput }).strict(),
      annotations: READ,
    },
    async ({ brandId }) =>
      run('get_brand_summary', { permissions: ['brand_brain.read'] }, async (db) => {
        const brand = await requireBrand(db, brandId);
        const MAX_FACTS = 100;
        const MAX_CHARS = 60_000;
        const { enabled, facts, truncated } = await approvedFactsFor(
          db,
          { brandId, maxItems: MAX_FACTS },
          ctx.clock,
        );
        const pick = (value: unknown) => {
          const text = localizedFrom(value as never);
          return (caller.locale === 'ar' ? text.ar || text.en : text.en || text.ar) ?? '';
        };
        let used = 0;
        let cut = truncated;
        const out = [];
        for (const fact of facts) {
          const row = {
            area: fact.area.toLowerCase(),
            title: pick(fact.title),
            body: pick(fact.body),
            updatedAt: fact.updatedAt.toISOString(),
          };
          used += row.title.length + row.body.length;
          if (used > MAX_CHARS) {
            cut = true;
            break;
          }
          out.push(row);
        }
        return {
          brandId,
          data: {
            brand: { id: brand.id, name: brand.name },
            brandBrainUsedForWriting: enabled,
            facts: out,
            factCount: out.length,
            truncated: cut,
            ...(enabled
              ? {}
              : {
                  note: 'This brand has "Use Brand Brain" turned off, so no facts are shared for writing.',
                }),
          },
        };
      }),
  );

  // 4 ---------------------------------------------------------------------
  server.registerTool(
    'get_help',
    {
      title: 'Help',
      description:
        'How Brandspace works: the screens, the channels and their limits, review and approval, the calendar, and what an AI app may and may not do.',
      inputSchema: z
        .object({ topic: z.enum(HELP_TOPICS).optional(), locale: z.enum(['en', 'ar']).optional() })
        .strict(),
      annotations: READ,
    },
    async ({ topic, locale }) =>
      run('get_help', { permissions: [] }, async () => {
        const lang = locale ?? caller.locale;
        const policy = await resolveContentPolicy(ctx.configuration, ctx.environment);
        const publishing = await resolvePublishingPolicy(ctx.configuration, ctx.environment);
        const providers = publishing.providers as unknown as Record<
          string,
          { postKinds: readonly string[] } | undefined
        >;
        const formatsFor = platformsByFormat(
          CONTENT_FORMATS,
          policy.platforms.map((p) => p.key),
          providers as never,
        );
        const topics = (topic ? [topic] : [...HELP_TOPICS]) as HelpTopic[];
        return {
          data: {
            topics: topics.map((key) => ({ key, ...HELP_COPY[lang][key] })),
            channels: policy.platforms.map((platform) => ({
              key: platform.key,
              formats: CONTENT_FORMATS.filter((f) => formatsFor[f]?.includes(platform.key)).map(
                (f) => f.toLowerCase(),
              ),
              maxCaptionChars: platform.maxBodyChars,
              maxHashtags: platform.maxHashtags,
              maxMedia: platform.maxMediaItems,
              firstComment: platform.allowsFirstComment,
            })),
            approvalFlow: {
              steps: ['draft', 'in_review', 'approved', 'scheduled', 'published'],
              requireApprovalBeforeScheduling:
                policy.approvals.requireApprovalBeforeScheduling ||
                policy.calendar.requireApprovalBeforeScheduling,
            },
            timezone: caller.timezone,
            whatTheAiCanDo: WHAT_THE_AI_CAN_DO[lang],
            whatOnlyAPersonCanDo: WHAT_ONLY_A_PERSON_CAN_DO[lang],
          },
        };
      }),
  );

  // 5 ---------------------------------------------------------------------
  server.registerTool(
    'list_posts',
    {
      title: 'List posts',
      description:
        'Posts in this workspace, newest first, optionally for one brand, status or channel, or by title.',
      inputSchema: z
        .object({
          brandId: brandIdInput.optional(),
          status: z.array(STATUS_INPUT).max(10).optional(),
          channel: CHANNEL.optional(),
          search: z.string().max(100).optional(),
          limit: z.number().int().min(1).max(50).optional(),
          cursor: z
            .string()
            .regex(/^\d{1,5}$/)
            .optional(),
        })
        .strict(),
      annotations: READ,
    },
    async (input) =>
      run('list_posts', { permissions: ['content.read'] }, async (db) => {
        if (input.brandId) await requireBrand(db, input.brandId);
        const { library } = await services(db);
        const limit = input.limit ?? 20;
        const offset = Number(input.cursor ?? '0');
        const rows = await library.listItems({
          brandId: input.brandId,
          brandScope: scope,
          statuses: input.status?.map((s) => s.toUpperCase()) as never,
          platformKey: input.channel,
          search: input.search ? cleanText(input.search) : undefined,
          limit: limit + 1,
          offset,
        });
        return {
          data: {
            posts: rows.slice(0, limit).map((item) => ({
              id: item.id,
              brandId: item.brandId,
              title: item.title,
              status: item.status.toLowerCase(),
              format: item.contentType.toLowerCase(),
              channels: item.variants.map((v) => v.platformKey),
              proposedTime: item.proposedLocalTime,
              updatedAt: item.updatedAt.toISOString(),
            })),
            ...(rows.length > limit ? { nextCursor: String(offset + limit) } : {}),
          },
        };
      }),
  );

  // 6 ---------------------------------------------------------------------
  server.registerTool(
    'get_post',
    {
      title: 'Read a post',
      description:
        'One post: its captions per channel, status, proposed or scheduled time, review state and a link to open it in Brandspace.',
      inputSchema: z.object({ postId: postIdInput }).strict(),
      annotations: READ,
    },
    async ({ postId }) =>
      run('get_post', { permissions: ['content.read'] }, async (db) => {
        const { library, policy, approvals, calendar } = await services(db);
        const item = await library.getItem(postId, scope);
        const [slot, review] = await Promise.all([
          calendar.slotForItem(item.id),
          approvals.latestForItem(item.id),
        ]);
        return {
          postId,
          brandId: item.brandId,
          data: {
            ...postView(item, item.variants, policy, linkTo(item.id)),
            scheduledTime:
              slot && slot.status !== 'CANCELLED'
                ? { utc: slot.scheduledAtUtc.toISOString(), local: slot.scheduledLocalTime }
                : null,
            review: review
              ? { status: review.status.toLowerCase(), note: review.decisionNote ?? null }
              : null,
          },
        };
      }),
  );

  // 7 ---------------------------------------------------------------------
  const perChannel = z
    .record(
      CHANNEL,
      z
        .object({
          caption: z.string().min(1).max(10_000).optional(),
          hashtags: z.array(z.string().regex(HASHTAG)).max(60).optional(),
          firstComment: z.string().max(2_200).optional(),
        })
        .strict(),
    )
    .optional();

  server.registerTool(
    'create_post',
    {
      title: 'Write a draft post',
      description:
        'Save a new post as a DRAFT for one brand, in one format, for one or more channels. Optionally give it a proposed time ' +
        '(YYYY-MM-DDTHH:mm, workspace time) so it shows on the calendar as proposed, and send it for review. ' +
        'It is never approved, scheduled or published by this: a person does that in Brandspace.',
      inputSchema: z
        .object({
          brandId: brandIdInput,
          title: z.string().max(200).optional(),
          format: FORMAT_INPUT,
          channels: z.array(CHANNEL).min(1).max(8),
          caption: z.string().min(1).max(10_000),
          hashtags: z.array(z.string().regex(HASHTAG)).max(60).optional(),
          perChannel,
          proposedTime: z
            .string()
            .regex(LOCAL_TIME, 'Use YYYY-MM-DDTHH:mm in the workspace time zone.')
            .optional(),
          sendForReview: z.boolean().optional(),
          reviewNote: z.string().max(500).optional(),
        })
        .strict(),
      annotations: WRITE,
    },
    async (input) => {
      const permissions = ['content.create'];
      if (input.proposedTime) permissions.push('content.edit');
      if (input.sendForReview) permissions.push('content.submit');
      return run('create_post', { write: true, permissions }, async (db) => {
        await requireBrand(db, input.brandId);
        const { library, policy, calendar, approvals } = await services(db);
        const contentType = input.format.toUpperCase() as (typeof CONTENT_FORMATS)[number];
        const channels = [...new Set(input.channels)];
        const unknown = channels.filter((key) => !policy.platforms.some((p) => p.key === key));
        if (unknown.length > 0) {
          throw new ToolRefusal(
            `Brandspace does not have these channels: ${unknown.join(', ')}. Call get_help for the list.`,
          );
        }
        const publishing = await resolvePublishingPolicy(ctx.configuration, ctx.environment);
        const carriers =
          platformsByFormat(
            CONTENT_FORMATS,
            policy.platforms.map((p) => p.key),
            publishing.providers as never,
          )[contentType] ?? [];
        const notCarried = channels.filter((key) => !carriers.includes(key));
        if (notCarried.length > 0) {
          throw new ToolRefusal(
            `A ${input.format} cannot go to ${notCarried.join(', ')}. Call get_help to see which formats each channel takes.`,
          );
        }
        const brand = await db.brand.findFirst({
          where: { id: input.brandId },
          select: { defaultLocale: true },
        });
        const facts = await readRetentionFacts(db, caller.workspaceId);
        const caption = cleanText(input.caption);
        const idempotencyKey = createHash('sha256')
          .update(`${caller.connectionId}\u0000${JSON.stringify(input)}`)
          .digest('hex')
          .slice(0, 64);
        const title =
          cleanText(input.title?.trim() || caption.split('\n')[0]!.slice(0, 80)) || 'Untitled post';
        const created = await library.createManualItem({
          brandId: input.brandId,
          title,
          contentType,
          locale: brand?.defaultLocale ?? 'EN',
          variants: channels.map((platformKey) => {
            const own = input.perChannel?.[platformKey];
            return {
              platformKey,
              body: own?.caption ? cleanText(own.caption) : caption,
              hashtags: cleanTags(own?.hashtags ?? input.hashtags) ?? [],
              firstComment: own?.firstComment ? cleanText(own.firstComment) : null,
            };
          }),
          idempotencyKey,
          expiresAt: resolveContentExpiry(policy, facts, systemClock),
          actorUserId: caller.userId,
          actorBrandScope: scope,
        });
        let item = created.item;
        if (input.proposedTime && !created.replayed) {
          // A proposed time only: no slot, no quota, nothing scheduled, and never
          // "right after approval" — that would make a person's approval publish.
          item = await calendar.propose({
            contentItemId: item.id,
            localTime: input.proposedTime,
            actorUserId: caller.userId,
            actorBrandScope: scope,
          });
        }
        if (input.sendForReview && item.status === 'DRAFT') {
          await approvals.submit({
            itemId: item.id,
            actor: {
              userId: caller.userId,
              roleKey: caller.roleKey,
              permissionKeys: caller.permissionKeys,
              brandScope: scope,
            },
            note: input.reviewNote ? cleanText(input.reviewNote) : null,
          });
        }
        const fresh = await library.getItem(item.id, scope);
        return {
          postId: fresh.id,
          brandId: fresh.brandId,
          data: {
            ...postView(fresh, fresh.variants, policy, linkTo(fresh.id)),
            onCalendar: fresh.proposedLocalTime !== null,
            alreadyExisted: created.replayed,
          },
        };
      });
    },
  );

  // 8 ---------------------------------------------------------------------
  server.registerTool(
    'update_post',
    {
      title: 'Change a draft post',
      description:
        'Change a post that is a DRAFT or that a reviewer sent back (changes requested): its caption, hashtags, format, channels ' +
        'or proposed time, and optionally send it for review. A post in review, approved, scheduled or published cannot be changed here.',
      inputSchema: z
        .object({
          postId: postIdInput,
          caption: z.string().min(1).max(10_000).optional(),
          hashtags: z.array(z.string().regex(HASHTAG)).max(60).optional(),
          perChannel,
          format: FORMAT_INPUT.optional(),
          channels: z.array(CHANNEL).min(1).max(8).optional(),
          proposedTime: z
            .string()
            .regex(LOCAL_TIME, 'Use YYYY-MM-DDTHH:mm in the workspace time zone.')
            .nullable()
            .optional(),
          sendForReview: z.boolean().optional(),
          reviewNote: z.string().max(500).optional(),
        })
        .strict(),
      annotations: WRITE,
    },
    async (input) => {
      const permissions = ['content.edit'];
      if (input.sendForReview) permissions.push('content.submit');
      return run('update_post', { write: true, permissions }, async (db) => {
        const { library, policy, calendar, approvals } = await services(db);
        const current = await library.getItem(input.postId, scope);
        if (current.status !== 'DRAFT' && current.status !== 'CHANGES_REQUESTED') {
          throw new ToolRefusal(
            `This post can’t be changed here: it is ${current.status.toLowerCase().replace(/_/g, ' ')}. Open it in Brandspace: ${linkTo(current.id)}`,
          );
        }
        if (input.format || input.channels) {
          const contentType = (input.format?.toUpperCase() ??
            current.contentType) as (typeof CONTENT_FORMATS)[number];
          const publishing = await resolvePublishingPolicy(ctx.configuration, ctx.environment);
          const carriers =
            platformsByFormat(
              CONTENT_FORMATS,
              policy.platforms.map((p) => p.key),
              publishing.providers as never,
            )[contentType] ?? [];
          await library.changeDraftShape({
            itemId: current.id,
            contentType,
            platformKeys: input.channels
              ? [...new Set(input.channels)]
              : current.variants.map((v) => v.platformKey),
            carriers,
            actorUserId: caller.userId,
            actorBrandScope: scope,
          });
        }
        if (input.caption || input.hashtags || input.perChannel) {
          const shaped = await library.getItem(current.id, scope);
          for (const variant of shaped.variants) {
            const own = input.perChannel?.[variant.platformKey];
            if (!own && !input.caption && !input.hashtags) continue;
            await library.editVariant({
              variantId: variant.id,
              body: own?.caption
                ? cleanText(own.caption)
                : input.caption
                  ? cleanText(input.caption)
                  : (variant.body ?? ''),
              hashtags: cleanTags(own?.hashtags ?? input.hashtags) ?? variant.hashtags,
              firstComment:
                own?.firstComment !== undefined
                  ? cleanText(own.firstComment)
                  : variant.firstComment,
              actorUserId: caller.userId,
              actorBrandScope: scope,
              actorPermissionKeys: caller.permissionKeys,
            });
          }
        }
        if (input.proposedTime !== undefined) {
          await calendar.propose({
            contentItemId: current.id,
            localTime: input.proposedTime,
            actorUserId: caller.userId,
            actorBrandScope: scope,
          });
        }
        if (input.sendForReview) {
          await approvals.submit({
            itemId: current.id,
            actor: {
              userId: caller.userId,
              roleKey: caller.roleKey,
              permissionKeys: caller.permissionKeys,
              brandScope: scope,
            },
            note: input.reviewNote ? cleanText(input.reviewNote) : null,
          });
        }
        const fresh = await library.getItem(current.id, scope);
        return {
          postId: fresh.id,
          brandId: fresh.brandId,
          data: {
            ...postView(fresh, fresh.variants, policy, linkTo(fresh.id)),
            onCalendar: fresh.proposedLocalTime !== null,
          },
        };
      });
    },
  );

  // 9 ---------------------------------------------------------------------
  server.registerTool(
    'get_calendar',
    {
      title: 'Calendar',
      description:
        'What is on the calendar between two days (at most 62 days), in the workspace time zone: scheduled posts and drafts with a proposed time.',
      inputSchema: z
        .object({
          from: z.string().regex(LOCAL_DATE, 'Use YYYY-MM-DD.'),
          to: z.string().regex(LOCAL_DATE, 'Use YYYY-MM-DD.'),
          brandId: brandIdInput.optional(),
          channel: CHANNEL.optional(),
        })
        .strict(),
      annotations: READ,
    },
    async (input) =>
      run('get_calendar', { permissions: ['content.read'] }, async (db) => {
        const span =
          (Date.parse(`${input.to}T00:00:00Z`) - Date.parse(`${input.from}T00:00:00Z`)) /
          86_400_000;
        if (!(span >= 0 && span <= 62))
          throw new ToolRefusal('Ask for a range of 0 to 62 days, with "from" before "to".');
        if (input.brandId) await requireBrand(db, input.brandId);
        const { calendar } = await services(db);
        // A day's edges in the workspace zone can sit a day away in UTC; read a
        // day either side and keep what falls on the asked local days.
        const start = new Date(Date.parse(`${input.from}T00:00:00Z`) - 86_400_000);
        const end = new Date(Date.parse(`${input.to}T00:00:00Z`) + 2 * 86_400_000);
        const slots = await calendar.listSlots({
          start,
          end,
          brandId: input.brandId,
          brandScope: scope,
        });
        const planned = slots
          .filter(
            (view) =>
              view.slot.scheduledLocalTime.slice(0, 10) >= input.from &&
              view.slot.scheduledLocalTime.slice(0, 10) <= input.to,
          )
          .filter(
            (view) => !input.channel || view.variants.some((v) => v.platformKey === input.channel),
          )
          .map((view) => ({
            date: view.slot.scheduledLocalTime.slice(0, 10),
            postId: view.item.id,
            title: view.item.title,
            status: view.item.status.toLowerCase(),
            channels: view.variants.map((v) => v.platformKey),
            time: view.slot.scheduledLocalTime.slice(11, 16),
            kind: 'planned' as const,
          }));
        const proposedRows = await db.contentItem.findMany({
          where: {
            deletedAt: null,
            status: { in: ['DRAFT', 'IN_REVIEW', 'CHANGES_REQUESTED', 'APPROVED'] },
            proposedLocalTime: { gte: `${input.from}T00:00`, lte: `${input.to}T23:59` },
            // A post with a live slot is listed above as planned, not twice.
            calendarSlots: { none: { status: { notIn: ['CANCELLED', 'FAILED'] } } },
            ...brandIdQueryFilter({ brandId: input.brandId, brandScope: scope }),
            ...(input.channel ? { variants: { some: { platformKey: input.channel } } } : {}),
          },
          orderBy: [{ proposedLocalTime: 'asc' }, { id: 'asc' }],
          take: 500,
          select: {
            id: true,
            title: true,
            status: true,
            proposedLocalTime: true,
            variants: { select: { platformKey: true } },
          },
        });
        const proposed = proposedRows.map((row) => ({
          date: row.proposedLocalTime!.slice(0, 10),
          postId: row.id,
          title: row.title,
          status: row.status.toLowerCase(),
          channels: row.variants.map((v) => v.platformKey),
          time: row.proposedLocalTime!.slice(11, 16),
          kind: 'proposed' as const,
        }));
        const byDay = new Map<string, unknown[]>();
        for (const entry of [...planned, ...proposed].sort((a, b) =>
          `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`),
        )) {
          byDay.set(entry.date, [...(byDay.get(entry.date) ?? []), entry]);
        }
        return {
          data: {
            timezone: caller.timezone,
            days: [...byDay.entries()].map(([date, items]) => ({ date, items })),
          },
        };
      }),
  );

  // 10 --------------------------------------------------------------------
  const performance = async (
    db: TenantScopedClient,
    brandId: string,
    period: '7d' | '28d' | '90d',
    compare: boolean,
  ) => {
    const days = Number(period.replace('d', ''));
    const end = ctx.clock.now();
    const start = new Date(end.getTime() - days * 86_400_000);
    const comparison = compare
      ? { start: new Date(start.getTime() - days * 86_400_000), end: start }
      : undefined;
    const policy = await new TenantAnalyticsPolicySource(db, ctx.environment).load();
    const queries = new AnalyticsQueryService({
      db,
      workspaceId: caller.workspaceId,
      policy,
      registry: createAnalyticsRegistry({ environment: ctx.environment }),
      clock: ctx.clock,
    });
    const KEYS = ['impressions', 'reach', 'engagements', 'clicks', 'followers', 'engagement_rate'];
    const summary = await queries.summary({
      scope: { brandId },
      period: { start, end },
      comparison,
      brandScope: scope,
      metricKeys: KEYS,
    });
    const connected = summary.connectionCount > 0;
    const metrics = summary.metrics
      .filter((m) => KEYS.includes(m.metricKey))
      .map((m) => ({
        key: m.metricKey,
        unit: m.unit.toLowerCase(),
        // Values are strings (they are 64-bit counts); a missing value is never a number.
        value: connected && m.value !== null ? m.value.toString() : null,
        absent: connected ? m.absent : 'no_connection',
        ...(compare && connected
          ? {
              previous: m.previousValue?.toString() ?? null,
              changePct: m.changeMilli === null ? null : (m.changeMilli / 10).toFixed(1),
            }
          : {}),
      }));
    const top = connected
      ? await queries.topPosts({
          scope: { brandId },
          period: { start, end },
          metricKey: 'engagements',
          limit: 5,
          brandScope: scope,
        })
      : [];
    const perChannel = connected
      ? await queries.byProvider({
          scope: { brandId },
          period: { start, end },
          metricKey: 'engagements',
          brandScope: scope,
        })
      : [];
    return {
      period: { days, from: start.toISOString(), to: end.toISOString() },
      connected,
      connectionCount: summary.connectionCount,
      needsReconnect: summary.connectionsNeedingReauth,
      freshness: summary.freshness,
      lastSyncedAt: summary.lastSyncedAt?.toISOString() ?? null,
      ...(connected
        ? {}
        : { note: 'This brand has no connected social account, so there are no figures.' }),
      metrics,
      perChannel: perChannel.map((row) => ({
        channel: row.provider.toLowerCase(),
        engagements: row.value === null ? null : row.value.toString(),
      })),
      topPosts: top.map((row) => ({
        postId: row.contentItemId,
        title: row.title,
        channel: row.provider.toLowerCase(),
        engagements: row.value.toString(),
        publishedAt: row.publishedAt?.toISOString() ?? null,
      })),
    };
  };

  server.registerTool(
    'get_performance',
    {
      title: 'Performance',
      description:
        'How a brand’s published posts did over the last 7, 28 or 90 days, from its connected social accounts. With no connected account it says so and gives no numbers.',
      inputSchema: z
        .object({
          brandId: brandIdInput,
          period: z.enum(['7d', '28d', '90d']),
          compare: z.boolean().optional(),
        })
        .strict(),
      annotations: READ,
    },
    async (input) =>
      run('get_performance', { permissions: ['analytics.read'] }, async (db) => {
        await requireBrand(db, input.brandId);
        return {
          brandId: input.brandId,
          data: await performance(db, input.brandId, input.period, input.compare ?? false),
        };
      }),
  );

  // 11 --------------------------------------------------------------------
  server.registerTool(
    'get_report',
    {
      title: 'Report',
      description:
        'A report for a period (at most 92 days): posts created and where they stand, reviews waiting, posts published, and performance when you may read it.',
      inputSchema: z
        .object({
          brandId: brandIdInput.optional(),
          from: z.string().regex(LOCAL_DATE, 'Use YYYY-MM-DD.'),
          to: z.string().regex(LOCAL_DATE, 'Use YYYY-MM-DD.'),
        })
        .strict(),
      annotations: READ,
    },
    async (input) =>
      run('get_report', { permissions: ['content.read'] }, async (db) => {
        const start = new Date(`${input.from}T00:00:00Z`);
        const end = new Date(Date.parse(`${input.to}T00:00:00Z`) + 86_400_000);
        const span = (end.getTime() - start.getTime()) / 86_400_000;
        if (!(span >= 1 && span <= 93))
          throw new ToolRefusal('Ask for a range of 1 to 92 days, with "from" before "to".');
        if (input.brandId) await requireBrand(db, input.brandId);
        const filter = brandIdQueryFilter({ brandId: input.brandId, brandScope: scope });
        const grouped = await db.contentItem.groupBy({
          by: ['status'],
          where: { deletedAt: null, createdAt: { gte: start, lt: end }, ...filter },
          _count: { _all: true },
        });
        const count = (status: string) =>
          grouped.find((g) => g.status === status)?._count._all ?? 0;
        const { approvals } = await services(db);
        const published = await countPublishedPosts(db, {
          brandId: input.brandId,
          brandScope: scope,
          period: { start, end },
        } as never);
        let perf: unknown = { available: false, reason: 'no_permission' };
        if (holds('analytics.read')) {
          if (input.brandId) {
            const days = span <= 7 ? '7d' : span <= 28 ? '28d' : '90d';
            const result = await performance(db, input.brandId, days, false);
            perf = result.connected ? result : { available: false, reason: 'no_connection' };
          } else {
            perf = { available: false, reason: 'choose_a_brand' };
          }
        }
        return {
          ...(input.brandId ? { brandId: input.brandId } : {}),
          data: {
            period: { from: input.from, to: input.to, timezone: caller.timezone },
            posts: {
              created: grouped.reduce((sum, g) => sum + g._count._all, 0),
              draft: count('DRAFT'),
              inReview: count('IN_REVIEW'),
              changesRequested: count('CHANGES_REQUESTED'),
              approved: count('APPROVED'),
              scheduled: count('SCHEDULED'),
              failed: count('FAILED'),
            },
            publishedInPeriod: published,
            approvalsPending: await approvals.pendingCount(scope),
            performance: perf,
          },
        };
      }),
  );

  return server;
}

/** The refusal a member hears when their role lacks the permission, in plain words. */
const PERMISSION_WORDS: Readonly<Record<string, string>> = {
  'content.read': 'You don’t have permission to read posts in this workspace.',
  'content.create': 'You don’t have permission to create posts in this workspace.',
  'content.edit': 'You don’t have permission to edit posts in this workspace.',
  'content.submit': 'You don’t have permission to send posts for review in this workspace.',
  'analytics.read': 'You don’t have permission to read performance in this workspace.',
  'brand_brain.read': 'You don’t have permission to read Brand Brain in this workspace.',
};
