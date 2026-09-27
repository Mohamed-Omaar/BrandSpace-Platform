import {
  writeAuditEvent,
  type ContentItem,
  type ContentTemplate,
  type TenantScopedClient,
} from '@brandspace/database';
import {
  AppError,
  assertBrandInScope,
  brandIdQueryFilter,
  systemClock,
  type Clock,
} from '@brandspace/shared';
import { unsupportedPlatform } from './errors';
import { findPlatform, type ContentPolicy } from './policy';

/**
 * POST TEMPLATES — prototype v90 E4 / B2 (Phase 2B-2).
 *
 * A template is a brand's reusable starting point for a post: a format, the
 * channels, a caption skeleton, hashtags and a first comment (owner answer D4,
 * and nothing else). One template per brand may be its DEFAULT, which the
 * composer preselects for a new post.
 *
 * WHO MAY DO WHAT. Using a template is prefilling a post, so it needs exactly
 * what creating the post needs (`content.create`, checked by the caller that
 * creates it). Saving, changing, deleting and choosing the default need
 * `templates.manage` — checked HERE as well as at every caller, because a
 * permission that lives only in the screens is a permission the Copilot and
 * the API do not have.
 *
 * HOW IT APPLIES. A hand-written post takes every field (`applyTemplateToDraft`).
 * An AI generation takes only the NON-PROMPT fields — format, channels,
 * hashtags, first comment — and the caption skeleton is never put into a
 * prompt (owner answer D4 (a); `applyTemplateToGeneration`). Applying never
 * changes who wrote the post: the author is always the person creating it.
 *
 * BRAND SCOPE AND TENANCY. Every read names the workspace and the member's
 * BrandScope in the query, beside RLS, and a template outside either is the
 * same NOT_FOUND a genuine miss is (CLAUDE.md §2.1).
 */

export const TEMPLATE_NAME_MAX = 80;
export const TEMPLATE_BODY_MAX = 5000;
export const TEMPLATE_FIRST_COMMENT_MAX = 2200;
export const TEMPLATE_HASHTAGS_MAX = 30;
/** Enough to hold every brand's list on one screen; the list is not paginated. */
export const TEMPLATES_PER_BRAND_MAX = 100;

export const TEMPLATES_MANAGE_PERMISSION = 'templates.manage';

export interface TemplateActor {
  readonly userId: string;
  readonly brandScope: readonly string[];
  readonly permissionKeys: readonly string[];
}

export interface TemplateFields {
  readonly name: string;
  readonly contentType: ContentItem['contentType'];
  readonly platformKeys: readonly string[];
  readonly body: string | null;
  readonly hashtags: readonly string[];
  readonly firstComment: string | null;
}

export function contentTemplateNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Template not found.');
}

export function templateNameTaken(): AppError {
  return new AppError('CONFLICT', 'This brand already has a template with that name.', {
    reason: 'template_name_taken',
  });
}

export function templateVersionConflict(): AppError {
  return new AppError('CONFLICT', 'This template has changed since you last saw it.', {
    reason: 'template_changed',
  });
}

function mayManage(actor: TemplateActor): void {
  if (!actor.permissionKeys.includes(TEMPLATES_MANAGE_PERMISSION)) {
    throw new AppError('FORBIDDEN', 'You do not have permission to manage templates.');
  }
}

/** `#launch`, `launch ` and `LAUNCH` are one tag, stored without the mark. */
export function normaliseHashtags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().replace(/^#+/, '').trim();
    if (!tag || /\s/.test(tag)) continue;
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

export interface ContentTemplateServiceOptions {
  readonly db: TenantScopedClient;
  readonly workspaceId: string;
  /** The activated content policy: a template may name only offered channels. */
  readonly policy: ContentPolicy;
  readonly clock?: Clock;
}

export class ContentTemplateService {
  readonly #db: TenantScopedClient;
  readonly #workspaceId: string;
  readonly #policy: ContentPolicy;
  readonly #clock: Clock;

  constructor(options: ContentTemplateServiceOptions) {
    this.#db = options.db;
    this.#workspaceId = options.workspaceId;
    this.#policy = options.policy;
    this.#clock = options.clock ?? systemClock;
  }

  /** The brand's live templates, the default first, then by name. */
  async list(input: {
    brandId: string;
    brandScope: readonly string[];
  }): Promise<ContentTemplate[]> {
    return this.#db.contentTemplate.findMany({
      where: {
        workspaceId: this.#workspaceId,
        deletedAt: null,
        ...brandIdQueryFilter({ brandId: input.brandId, brandScope: input.brandScope }),
      },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      take: TEMPLATES_PER_BRAND_MAX,
    });
  }

  /** One live template the member may see, or NOT_FOUND. */
  async get(input: {
    templateId: string;
    brandScope: readonly string[];
  }): Promise<ContentTemplate> {
    const template = await this.#db.contentTemplate.findFirst({
      where: {
        id: input.templateId,
        workspaceId: this.#workspaceId,
        deletedAt: null,
        ...brandIdQueryFilter({ brandScope: input.brandScope }),
      },
    });
    if (!template) throw contentTemplateNotFound();
    return template;
  }

  /** The brand's default template, if it has one the member may see. */
  async defaultFor(input: {
    brandId: string;
    brandScope: readonly string[];
  }): Promise<ContentTemplate | null> {
    return this.#db.contentTemplate.findFirst({
      where: {
        workspaceId: this.#workspaceId,
        deletedAt: null,
        isDefault: true,
        ...brandIdQueryFilter({ brandId: input.brandId, brandScope: input.brandScope }),
      },
    });
  }

  /**
   * A template for applying to a post of `brandId`. A template of another
   * brand is NOT_FOUND, never applied across brands.
   */
  async forBrand(input: {
    templateId: string;
    brandId: string;
    brandScope: readonly string[];
  }): Promise<ContentTemplate> {
    const template = await this.get(input);
    if (template.brandId !== input.brandId) throw contentTemplateNotFound();
    return template;
  }

  async create(input: {
    brandId: string;
    fields: TemplateFields;
    isDefault?: boolean;
    actor: TemplateActor;
  }): Promise<ContentTemplate> {
    mayManage(input.actor);
    assertBrandInScope(input.actor.brandScope, input.brandId);
    const brand = await this.#db.brand.findFirst({
      where: { id: input.brandId, workspaceId: this.#workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!brand) throw contentTemplateNotFound();

    const fields = this.#clean(input.fields);
    await this.#assertNameFree(input.brandId, fields.name, null);
    const count = await this.#db.contentTemplate.count({
      where: { workspaceId: this.#workspaceId, brandId: input.brandId, deletedAt: null },
    });
    if (count >= TEMPLATES_PER_BRAND_MAX) {
      throw new AppError('QUOTA_EXCEEDED', 'This brand has as many templates as it can hold.');
    }

    if (input.isDefault) await this.#clearDefault(input.brandId);
    const template = await this.#db.contentTemplate.create({
      data: {
        workspaceId: this.#workspaceId,
        brandId: input.brandId,
        ...fields,
        isDefault: input.isDefault === true,
        createdByUserId: input.actor.userId,
        updatedByUserId: input.actor.userId,
      },
    });

    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'content.template.created',
      actorType: 'USER',
      actorId: input.actor.userId,
      resourceType: 'ContentTemplate',
      resourceId: template.id,
      brandId: template.brandId,
      // Shape, never the words: a caption skeleton is customer content.
      after: this.#shape(template),
    });
    return template;
  }

  async update(input: {
    templateId: string;
    expectedVersion?: number | undefined;
    fields: TemplateFields;
    actor: TemplateActor;
  }): Promise<ContentTemplate> {
    mayManage(input.actor);
    const existing = await this.get({
      templateId: input.templateId,
      brandScope: input.actor.brandScope,
    });
    if (input.expectedVersion !== undefined && existing.version !== input.expectedVersion) {
      throw templateVersionConflict();
    }
    const fields = this.#clean(input.fields);
    await this.#assertNameFree(existing.brandId, fields.name, existing.id);

    // The version in the WHERE, so two editors cannot both win.
    const updated = await this.#db.contentTemplate.updateMany({
      where: { id: existing.id, workspaceId: this.#workspaceId, version: existing.version },
      data: { ...fields, updatedByUserId: input.actor.userId, version: { increment: 1 } },
    });
    if (updated.count === 0) throw templateVersionConflict();
    const after = await this.get({ templateId: existing.id, brandScope: input.actor.brandScope });

    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'content.template.updated',
      actorType: 'USER',
      actorId: input.actor.userId,
      resourceType: 'ContentTemplate',
      resourceId: after.id,
      brandId: after.brandId,
      before: this.#shape(existing),
      after: this.#shape(after),
    });
    return after;
  }

  /** Soft delete. Deleting the default leaves the brand with none. */
  async remove(input: { templateId: string; actor: TemplateActor }): Promise<void> {
    mayManage(input.actor);
    const existing = await this.get({
      templateId: input.templateId,
      brandScope: input.actor.brandScope,
    });
    await this.#db.contentTemplate.updateMany({
      where: { id: existing.id, workspaceId: this.#workspaceId, deletedAt: null },
      data: {
        deletedAt: this.#clock.now(),
        isDefault: false,
        updatedByUserId: input.actor.userId,
        version: { increment: 1 },
      },
    });
    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'content.template.deleted',
      actorType: 'USER',
      actorId: input.actor.userId,
      resourceType: 'ContentTemplate',
      resourceId: existing.id,
      brandId: existing.brandId,
      before: this.#shape(existing),
    });
  }

  /**
   * Make one template the brand's default, or clear the default (`templateId`
   * null). The old default is cleared first, in the same transaction, so the
   * one-default index never sees two.
   */
  async setDefault(input: {
    brandId: string;
    templateId: string | null;
    actor: TemplateActor;
  }): Promise<void> {
    mayManage(input.actor);
    assertBrandInScope(input.actor.brandScope, input.brandId);
    const previous = await this.defaultFor({
      brandId: input.brandId,
      brandScope: input.actor.brandScope,
    });
    let next: ContentTemplate | null = null;
    if (input.templateId) {
      next = await this.forBrand({
        templateId: input.templateId,
        brandId: input.brandId,
        brandScope: input.actor.brandScope,
      });
    }
    if ((previous?.id ?? null) === (next?.id ?? null)) return;

    await this.#clearDefault(input.brandId);
    if (next) {
      await this.#db.contentTemplate.updateMany({
        where: { id: next.id, workspaceId: this.#workspaceId, deletedAt: null },
        data: { isDefault: true, updatedByUserId: input.actor.userId, version: { increment: 1 } },
      });
    }
    // G5: the default-template change is recorded in the Activity log.
    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'content.template.default_changed',
      actorType: 'USER',
      actorId: input.actor.userId,
      resourceType: 'ContentTemplate',
      resourceId: next?.id ?? previous?.id ?? input.brandId,
      brandId: input.brandId,
      before: { templateId: previous?.id ?? null },
      after: { templateId: next?.id ?? null },
    });
  }

  async #clearDefault(brandId: string): Promise<void> {
    await this.#db.contentTemplate.updateMany({
      where: { workspaceId: this.#workspaceId, brandId, isDefault: true, deletedAt: null },
      data: { isDefault: false, version: { increment: 1 } },
    });
  }

  async #assertNameFree(brandId: string, name: string, exceptId: string | null): Promise<void> {
    const clash = await this.#db.contentTemplate.findFirst({
      where: {
        workspaceId: this.#workspaceId,
        brandId,
        deletedAt: null,
        name: { equals: name, mode: 'insensitive' },
        ...(exceptId ? { NOT: { id: exceptId } } : {}),
      },
      select: { id: true },
    });
    if (clash) throw templateNameTaken();
  }

  /** Bounds, channel check and normalisation, before anything is written. */
  #clean(fields: TemplateFields): {
    name: string;
    contentType: ContentItem['contentType'];
    platformKeys: string[];
    body: string | null;
    hashtags: string[];
    firstComment: string | null;
  } {
    const name = fields.name.trim().replace(/\s+/g, ' ');
    if (name.length === 0 || name.length > TEMPLATE_NAME_MAX) {
      throw new AppError('VALIDATION_FAILED', 'A template needs a name of up to 80 characters.', {
        field: 'name',
      });
    }
    const platformKeys = [...new Set(fields.platformKeys)];
    for (const key of platformKeys) {
      if (!findPlatform(this.#policy, key)) throw unsupportedPlatform();
    }
    const body = fields.body?.trim() ? fields.body.trim() : null;
    if (body && body.length > TEMPLATE_BODY_MAX) {
      throw new AppError('VALIDATION_FAILED', 'The caption is too long for a template.', {
        field: 'body',
      });
    }
    const firstComment = fields.firstComment?.trim() ? fields.firstComment.trim() : null;
    if (firstComment && firstComment.length > TEMPLATE_FIRST_COMMENT_MAX) {
      throw new AppError('VALIDATION_FAILED', 'The first comment is too long for a template.', {
        field: 'firstComment',
      });
    }
    const hashtags = normaliseHashtags(fields.hashtags);
    if (hashtags.length > TEMPLATE_HASHTAGS_MAX) {
      throw new AppError('VALIDATION_FAILED', 'A template can hold up to 30 hashtags.', {
        field: 'hashtags',
      });
    }
    return { name, contentType: fields.contentType, platformKeys, body, hashtags, firstComment };
  }

  #shape(template: ContentTemplate) {
    return {
      version: template.version,
      isDefault: template.isDefault,
      contentType: template.contentType,
      channels: template.platformKeys.length,
      hashtags: template.hashtags.length,
      hasBody: template.body !== null,
      hasFirstComment: template.firstComment !== null,
    };
  }
}

/** The fields a template contributes, however it is applied. */
export type TemplateSource = Pick<
  ContentTemplate,
  'id' | 'contentType' | 'platformKeys' | 'body' | 'hashtags' | 'firstComment'
>;

/**
 * A HAND-WRITTEN post takes every field, but never over what the person typed:
 * a variant's own caption, hashtags or first comment win, and only blanks are
 * filled. The format applies when the request named none.
 */
export function applyTemplateToDraft<
  V extends {
    readonly platformKey: string;
    readonly body: string;
    readonly hashtags?: readonly string[] | undefined;
    readonly firstComment?: string | null | undefined;
  },
>(
  template: TemplateSource,
  request: { contentType?: ContentItem['contentType'] | undefined; variants: readonly V[] },
  policy: ContentPolicy,
): { contentType: ContentItem['contentType']; variants: V[] } {
  return {
    contentType: request.contentType ?? template.contentType,
    variants: request.variants.map((variant) => {
      const platform = findPlatform(policy, variant.platformKey);
      const hashtags =
        variant.hashtags && variant.hashtags.length > 0
          ? variant.hashtags
          : template.hashtags.slice(0, platform?.maxHashtags ?? template.hashtags.length);
      const firstComment =
        variant.firstComment ?? (platform?.allowsFirstComment ? template.firstComment : null);
      return {
        ...variant,
        body: variant.body.trim() ? variant.body : (template.body ?? ''),
        hashtags,
        firstComment: firstComment ?? null,
      };
    }),
  };
}

/**
 * An AI GENERATION takes only the non-prompt fields (owner answer D4 (a)): the
 * format and channels when the request named none, and the hashtags and first
 * comment on what the model wrote. The caption skeleton is NOT used — it never
 * reaches a prompt, so a template cannot become an instruction to a model.
 */
export function generationDefaults(
  template: TemplateSource,
  request: {
    contentType?: ContentItem['contentType'] | undefined;
    platformKeys: readonly string[];
  },
): { contentType: ContentItem['contentType']; platformKeys: readonly string[] } {
  return {
    contentType: request.contentType ?? template.contentType,
    platformKeys: request.platformKeys.length > 0 ? request.platformKeys : template.platformKeys,
  };
}

/** The template's hashtags first, then the model's, bounded by the channel. */
export function applyTemplateToGeneratedVariant(
  template: TemplateSource,
  generated: { hashtags: readonly string[]; firstComment: string | null },
  platform: { maxHashtags: number; allowsFirstComment: boolean },
): { hashtags: string[]; firstComment: string | null } {
  return {
    hashtags: normaliseHashtags([...template.hashtags, ...generated.hashtags]).slice(
      0,
      platform.maxHashtags,
    ),
    firstComment:
      generated.firstComment ?? (platform.allowsFirstComment ? template.firstComment : null),
  };
}

/**
 * A BRAND'S "HASHTAGS IN THE FIRST COMMENT" DEFAULT (A10, Phase 2B-2).
 *
 * Applied when a post is CREATED — by hand or by the model — and only on a
 * channel that takes a first comment: the tags leave the caption's hashtag list
 * and are written, marked, at the end of the first comment. Nothing is lost and
 * nothing is hidden: the editor shows the first comment, and the person may
 * move them back. A channel with no first comment keeps its tags as they were.
 */
export function hashtagsIntoFirstComment(
  variant: { readonly hashtags: readonly string[]; readonly firstComment: string | null },
  platform: { readonly allowsFirstComment: boolean },
): { hashtags: string[]; firstComment: string | null } {
  if (!platform.allowsFirstComment || variant.hashtags.length === 0) {
    return { hashtags: [...variant.hashtags], firstComment: variant.firstComment };
  }
  const line = variant.hashtags.map((tag) => `#${tag}`).join(' ');
  return {
    hashtags: [],
    firstComment: variant.firstComment ? `${variant.firstComment}\n\n${line}` : line,
  };
}
