import crypto from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AiGateway } from '@brandspace/ai-gateway';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import {
  ContentLibraryService,
  ContentStudioService,
  ContentTemplateService,
  type ContentPolicy,
  type TemplateActor,
  type TemplateFields,
} from '@brandspace/content';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * POST TEMPLATES (prototype v90 E4 / B2, Phase 2B-2) AGAINST REAL POSTGRESQL.
 *
 * `ContentTemplate` is tenant-owned: RLS keeps every row inside its workspace,
 * the service adds the member's BrandScope, and a template is applied only to a
 * post of its own brand. Managing needs `templates.manage`; applying never
 * changes the author; an AI generation takes only the non-prompt fields.
 */

const CONTENT_POLICY: ContentPolicy = {
  dialects: {
    defaultKey: 'msa',
    supported: [{ key: 'msa', labelKey: 'content.dialect.msa', bcp47: 'ar' }],
  },
  platforms: [
    {
      key: 'instagram',
      labelKey: 'content.platform.instagram',
      maxBodyChars: 2_200,
      maxHashtags: 5,
      allowsFirstComment: true,
      maxMediaItems: 10,
    },
    {
      key: 'x',
      labelKey: 'content.platform.x',
      maxBodyChars: 280,
      maxHashtags: 2,
      allowsFirstComment: false,
      maxMediaItems: 4,
    },
  ],
  generation: {
    maxVariantsPerRequest: 4,
    maxDraftsPerBrand: 500,
    maxContextItems: 12,
    maxContextChunks: 8,
    maxContextChars: 12_000,
    maxBriefChars: 2_000,
  },
  retention: { cancellationGraceDays: 30, minCustomerRetentionDays: 7 },
  calendar: {
    weekStartsOn: 0,
    maxDaysAhead: 365,
    minLeadMinutes: 5,
    maxSlotsPerDay: 25,
    requireApprovalBeforeScheduling: false,
  },
  learning: {
    preferenceMinObservations: 4,
    preferenceMinPosts: 3,
    workflowMinRepeats: 4,
    windowDays: 90,
    snoozeDays: 30,
  },
  approvals: {
    requireApprovalBeforeScheduling: false,
    allowSelfApproval: false,
    clientApprovalEnabled: false,
    maxNoteLength: 400,
    maxCyclesPerItem: 5,
  },
};

let fixtures: IsolationFixtures;
let app: PrismaClient;
let platform: PrismaClient;
/** A second brand in workspace A, outside a scoped member's reach. */
let otherBrandId: string;

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  const brand = await platform.brand.create({
    data: {
      workspaceId: fixtures.a.workspaceId,
      name: `Templates other ${crypto.randomUUID().slice(0, 6)}`,
      slug: `tpl-other-${crypto.randomUUID().slice(0, 8)}`,
    },
    select: { id: true },
  });
  otherBrandId = brand.id;
  // The studio grounds on Brand Brain: give the fixture brand's approved item
  // enough text to retrieve, as the content-studio suite does.
  await withWorkspace(
    fixtures.a.workspaceId,
    (db) =>
      db.brandKnowledgeItem.updateMany({
        where: { brandId: fixtures.a.brandId },
        data: {
          body: {
            en: 'We serve independent retailers with a spring collection built for real life.',
            ar: 'نخدم تجار التجزئة المستقلين بمجموعة ربيعية مصممة للحياة اليومية.',
          },
        },
      }),
    { prisma: app },
  );
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

function inWs<T>(workspaceId: string, fn: (db: TenantScopedClient) => Promise<T>): Promise<T> {
  return withWorkspace(workspaceId, fn, { prisma: app });
}

function templatesIn(db: TenantScopedClient, workspaceId: string): ContentTemplateService {
  return new ContentTemplateService({ db, workspaceId, policy: CONTENT_POLICY });
}

const manager = (userId: string, brandScope: readonly string[] = []): TemplateActor => ({
  userId,
  brandScope,
  permissionKeys: ['content.create', 'templates.manage'],
});

function fields(overrides: Partial<TemplateFields> = {}): TemplateFields {
  return {
    name: `Launch ${crypto.randomUUID().slice(0, 6)}`,
    contentType: 'CAROUSEL',
    platformKeys: ['instagram', 'x'],
    body: 'New this week: {product}.',
    hashtags: ['#launch', 'new', 'Launch', 'week', 'drop', 'extra', 'more'],
    firstComment: 'Link in bio.',
    ...overrides,
  };
}

async function makeTemplate(input: { isDefault?: boolean; brandId?: string } = {}) {
  return inWs(fixtures.a.workspaceId, (db) =>
    templatesIn(db, fixtures.a.workspaceId).create({
      brandId: input.brandId ?? fixtures.a.brandId,
      fields: fields(),
      ...(input.isDefault ? { isDefault: true } : {}),
      actor: manager(fixtures.a.userId),
    }),
  );
}

describe('ContentTemplate — tenancy', () => {
  it('a cross-tenant read returns nothing and the listing excludes the other tenant', async () => {
    const template = await makeTemplate();
    const fromB = await inWs(fixtures.b.workspaceId, (db) =>
      db.contentTemplate.findFirst({ where: { id: template.id } }),
    );
    expect(fromB).toBeNull();
    const listedInB = await inWs(fixtures.b.workspaceId, (db) =>
      db.contentTemplate.findMany({ where: {} }),
    );
    expect(listedInB.map((row) => row.id)).not.toContain(template.id);
    // Through the service too: NOT_FOUND, shaped like a genuine miss.
    await expect(
      inWs(fixtures.b.workspaceId, (db) =>
        templatesIn(db, fixtures.b.workspaceId).get({ templateId: template.id, brandScope: [] }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a cross-tenant write is refused', async () => {
    const template = await makeTemplate();
    const updated = await inWs(fixtures.b.workspaceId, (db) =>
      db.contentTemplate.updateMany({ where: { id: template.id }, data: { name: 'Hijacked' } }),
    );
    expect(updated.count).toBe(0);
    await expect(
      inWs(fixtures.b.workspaceId, (db) =>
        db.contentTemplate.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            name: 'Planted',
          },
        }),
      ),
    ).rejects.toThrow();
    const after = await platform.contentTemplate.findUniqueOrThrow({ where: { id: template.id } });
    expect(after.name).toBe(template.name);
  });

  it('a template cannot name a brand of another workspace (composite foreign key)', async () => {
    await expect(
      platform.contentTemplate.create({
        data: { workspaceId: fixtures.a.workspaceId, brandId: fixtures.b.brandId, name: 'Crossed' },
      }),
    ).rejects.toThrow();
  });
});

describe('ContentTemplate — brand scope and permission', () => {
  it('a member scoped to another brand cannot see, apply or change it', async () => {
    const template = await makeTemplate();
    const scoped = [otherBrandId];
    await expect(
      inWs(fixtures.a.workspaceId, (db) =>
        templatesIn(db, fixtures.a.workspaceId).get({
          templateId: template.id,
          brandScope: scoped,
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const listed = await inWs(fixtures.a.workspaceId, (db) =>
      templatesIn(db, fixtures.a.workspaceId).list({
        brandId: fixtures.a.brandId,
        brandScope: scoped,
      }),
    );
    expect(listed).toEqual([]);
    await expect(
      inWs(fixtures.a.workspaceId, (db) =>
        templatesIn(db, fixtures.a.workspaceId).update({
          templateId: template.id,
          fields: fields(),
          actor: manager(fixtures.a.userId, scoped),
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('saving, changing, deleting and choosing the default need templates.manage', async () => {
    const template = await makeTemplate();
    const creator: TemplateActor = {
      userId: fixtures.a.userId,
      brandScope: [],
      permissionKeys: ['content.create', 'content.edit'],
    };
    const service = (db: TenantScopedClient) => templatesIn(db, fixtures.a.workspaceId);
    const attempts: ((db: TenantScopedClient) => Promise<unknown>)[] = [
      (db: TenantScopedClient) =>
        service(db).create({ brandId: fixtures.a.brandId, fields: fields(), actor: creator }),
      (db: TenantScopedClient) =>
        service(db).update({ templateId: template.id, fields: fields(), actor: creator }),
      (db: TenantScopedClient) => service(db).remove({ templateId: template.id, actor: creator }),
      (db: TenantScopedClient) =>
        service(db).setDefault({
          brandId: fixtures.a.brandId,
          templateId: template.id,
          actor: creator,
        }),
    ];
    for (const attempt of attempts) {
      await expect(inWs(fixtures.a.workspaceId, attempt)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    }
  });
});

describe('ContentTemplate — the rules of one brand', () => {
  it('keeps one default per brand: choosing another clears the first, and it is audited', async () => {
    const first = await makeTemplate({ isDefault: true });
    const second = await makeTemplate();
    await inWs(fixtures.a.workspaceId, (db) =>
      templatesIn(db, fixtures.a.workspaceId).setDefault({
        brandId: fixtures.a.brandId,
        templateId: second.id,
        actor: manager(fixtures.a.userId),
      }),
    );
    const defaults = await platform.contentTemplate.findMany({
      where: { brandId: fixtures.a.brandId, isDefault: true, deletedAt: null },
      select: { id: true },
    });
    expect(defaults).toEqual([{ id: second.id }]);
    expect(first.id).not.toBe(second.id);
    const audit = await platform.auditEvent.findFirst({
      where: {
        workspaceId: fixtures.a.workspaceId,
        action: 'content.template.default_changed',
        resourceId: second.id,
      },
    });
    expect(audit).not.toBeNull();
  });

  it('refuses a second live template with the same name, case-insensitively', async () => {
    const name = `Weekly ${crypto.randomUUID().slice(0, 6)}`;
    await inWs(fixtures.a.workspaceId, (db) =>
      templatesIn(db, fixtures.a.workspaceId).create({
        brandId: fixtures.a.brandId,
        fields: fields({ name }),
        actor: manager(fixtures.a.userId),
      }),
    );
    await expect(
      inWs(fixtures.a.workspaceId, (db) =>
        templatesIn(db, fixtures.a.workspaceId).create({
          brandId: fixtures.a.brandId,
          fields: fields({ name: name.toUpperCase() }),
          actor: manager(fixtures.a.userId),
        }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('normalises hashtags and refuses a channel the policy does not offer', async () => {
    const template = await makeTemplate();
    expect(template.hashtags).toEqual(['launch', 'new', 'week', 'drop', 'extra', 'more']);
    await expect(
      inWs(fixtures.a.workspaceId, (db) =>
        templatesIn(db, fixtures.a.workspaceId).create({
          brandId: fixtures.a.brandId,
          fields: fields({ platformKeys: ['myspace'] }),
          actor: manager(fixtures.a.userId),
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('deleting is soft, frees the default and writes an audit event', async () => {
    const template = await makeTemplate({ isDefault: true });
    await inWs(fixtures.a.workspaceId, (db) =>
      templatesIn(db, fixtures.a.workspaceId).remove({
        templateId: template.id,
        actor: manager(fixtures.a.userId),
      }),
    );
    const row = await platform.contentTemplate.findUniqueOrThrow({ where: { id: template.id } });
    expect(row.deletedAt).not.toBeNull();
    expect(row.isDefault).toBe(false);
    expect(
      await platform.auditEvent.count({
        where: { action: 'content.template.deleted', resourceId: template.id },
      }),
    ).toBe(1);
  });
});

describe('applying a template', () => {
  it('fills only the blanks of a hand-written post and keeps its author', async () => {
    const template = await makeTemplate();
    const created = await inWs(fixtures.a.workspaceId, (db) =>
      new ContentLibraryService({
        db,
        workspaceId: fixtures.a.workspaceId,
        policy: CONTENT_POLICY,
      }).createManualItem({
        brandId: fixtures.a.brandId,
        title: 'From a template',
        locale: 'EN',
        variants: [
          { platformKey: 'instagram', body: '' },
          { platformKey: 'x', body: 'My own words.', hashtags: ['mine'] },
        ],
        templateId: template.id,
        actorUserId: fixtures.a.userId,
        actorBrandScope: [],
        expiresAt: null,
        idempotencyKey: `tpl-${crypto.randomUUID()}`,
      }),
    );
    expect(created.item.contentType).toBe('CAROUSEL');
    expect(created.item.createdByUserId).toBe(fixtures.a.userId);
    const byPlatform = Object.fromEntries(created.variants.map((v) => [v.platformKey, v]));
    // Blank caption and hashtags: the template's, bounded by the channel.
    expect(byPlatform['instagram']).toMatchObject({
      body: 'New this week: {product}.',
      hashtags: ['launch', 'new', 'week', 'drop', 'extra'],
      firstComment: 'Link in bio.',
    });
    // What the person wrote wins; X takes no first comment.
    expect(byPlatform['x']).toMatchObject({
      body: 'My own words.',
      hashtags: ['mine'],
      firstComment: null,
    });
    const audit = await platform.auditEvent.findFirstOrThrow({
      where: { action: 'content.item.authored', resourceId: created.item.id },
    });
    expect(audit.after).toMatchObject({ templateId: template.id });
  });

  it('never applies a template of another brand', async () => {
    const other = await makeTemplate({ brandId: otherBrandId });
    await expect(
      inWs(fixtures.a.workspaceId, (db) =>
        new ContentLibraryService({
          db,
          workspaceId: fixtures.a.workspaceId,
          policy: CONTENT_POLICY,
        }).createManualItem({
          brandId: fixtures.a.brandId,
          title: 'Wrong brand',
          locale: 'EN',
          variants: [{ platformKey: 'instagram', body: 'Hello' }],
          templateId: other.id,
          actorUserId: fixtures.a.userId,
          actorBrandScope: [],
          expiresAt: null,
          idempotencyKey: `tpl-${crypto.randomUUID()}`,
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('gives an AI generation only the non-prompt fields: the caption skeleton never reaches the prompt', async () => {
    const template = await makeTemplate();
    const prompts: string[] = [];
    const gateway = {
      execute: async (request: { input: { prompt: string; untrustedContext?: string[] } }) => {
        prompts.push([request.input.prompt, ...(request.input.untrustedContext ?? [])].join('\n'));
        return {
          status: 'SUCCEEDED',
          requestId: fixtures.a.aiRequestId,
          creditsChargedMilli: 0n,
          replayed: false,
          failureMessage: null,
          output: {
            kind: 'text',
            text: JSON.stringify({
              title: 'Generated',
              variants: [
                { platformKey: 'instagram', body: 'Written by the model.', hashtags: ['ai'] },
              ],
            }),
          },
        };
      },
    } as unknown as AiGateway;

    const result = await inWs(fixtures.a.workspaceId, (db) =>
      new ContentStudioService({
        db,
        workspaceId: fixtures.a.workspaceId,
        policy: CONTENT_POLICY,
        gateway,
      }).generate({
        brandId: fixtures.a.brandId,
        brief: 'Announce the spring collection to independent retailers.',
        locale: 'EN',
        platformKeys: ['instagram'],
        idempotencyKey: `tpl-gen-${crypto.randomUUID()}`,
        actorUserId: fixtures.a.userId,
        planKey: null,
        actorBrandScope: [],
        retention: { subscriptionActive: true },
        templateId: template.id,
      }),
    );

    // The fixture brand has approved knowledge, so this reached the (fake) model.
    expect(result.insufficientKnowledge).toBe(false);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain('New this week');
    expect(result.variants[0]).toMatchObject({
      body: 'Written by the model.',
      hashtags: ['launch', 'new', 'week', 'drop', 'extra'],
      firstComment: 'Link in bio.',
    });
    expect(result.item.contentType).toBe('CAROUSEL');
    expect(result.item.createdByUserId).toBe(fixtures.a.userId);
  });
});
