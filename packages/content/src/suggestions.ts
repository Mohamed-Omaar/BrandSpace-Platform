import { writeAuditEvent, type TenantScopedClient } from '@brandspace/database';
import { AppError, brandScopeFilter, systemClock, type Clock } from '@brandspace/shared';
import type { ContentPolicy } from './policy';

/**
 * WHAT BRANDSPACE NOTICED ABOUT A PERSON'S OWN WORK (Phase 6 final, D-277 §8-§10,
 * D-295).
 *
 * NOTHING HERE STORES BEHAVIOUR. Observations are read, each time, from the
 * immutable audit trail — the same rows the Activity screen shows — and only
 * what the person DECIDED is written (`member_suggestion`). One edit is never
 * a preference: a suggestion needs `preferenceMinObservations` edits across
 * `preferenceMinPosts` different posts inside `windowDays`, all from the
 * tenant's configuration.
 *
 * WHAT COUNTS. Only inline edits applied to a caption BrandSpace had just
 * GENERATED (`afterGeneration`), because shortening your own words says
 * nothing about what you want from the generator. Two shapes, closed:
 *   - `shorter:<platform>`  — repeated Shorten on that platform;
 *   - `tone:<tone>:<platform>` — repeated tone change to friendly or
 *     professional on that platform.
 *
 * WHAT AN ACCEPTED PREFERENCE DOES. It becomes an instruction to the
 * generator for that person, that brand and that platform — written by this
 * file from the closed key, never from anything a person typed — and nothing
 * else. It never enters Brand Brain: one person's habit is not the brand's
 * truth.
 */

export const PREFERENCE_SOURCE = 'content.inline_actions';

/** The tone arguments the editor sends, as the closed tone keys they mean. */
export const TONE_KEYS: Readonly<Record<string, 'friendly' | 'professional'>> = {
  'friendly and warm': 'friendly',
  professional: 'professional',
};

const PLATFORM_KEY = /^[a-z0-9_-]{1,40}$/;

export interface ToolObservation {
  readonly action: string;
  /** The variant the edit touched — "different posts" is counted by this. */
  readonly resourceId: string | null;
  readonly after: unknown;
}

export interface NoticedPreference {
  readonly key: string;
  readonly tool: 'shorten' | 'tone';
  readonly platformKey: string;
  readonly tone: 'friendly' | 'professional' | null;
  readonly observations: number;
  readonly posts: number;
}

/** The preference key one audited edit points at, or null when it counts for nothing. */
export function preferenceKeyOf(event: ToolObservation): {
  key: string;
  tool: 'shorten' | 'tone';
  platformKey: string;
  tone: 'friendly' | 'professional' | null;
} | null {
  const after =
    typeof event.after === 'object' && event.after !== null
      ? (event.after as Record<string, unknown>)
      : null;
  if (!after || after['afterGeneration'] !== true) return null;
  const platformKey = typeof after['platformKey'] === 'string' ? after['platformKey'] : '';
  if (!PLATFORM_KEY.test(platformKey)) return null;
  if (event.action === 'content.variant.shorten') {
    return { key: `shorter:${platformKey}`, tool: 'shorten', platformKey, tone: null };
  }
  if (event.action === 'content.variant.tone') {
    const tone = after['tone'];
    if (tone !== 'friendly' && tone !== 'professional') return null;
    return { key: `tone:${tone}:${platformKey}`, tool: 'tone', platformKey, tone };
  }
  return null;
}

/** Group audited edits into the preferences they are evidence of, past the thresholds. */
export function noticePreferences(
  events: readonly ToolObservation[],
  thresholds: ContentPolicy['learning'],
): NoticedPreference[] {
  const groups = new Map<
    string,
    { meta: NonNullable<ReturnType<typeof preferenceKeyOf>>; count: number; posts: Set<string> }
  >();
  for (const event of events) {
    const meta = preferenceKeyOf(event);
    if (!meta) continue;
    const group = groups.get(meta.key) ?? { meta, count: 0, posts: new Set<string>() };
    group.count += 1;
    if (event.resourceId) group.posts.add(event.resourceId);
    groups.set(meta.key, group);
  }
  return [...groups.values()]
    .filter(
      (group) =>
        group.count >= thresholds.preferenceMinObservations &&
        group.posts.size >= thresholds.preferenceMinPosts,
    )
    .map((group) => ({
      key: group.meta.key,
      tool: group.meta.tool,
      platformKey: group.meta.platformKey,
      tone: group.meta.tone,
      observations: group.count,
      posts: group.posts.size,
    }))
    .sort((a, b) => b.observations - a.observations);
}

/**
 * The generator instruction an ACCEPTED preference becomes, for the platforms
 * being written. Built from the closed key; an unrecognised key says nothing.
 */
export function preferenceInstructions(
  keys: readonly string[],
  platformKeys: readonly string[],
): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const shorter = /^shorter:([a-z0-9_-]{1,40})$/.exec(key);
    if (shorter && platformKeys.includes(shorter[1]!)) {
      out.push(`For ${shorter[1]}, keep the caption noticeably shorter than the channel allows.`);
      continue;
    }
    const tone = /^tone:(friendly|professional):([a-z0-9_-]{1,40})$/.exec(key);
    if (tone && platformKeys.includes(tone[2]!)) {
      out.push(
        `For ${tone[2]}, write in a ${tone[1] === 'friendly' ? 'friendly and warm' : 'professional'} tone.`,
      );
    }
  }
  return out;
}

export type SuggestionDecision = 'accept' | 'dismiss' | 'snooze';

const notNoticed = (): AppError =>
  new AppError('NOT_FOUND', 'There is nothing to decide about that suggestion.');

export class MemberSuggestionService {
  readonly #db: TenantScopedClient;
  readonly #workspaceId: string;
  readonly #learning: ContentPolicy['learning'];
  readonly #clock: Clock;

  constructor(options: {
    db: TenantScopedClient;
    workspaceId: string;
    policy: ContentPolicy;
    clock?: Clock;
  }) {
    this.#db = options.db;
    this.#workspaceId = options.workspaceId;
    this.#learning = options.policy.learning;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * Preferences this person's own recent edits point at for this brand, minus
   * any they have decided on (accepted, dismissed, or snoozed and not yet due).
   * The brand is read under the caller's scope first, so an out-of-scope brand
   * notices nothing.
   */
  async noticedPreferences(input: {
    userId: string;
    brandId: string;
    brandScope: readonly string[];
  }): Promise<NoticedPreference[]> {
    const brand = await this.#db.brand.findFirst({
      where: { id: input.brandId, ...brandScopeFilter(input.brandScope) },
      select: { id: true },
    });
    if (!brand) return [];
    const now = this.#clock.now();
    const since = new Date(now.getTime() - this.#learning.windowDays * 86_400_000);
    const events = await this.#db.auditEvent.findMany({
      where: {
        workspaceId: this.#workspaceId,
        brandId: input.brandId,
        actorId: input.userId,
        action: { in: ['content.variant.shorten', 'content.variant.tone'] },
        occurredAt: { gte: since },
      },
      select: { action: true, resourceId: true, after: true },
      orderBy: { occurredAt: 'desc' },
      take: 500,
    });
    const decided = await this.#decidedKeys(input.userId, input.brandId, 'PREFERENCE', now);
    return noticePreferences(events, this.#learning).filter((row) => !decided.has(row.key));
  }

  /** The keys of this person's ACCEPTED preferences for this brand. */
  async acceptedPreferences(input: { userId: string; brandId: string }): Promise<string[]> {
    const rows = await this.#db.memberSuggestion.findMany({
      where: {
        workspaceId: this.#workspaceId,
        brandId: input.brandId,
        userId: input.userId,
        kind: 'PREFERENCE',
        status: 'ACCEPTED',
      },
      select: { key: true },
      orderBy: { key: 'asc' },
    });
    return rows.map((row) => row.key);
  }

  /**
   * Record a decision. ACCEPT is refused unless the preference is noticed NOW
   * from the person's own audited edits — a crafted form cannot manufacture a
   * default nobody earned. Dismiss and snooze are always the person's to make.
   */
  async decidePreference(input: {
    userId: string;
    brandId: string;
    brandScope: readonly string[];
    key: string;
    decision: SuggestionDecision;
  }): Promise<void> {
    const noticed = await this.noticedPreferences(input);
    const match = noticed.find((row) => row.key === input.key);
    if (!match) throw notNoticed();
    await this.#record({
      userId: input.userId,
      brandId: input.brandId,
      kind: 'PREFERENCE',
      key: input.key,
      decision: input.decision,
      evidenceCount: match.observations,
      source: PREFERENCE_SOURCE,
    });
  }

  /** Undo an accepted preference: it stops influencing, and is not suggested again. */
  async forgetPreference(input: { userId: string; brandId: string; key: string }): Promise<void> {
    const row = await this.#db.memberSuggestion.findFirst({
      where: {
        workspaceId: this.#workspaceId,
        brandId: input.brandId,
        userId: input.userId,
        kind: 'PREFERENCE',
        key: input.key,
        status: 'ACCEPTED',
      },
    });
    if (!row) throw notNoticed();
    await this.#record({
      userId: input.userId,
      brandId: input.brandId,
      kind: 'PREFERENCE',
      key: input.key,
      decision: 'dismiss',
      evidenceCount: row.evidenceCount,
      source: row.source,
    });
  }

  /** Keys with a standing decision: accepted, dismissed, or snoozed and not yet due. */
  async #decidedKeys(
    userId: string,
    brandId: string,
    kind: 'PREFERENCE' | 'WORKFLOW',
    now: Date,
  ): Promise<Set<string>> {
    const rows = await this.#db.memberSuggestion.findMany({
      where: { workspaceId: this.#workspaceId, brandId, userId, kind },
      select: { key: true, status: true, snoozedUntil: true },
    });
    return new Set(
      rows
        .filter((row) => row.status !== 'SNOOZED' || (row.snoozedUntil && row.snoozedUntil > now))
        .map((row) => row.key),
    );
  }

  async #record(input: {
    userId: string;
    brandId: string;
    kind: 'PREFERENCE' | 'WORKFLOW';
    key: string;
    decision: SuggestionDecision;
    evidenceCount: number;
    source: string;
  }): Promise<void> {
    if (input.decision === 'accept' && input.kind !== 'PREFERENCE') throw notNoticed();
    const now = this.#clock.now();
    const status =
      input.decision === 'accept'
        ? 'ACCEPTED'
        : input.decision === 'dismiss'
          ? 'DISMISSED'
          : 'SNOOZED';
    const snoozedUntil =
      status === 'SNOOZED'
        ? new Date(now.getTime() + this.#learning.snoozeDays * 86_400_000)
        : null;
    const where = {
      workspaceId: this.#workspaceId,
      brandId: input.brandId,
      userId: input.userId,
      kind: input.kind,
      key: input.key,
    };
    const existing = await this.#db.memberSuggestion.findFirst({
      where,
      select: { id: true, status: true },
    });
    const row = existing
      ? await this.#db.memberSuggestion.update({
          where: { id: existing.id },
          data: {
            status,
            snoozedUntil,
            decidedAt: now,
            evidenceCount: input.evidenceCount,
            source: input.source,
          },
          select: { id: true },
        })
      : await this.#db.memberSuggestion.create({
          data: {
            ...where,
            status,
            snoozedUntil,
            decidedAt: now,
            evidenceCount: input.evidenceCount,
            source: input.source,
          },
          select: { id: true },
        });
    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: `suggestion.${input.kind.toLowerCase()}.${status.toLowerCase()}`,
      actorType: 'USER',
      actorId: input.userId,
      resourceType: 'MemberSuggestion',
      resourceId: row.id,
      brandId: input.brandId,
      before: existing ? { status: existing.status } : null,
      after: { key: input.key, status, evidenceCount: input.evidenceCount },
    });
  }

  /** For C21 (D-296): workflow decisions share the table and the rules. */
  protected async recordWorkflow(input: {
    userId: string;
    brandId: string;
    key: string;
    decision: 'dismiss' | 'snooze';
    evidenceCount: number;
    source: string;
  }): Promise<void> {
    await this.#record({ ...input, kind: 'WORKFLOW' });
  }

  protected decidedWorkflowKeys(userId: string, brandId: string): Promise<Set<string>> {
    return this.#decidedKeys(userId, brandId, 'WORKFLOW', this.#clock.now());
  }

  protected get db(): TenantScopedClient {
    return this.#db;
  }

  protected get workspaceId(): string {
    return this.#workspaceId;
  }

  protected get learning(): ContentPolicy['learning'] {
    return this.#learning;
  }

  protected get clock(): Clock {
    return this.#clock;
  }
}
