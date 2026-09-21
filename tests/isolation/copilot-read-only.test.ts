import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { defaultPayload } from '@brandspace/config';
import {
  COPILOT_TOOLS,
  TOOL_EXECUTORS,
  highestActionClass,
  requiresConfirmation,
} from '@brandspace/copilot';
import {
  AnalyticsQueryService,
  createAnalyticsRegistry,
  parseAnalyticsPolicy,
} from '@brandspace/analytics';
import { CampaignService, ContentCalendarService, parseContentPolicy } from '@brandspace/content';
import { systemClock } from '@brandspace/shared';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * A READ_ONLY COPILOT TOOL IS READ-ONLY IN FACT, NOT ONLY IN ITS TABLE ROW.
 *
 * WHY THIS IS WORTH A SUITE OF ITS OWN. `requiresConfirmation` returns false
 * for exactly one class, so a READ_ONLY plan runs with NO human confirmation at
 * all. The entire confirmation contract therefore rests on one claim: that the
 * tools declared READ_ONLY in `tools.ts` do not write. Nothing checked that.
 * The declaration and the executor live in different files, a future tool is
 * added by editing both, and the failure mode of getting it wrong is silent —
 * a plan that changes a customer's data without ever asking them.
 *
 * SO THE CLAIM IS MEASURED RATHER THAN READ. Every READ_ONLY executor is run
 * against a client whose every write method throws, so a write is a test
 * failure with the method named rather than a row nobody notices. This is a
 * GUARD: it passes today, and it is here so that it stops passing the moment
 * somebody classifies a writing tool as read-only.
 */

const WRITE_METHODS = [
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
] as const;

let app: PrismaClient;
let fixtures: IsolationFixtures;

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
});

/**
 * A tenant client that refuses to write.
 *
 * A PROXY RATHER THAN A STUB, so every model and every method still behaves
 * exactly as it does in production right up to the moment a write is attempted.
 * A hand-written fake would prove that the fake does not write.
 */
function readOnlyClient(db: TenantScopedClient): TenantScopedClient {
  const attempted: string[] = [];
  const wrapped = new Proxy(db as unknown as Record<string, unknown>, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof property !== 'string' || typeof value !== 'object' || value === null) {
        if (typeof property === 'string' && /^\$(execute|queryRaw)/.test(property)) {
          return (...args: unknown[]) => {
            // Raw SQL is not necessarily a write, but a READ_ONLY tool has no
            // business reaching for it: it is the one path this proxy cannot
            // classify, so it is refused rather than guessed at.
            attempted.push(property);
            throw new Error(`read-only tool reached for ${property}(${args.length} args)`);
          };
        }
        return value;
      }
      return new Proxy(value as Record<string, unknown>, {
        get(model, method) {
          if (typeof method === 'string' && (WRITE_METHODS as readonly string[]).includes(method)) {
            return (...args: unknown[]) => {
              attempted.push(`${String(property)}.${method}`);
              throw new Error(
                `read-only tool attempted ${String(property)}.${method}(${args.length} args)`,
              );
            };
          }
          const bound = Reflect.get(model, method);
          return typeof bound === 'function' ? bound.bind(model) : bound;
        },
      });
    },
  });
  return wrapped as unknown as TenantScopedClient;
}

const READ_ONLY_KEYS = COPILOT_TOOLS.filter((tool) => tool.actionClass === 'READ_ONLY').map(
  (tool) => tool.key,
);

describe('the confirmation contract rests on READ_ONLY meaning read-only', () => {
  it('there ARE read-only tools, so the rest of this suite is not vacuous', () => {
    expect(READ_ONLY_KEYS.length).toBeGreaterThan(0);
    // And every one of them has an executor to run.
    for (const key of READ_ONLY_KEYS) expect(TOOL_EXECUTORS[key]).toBeTypeOf('function');
  });

  it('A READ_ONLY PLAN RUNS WITH NO CONFIRMATION — which is what makes this matter', () => {
    expect(requiresConfirmation(highestActionClass(READ_ONLY_KEYS))).toBe(false);
    // Anything else in the plan lifts the whole plan out of that exemption.
    expect(requiresConfirmation(highestActionClass([...READ_ONLY_KEYS, 'campaign.create']))).toBe(
      true,
    );
  });

  it('AN UNKNOWN TOOL IS NOT READ-ONLY, so a mistake fails closed', () => {
    expect(highestActionClass(['a.tool.that.does.not.exist'])).toBe('EXTERNAL_OR_DESTRUCTIVE');
  });

  it.each(READ_ONLY_KEYS)('%s WRITES NOTHING, measured against a refusing client', async (key) => {
    const executor = TOOL_EXECUTORS[key];
    if (!executor) throw new Error(`no executor for ${key}`);

    await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => {
        const guarded = readOnlyClient(db as TenantScopedClient);
        const analyticsPolicy = parseAnalyticsPolicy(defaultPayload('analytics'));
        const contentPolicy = parseContentPolicy(defaultPayload('content'));

        const context = {
          db: guarded,
          workspaceId: fixtures.a.workspaceId,
          authorization: {
            userId: fixtures.a.userId,
            permissionKeys: ['copilot.use', 'content.read', 'analytics.read', 'campaigns.read'],
            brandScope: [] as string[],
          },
          planKey: null,
          clock: systemClock,
          correlationId: randomUUID(),
          idempotencyKey: randomUUID(),
          analytics: new AnalyticsQueryService({
            db: guarded,
            workspaceId: fixtures.a.workspaceId,
            policy: analyticsPolicy,
            registry: createAnalyticsRegistry({ environment: 'DEVELOPMENT' }),
          }),
          campaigns: new CampaignService({ db: guarded, workspaceId: fixtures.a.workspaceId }),
          calendar: new ContentCalendarService({
            db: guarded,
            workspaceId: fixtures.a.workspaceId,
            policy: contentPolicy,
            timezone: 'UTC',
            // A quota that would refuse everything. A READ_ONLY tool must never
            // reach it, so making it hostile costs nothing and would surface a
            // tool that tried to schedule.
            quota: {
              limit: async () => 0,
              consume: async () => {
                throw new Error('read-only tool attempted to consume schedule quota');
              },
              refund: async () => {
                throw new Error('read-only tool attempted to refund schedule quota');
              },
            },
          }),
          retention: { subscriptionActive: true },
        };

        /*
         * THE ARGUMENTS ARE PLAUSIBLE BUT THE OUTCOME IS NOT THE POINT. A tool
         * may legitimately refuse these — a missing row, a validation error —
         * and that is fine. What must never happen is a WRITE, and the proxy
         * turns one into a named failure rather than a silent row.
         */
        const args = {
          brandId: fixtures.a.brandId,
          question: 'What is our positioning?',
          query: 'launch',
          limit: 5,
          days: 7,
          periodDays: 7,
        };

        try {
          await executor(context as never, args);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          // A refusal is acceptable; an attempted WRITE is not, and the proxy
          // names it so the failure says which method and which model.
          expect(message).not.toMatch(/read-only tool (attempted|reached)/);
        }
      },
      { prisma: app },
    );
  });
});
