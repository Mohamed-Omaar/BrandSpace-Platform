import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { closeQueues, queueFor, verifySocialPostJobKey } from '@brandspace/jobs';
import { connectionReauthNotifier } from '@brandspace/notifications';
import {
  createConnectorRegistry,
  executePublishJob,
  parsePublishingPolicy,
  ProviderRateLimiter,
  PublishPipelineService,
  recoverStalePublishJob,
  SocialTokenVault,
  type PipelineTransactions,
  type PublishingPolicy,
  type PublishMediaPort,
  type PublishNotifier,
  type PublishRequest,
  type SocialConnectorAdapter,
} from '@brandspace/social-connectors';
import { systemClock, type Clock } from '@brandspace/shared';
import { MaintenanceScheduler } from '../../apps/api/src/scheduler';
import {
  appRoleClient,
  createIsolationFixtures,
  FIXTURE_SOCIAL_KEK,
  type IsolationFixtures,
} from './fixtures';

/**
 * CONNECTORS A (D-505) — THE PIPELINE'S READINESS ITEMS, against real
 * PostgreSQL and the deterministic mock connectors. No real platform is
 * reached; the mocks choose their answer from a marker in the job's key.
 *
 *   W2  the request carries the post kind, link and options; an undeclared
 *       kind is refused before any call.
 *   W3  media rules from configuration refuse a file before any call.
 *   O1  a platform that fetches by URL gets a pipeline-minted URL, or nothing
 *       is sent.
 *   W5  an accepted-but-unfinished publish waits with its handle, is polled by
 *       the sweep, and is never resent.
 *   R8  a published post whose copy differs from the preview is recorded.
 *   W12 publishing spends from the request budget; an empty one holds the job.
 *   R3  the account's owner is told, once, when it needs reconnecting.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;

const vault = new SocialTokenVault({
  env: { SOCIAL_TOKEN_VAULT_KEK: FIXTURE_SOCIAL_KEK } as NodeJS.ProcessEnv,
});

const approvals = {
  policyForBrand: async () => ({ requireApprovalBeforeScheduling: false }),
  latestForItem: async () => ({ status: 'APPROVED' }),
};

function policyWith(linkedin: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return parsePublishingPolicy({
    providers: {
      linkedin: {
        enabled: true,
        postKinds: ['text', 'image'],
        maxMediaItems: 10,
        supportsPostLookup: true,
        scopes: ['w_member_social'],
        targetKind: 'organization',
        ...linkedin,
      },
    },
    ...extra,
  });
}

/** The real LinkedIn mock, with every publish request recorded. */
function recordingRegistry(policy: PublishingPolicy) {
  const requests: PublishRequest[] = [];
  const real = createConnectorRegistry({ policy, environment: 'DEVELOPMENT' }).get('LINKEDIN');
  const publish: SocialConnectorAdapter['publish'] = async (input) => {
    requests.push(input.request);
    return real.publish(input);
  };
  const adapter = new Proxy(real, {
    get(target, property) {
      if (property === 'publish') return publish;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
  return {
    requests,
    registry: createConnectorRegistry({
      policy,
      environment: 'DEVELOPMENT',
      adapters: { LINKEDIN: adapter },
    }),
  };
}

/** Every step in its own tenant transaction, as the worker runs it. */
function transactions(input: {
  policy: PublishingPolicy;
  registry: ReturnType<typeof createConnectorRegistry>;
  media?: PublishMediaPort;
  notifier?: PublishNotifier;
  rateLimiter?: ProviderRateLimiter;
  clock?: Clock;
}): PipelineTransactions {
  return {
    run: (step) =>
      withWorkspace(
        fixtures.a.workspaceId,
        async (db) =>
          step(
            new PublishPipelineService({
              db,
              workspaceId: fixtures.a.workspaceId,
              policy: input.policy,
              registry: input.registry,
              vault,
              approvals,
              media: input.media,
              notifier: input.notifier,
              rateLimiter: input.rateLimiter,
              ...(input.clock ? { clock: input.clock } : {}),
            }),
          ),
        { prisma: app },
      ),
  };
}

function inA<T>(fn: (db: TenantScopedClient) => Promise<T>): Promise<T> {
  return withWorkspace(fixtures.a.workspaceId, fn, { prisma: app }) as Promise<T>;
}

async function seedJob(marker: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const job = await inA((db) =>
    db.publishJob.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        calendarSlotId: fixtures.a.calendarSlotId,
        contentItemId: fixtures.a.contentItemId,
        contentVariantId: fixtures.a.contentVariantId,
        socialConnectionId: fixtures.a.socialConnectionId,
        provider: 'LINKEDIN',
        status: 'QUEUED',
        idempotencyKey: `conn-a-${marker}-${randomUUID()}`,
        scheduledAtUtc: new Date(),
        maxAttempts: 5,
        nextAttemptAt: new Date(),
        createdByUserId: fixtures.a.userId,
        ...overrides,
      },
    }),
  );
  return job.id;
}

const readJob = (jobId: string) =>
  inA((db) => db.publishJob.findFirstOrThrow({ where: { id: jobId } }));

const attemptsOf = (jobId: string) =>
  inA((db) =>
    db.publishAttempt.findMany({
      where: { publishJobId: jobId },
      orderBy: { attemptNumber: 'asc' },
      select: {
        attemptNumber: true,
        outcome: true,
        failureClass: true,
        providerHandle: true,
        safeSummary: true,
      },
    }),
  );

let originalVariant: {
  assetIds: string[];
  linkUrl: string | null;
  platformOptions: unknown;
};

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
  await inA((db) =>
    db.contentItem.update({
      where: { id: fixtures.a.contentItemId },
      data: { status: 'SCHEDULED' },
    }),
  );
  originalVariant = await inA((db) =>
    db.contentVariant.findFirstOrThrow({
      where: { id: fixtures.a.contentVariantId },
      select: { assetIds: true, linkUrl: true, platformOptions: true },
    }),
  );
}, 60_000);

afterEach(async () => {
  await inA(async (db) => {
    await db.contentVariant.update({
      where: { id: fixtures.a.contentVariantId },
      data: {
        assetIds: originalVariant.assetIds,
        linkUrl: originalVariant.linkUrl,
        platformOptions: (originalVariant.platformOptions ?? undefined) as never,
      },
    });
    await db.socialConnection.update({
      where: { id: fixtures.a.socialConnectionId },
      data: { status: 'ACTIVE', lastFailureClass: null, consecutiveFailureCount: 0 },
    });
  });
});

afterAll(async () => {
  await closeQueues();
  await app?.$disconnect();
});

describe('W2 — the post kind, link and options travel with the request', () => {
  it('a text post is sent as `text`, with the variant’s link and options', async () => {
    await inA((db) =>
      db.contentVariant.update({
        where: { id: fixtures.a.contentVariantId },
        data: { linkUrl: 'https://example.test/launch', platformOptions: { privacy: 'SELF_ONLY' } },
      }),
    );
    const policy = policyWith();
    const provider = recordingRegistry(policy);
    const jobId = await seedJob('kind');

    const result = await executePublishJob(transactions({ policy, ...provider }), jobId);

    expect(result.status).toBe('PUBLISHED');
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toMatchObject({
      postKind: 'text',
      linkUrl: 'https://example.test/launch',
      options: { privacy: 'SELF_ONLY' },
    });
  });

  it('A KIND THE PROVIDER DOES NOT DECLARE IS REFUSED BEFORE ANY CALL', async () => {
    const policy = policyWith({ postKinds: ['image'] });
    const provider = recordingRegistry(policy);
    const jobId = await seedJob('undeclared');

    const result = await executePublishJob(transactions({ policy, ...provider }), jobId);
    const job = await readJob(jobId);

    expect({ status: result.status, class: job.failureClass, code: job.failureCode }).toEqual({
      status: 'FAILED',
      class: 'UNSUPPORTED',
      code: 'preflight.post_kind_unsupported',
    });
    expect(provider.requests).toHaveLength(0);
    expect((await attemptsOf(jobId)).map((attempt) => attempt.outcome)).toEqual([
      'PREFLIGHT_REFUSED',
    ]);
  });
});

describe('W3 and O1 — media is checked, and fetched by URL only where configured', () => {
  const asset = randomUUID();
  const picture = {
    assetId: asset,
    fileName: 'picture.png',
    mimeType: 'image/png',
    sizeBytes: 1_024,
    width: 1_080,
    height: 1_080,
    durationMs: null,
    bytes: new Uint8Array([1, 2, 3]),
  };

  async function attachPicture() {
    await inA((db) =>
      db.contentVariant.update({
        where: { id: fixtures.a.contentVariantId },
        data: { assetIds: [asset] },
      }),
    );
  }

  it('a file that breaks the configured rule is refused, with the rule’s name', async () => {
    await attachPicture();
    const policy = policyWith({ mediaRules: { image: { mimeTypes: ['image/jpeg'] } } });
    const provider = recordingRegistry(policy);
    const jobId = await seedJob('rule');
    const media: PublishMediaPort = { resolve: async () => [picture] };

    await executePublishJob(transactions({ policy, ...provider, media }), jobId);
    const job = await readJob(jobId);

    expect({ status: job.status, class: job.failureClass, code: job.failureCode }).toEqual({
      status: 'FAILED',
      class: 'MEDIA_INVALID',
      code: 'preflight.media_rule.mime_type',
    });
    expect(provider.requests).toHaveLength(0);
  });

  it('a platform that fetches by URL, with no URL minted, gets nothing at all', async () => {
    await attachPicture();
    const policy = policyWith({ mediaByUrl: true });
    const provider = recordingRegistry(policy);
    const jobId = await seedJob('no-url');
    const media: PublishMediaPort = { resolve: async () => [picture] };

    await executePublishJob(transactions({ policy, ...provider, media }), jobId);
    const job = await readJob(jobId);

    expect({ status: job.status, code: job.failureCode }).toEqual({
      status: 'FAILED',
      code: 'preflight.media_url_unavailable',
    });
    expect(provider.requests).toHaveLength(0);
  });

  it('the pipeline asks for a URL with the configured lifetime, and the adapter receives it', async () => {
    await attachPicture();
    const policy = policyWith({ mediaByUrl: true }, { media: { fetchUrlTtlSeconds: 600 } });
    const provider = recordingRegistry(policy);
    const jobId = await seedJob('url');
    const asked: (number | undefined)[] = [];
    const media: PublishMediaPort = {
      resolve: async (input) => {
        asked.push(input.fetchUrlTtlSeconds);
        return [{ ...picture, fetchUrl: 'https://media.example.test/signed?x=1' }];
      },
    };

    const result = await executePublishJob(transactions({ policy, ...provider, media }), jobId);

    expect(result.status).toBe('PUBLISHED');
    expect(asked).toEqual([600]);
    expect(provider.requests[0]?.postKind).toBe('image');
    expect(provider.requests[0]?.media[0]?.fetchUrl).toBe('https://media.example.test/signed?x=1');
  });

  it('a platform that takes bytes is never handed a URL — none is even asked for', async () => {
    await attachPicture();
    const policy = policyWith();
    const provider = recordingRegistry(policy);
    const jobId = await seedJob('bytes');
    const asked: (number | undefined)[] = [];
    const media: PublishMediaPort = {
      resolve: async (input) => {
        asked.push(input.fetchUrlTtlSeconds);
        return [picture];
      },
    };

    await executePublishJob(transactions({ policy, ...provider, media }), jobId);

    expect(asked).toEqual([undefined]);
    expect(provider.requests[0]?.media[0]?.fetchUrl).toBeUndefined();
  });
});

describe('W5 — a publish the platform accepted and has not finished', () => {
  it('waits with its handle, is asked again, and is PUBLISHED — sent once', async () => {
    const policy = policyWith();
    const provider = recordingRegistry(policy);
    const jobId = await seedJob('async-done');
    const run = transactions({ policy, ...provider });

    const first = await executePublishJob(run, jobId);
    const waiting = await readJob(jobId);
    expect(first.status).toBe('VERIFICATION_PENDING');
    expect(waiting.providerHandle).toMatch(/^done\./);
    expect(waiting.failureCode).toBe('adapter.publish_in_progress');
    expect(waiting.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await attemptsOf(jobId)).toMatchObject([
      { attemptNumber: 1, outcome: 'INDETERMINATE', providerHandle: waiting.providerHandle },
    ]);

    // The poll is the verify message: it can only ask.
    const polled = await recoverStalePublishJob(run, jobId);
    const redelivered = await executePublishJob(run, jobId);

    expect(polled.status).toBe('PUBLISHED');
    expect(redelivered.status).toBe('PUBLISHED');
    expect(provider.requests).toHaveLength(1);
  });

  it('still working: asked again later, then left for a person after the polling window', async () => {
    const policy = policyWith({}, { dispatch: { publishPollMaxMinutes: 30 } });
    const provider = recordingRegistry(policy);
    const jobId = await seedJob('async-wait');

    await executePublishJob(transactions({ policy, ...provider }), jobId);
    const before = (await readJob(jobId)).nextAttemptAt!;
    await recoverStalePublishJob(transactions({ policy, ...provider }), jobId);
    const again = await readJob(jobId);
    expect(again.status).toBe('VERIFICATION_PENDING');
    expect(again.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());

    const anHourLater: Clock = { now: () => new Date(Date.now() + 60 * 60_000) };
    await recoverStalePublishJob(transactions({ policy, ...provider, clock: anHourLater }), jobId);
    const given = await readJob(jobId);

    expect({ status: given.status, next: given.nextAttemptAt }).toEqual({
      status: 'VERIFICATION_PENDING',
      next: null,
    });
    expect(provider.requests).toHaveLength(1);
  });

  it('finished and FAILED on the platform: a determinate failure, nothing resent', async () => {
    const policy = policyWith();
    const provider = recordingRegistry(policy);
    const jobId = await seedJob('async-fail');
    const run = transactions({ policy, ...provider });

    await executePublishJob(run, jobId);
    const result = await recoverStalePublishJob(run, jobId);
    const job = await readJob(jobId);

    expect({ status: result.status, class: job.failureClass, code: job.failureCode }).toEqual({
      status: 'FAILED',
      class: 'MEDIA_INVALID',
      code: 'mock.async_media_invalid',
    });
    expect(provider.requests).toHaveLength(1);
  });

  it('the maintenance sweep sends the poll when it is due, as a verify message', async () => {
    const due = new Date(Date.UTC(2001, 0, 10, 8, 59));
    const key = `conn-a-poll-${randomUUID()}`;
    const jobId = await seedJob('poll', {
      idempotencyKey: key,
      status: 'VERIFICATION_PENDING',
      providerHandle: `wait.${randomUUID()}`,
      failureClass: 'TIMEOUT',
      failureCode: 'adapter.publish_in_progress',
      nextAttemptAt: due,
    });

    const swept = await new MaintenanceScheduler({
      environment: 'DEVELOPMENT',
      clock: { now: () => new Date(Date.UTC(2001, 0, 10, 9, 0)) },
      socialApplications: {
        resolve: async () => ({
          appId: 'fixture-app',
          clientSecret: 'fixture-secret',
          redirectUri: 'https://example.test/callback',
        }),
      },
      publishingPolicy: policyWith(),
    }).sweepPublishing(500);

    expect(swept.polled).toBeGreaterThanOrEqual(1);
    const message = await queueFor('publish-jobs').getJob(
      verifySocialPostJobKey(`poll-${key}`, due),
    );
    expect(message?.data).toMatchObject({ publishJobId: jobId });
  });
});

describe('R8 — the published post is compared with the preview', () => {
  it('a different copy is still PUBLISHED, and the difference is recorded by field name', async () => {
    const policy = policyWith();
    const provider = recordingRegistry(policy);
    const jobId = await seedJob('observe-mismatch');

    const result = await executePublishJob(transactions({ policy, ...provider }), jobId);
    const [attempt] = await attemptsOf(jobId);
    const audit = await inA((db) =>
      db.auditEvent.findMany({
        where: { action: 'social.post.result_mismatch', resourceId: jobId },
        select: { after: true },
      }),
    );

    expect(result.status).toBe('PUBLISHED');
    expect(attempt?.outcome).toBe('SUCCEEDED');
    expect(attempt?.safeSummary).toContain('caption');
    expect(audit).toHaveLength(1);
    expect(audit[0]?.after).toMatchObject({ differs: ['caption'] });
  });

  it('a matching copy records nothing extra', async () => {
    const policy = policyWith();
    const provider = recordingRegistry(policy);
    const jobId = await seedJob('observe-match');

    await executePublishJob(transactions({ policy, ...provider }), jobId);
    const [attempt] = await attemptsOf(jobId);

    expect(attempt?.safeSummary).toBeNull();
  });
});

describe('W12 — publishing spends from the request budget', () => {
  it('an empty budget holds the job without an attempt, and the provider is not called', async () => {
    const policy = policyWith({ rateLimit: { requestsPerWindow: 1, windowSeconds: 3_600 } });
    const provider = recordingRegistry(policy);
    const rateLimiter = new ProviderRateLimiter({ clock: systemClock });
    const run = transactions({ policy, ...provider, rateLimiter });
    const first = await seedJob('budget-1');
    const second = await seedJob('budget-2');

    expect((await executePublishJob(run, first)).status).toBe('PUBLISHED');
    const held = await executePublishJob(run, second);
    const job = await readJob(second);

    expect({
      status: held.status,
      class: job.failureClass,
      code: job.failureCode,
      attemptCount: job.attemptCount,
      claimedAt: job.claimedAt,
    }).toEqual({
      status: 'QUEUED',
      class: 'RATE_LIMITED',
      code: 'preflight.awaiting_budget',
      attemptCount: 0,
      claimedAt: null,
    });
    expect(job.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await attemptsOf(second)).toEqual([]);
    expect(provider.requests).toHaveLength(1);
  });

  it('the budget is per account and per workspace: another workspace is not held', () => {
    const limiter = new ProviderRateLimiter({ clock: systemClock });
    const budget = { requestsPerWindow: 1, windowSeconds: 3_600, analyticsReserveMilli: 0 };
    const take = (workspaceId: string) =>
      limiter.reserve({
        key: ProviderRateLimiter.keyFor(workspaceId, 'LINKEDIN', 'acct-1'),
        budget,
        priority: 'publishing',
      }).allowed;
    expect(take(fixtures.a.workspaceId)).toBe(true);
    expect(take(fixtures.a.workspaceId)).toBe(false);
    expect(take(fixtures.b.workspaceId)).toBe(true);
  });
});

describe('R3 — the owner is told when the account needs reconnecting, once', () => {
  it('a revoked authorization turns the account, audits it and notifies its owner once', async () => {
    const policy = policyWith();
    const provider = recordingRegistry(policy);
    const told: string[] = [];
    const notifier = (db: TenantScopedClient): PublishNotifier => {
      const real = connectionReauthNotifier({ db, workspaceId: fixtures.a.workspaceId });
      return {
        published: async () => undefined,
        failed: async () => undefined,
        connectionNeedsReauth: async (event) => {
          told.push(event.connectionId);
          await real.connectionNeedsReauth(event);
        },
      };
    };
    const run: PipelineTransactions = {
      run: (step) =>
        withWorkspace(
          fixtures.a.workspaceId,
          async (db) =>
            step(
              new PublishPipelineService({
                db,
                workspaceId: fixtures.a.workspaceId,
                policy,
                registry: provider.registry,
                vault,
                approvals,
                notifier: notifier(db),
              }),
            ),
          { prisma: app },
        ),
    };

    await executePublishJob(run, await seedJob('auth-revoked'));
    // The account now waits for reconnection; a second post is held, not sent,
    // and the owner is not told twice.
    await executePublishJob(run, await seedJob('auth-revoked-again'));

    const connection = await inA((db) =>
      db.socialConnection.findFirstOrThrow({ where: { id: fixtures.a.socialConnectionId } }),
    );
    const audits = await inA((db) =>
      db.auditEvent.count({
        where: {
          action: 'social.connection.needs_reauth',
          resourceId: fixtures.a.socialConnectionId,
        },
      }),
    );
    const notices = await inA((db) =>
      db.notification.count({
        where: {
          templateKey: 'publishing.connection_needs_reauth',
          resourceId: fixtures.a.socialConnectionId,
        },
      }),
    );

    expect(connection.status).toBe('NEEDS_REAUTH');
    expect(told).toEqual([fixtures.a.socialConnectionId]);
    expect(audits).toBe(1);
    expect(notices).toBe(1);
    expect(provider.requests).toHaveLength(1);
  });
});
