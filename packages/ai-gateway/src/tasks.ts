import type { AiModality } from './adapter';
import { findAiCapability, type AiCapabilityKey } from './capabilities';

/**
 * The AI task catalogue — docs/AI-GATEWAY.md §5.1.
 *
 * WHY THIS IS CODE AND NOT CONFIGURATION. A task KEY is the name application
 * code calls the gateway by, exactly as `entitlements.can(ws, 'ai.image_generation')`
 * names a feature key: renaming one is a code change, not an operator action.
 * Its modality is intrinsic in the same way — `image.generate` produces an
 * image whatever an operator would prefer.
 *
 * Everything an operator legitimately tunes — which model serves the task, in
 * what order, with what timeout, temperature, retry policy and credit cost —
 * is configuration and appears nowhere in this file. CLAUDE.md §2.2 forbids the
 * model names; it does not forbid the task names that the config screens
 * themselves have to offer.
 */
export interface AiTaskDefinition {
  readonly key: string;
  readonly modality: AiModality;
  /**
   * The CAPABILITY this task needs — Phase 10.
   *
   * The task says what the product wants done; the capability says what kind
   * of model can do it. Two tasks that need the same kind of model share a
   * capability, which is what lets an owner configure routing once for
   * "complex reasoning" instead of once per feature — and what lets routing
   * refuse a fallback that cannot actually do the work (§7).
   *
   * `modality` above is kept and is still what the pipeline dispatches on. It
   * is now DERIVED from the capability rather than chosen independently, and a
   * unit test asserts the two agree: a task whose declared modality drifted
   * from its capability would route to models that cannot serve it.
   */
  readonly capability: AiCapabilityKey;
  /** Long-running work is queued rather than served inline (§5.1). */
  readonly async: boolean;
  /**
   * Whether this task is within the approved MVP scope — D-16, 2026-09-13.
   *
   * The owner approved TEXT and IMAGE generation for the MVP and excluded
   * video, recording it as a Phase 7+ candidate needing its own cost, latency
   * and product review. Voice was already post-MVP.
   *
   * The task stays in the catalogue either way: removing it would erase the
   * fact that it is a known, deliberately deferred capability, and the enum it
   * refers to is shared with later phases. What the flag does is let
   * `validateConfiguration` refuse a routing rule for an out-of-scope task, so
   * "excluded from the MVP" is a thing the system enforces rather than a thing
   * a document says.
   *
   * Embedding and moderation are internal plumbing rather than customer-facing
   * generation modalities, so D-16 does not bear on them: `moderation.check` is
   * used by the gateway itself and `brand.retrieve` by Brand Brain retrieval.
   */
  readonly mvpApproved: boolean;
}

export const AI_TASKS = [
  {
    key: 'caption.generate',
    capability: 'CONTENT_STANDARD',
    modality: 'text',
    async: false,
    mvpApproved: true,
  },
  {
    key: 'ideas.generate',
    capability: 'TEXT_LIGHT',
    modality: 'text',
    async: false,
    mvpApproved: true,
  },
  {
    key: 'plan.monthly',
    capability: 'REASONING_COMPLEX',
    modality: 'text',
    async: false,
    mvpApproved: true,
  },
  {
    key: 'strategy.generate',
    capability: 'REASONING_COMPLEX',
    modality: 'text',
    async: false,
    mvpApproved: true,
  },
  {
    key: 'analytics.explain',
    capability: 'REASONING_COMPLEX',
    modality: 'text',
    async: false,
    mvpApproved: true,
  },
  {
    key: 'copilot.chat',
    capability: 'CONTENT_STANDARD',
    modality: 'text',
    async: false,
    mvpApproved: true,
  },
  {
    key: 'content.translate',
    capability: 'TEXT_LIGHT',
    modality: 'text',
    async: false,
    mvpApproved: true,
  },
  {
    key: 'image.generate',
    capability: 'IMAGE_GENERATION',
    modality: 'image',
    async: false,
    mvpApproved: true,
  },
  // D-16: excluded from the MVP and recorded as a Phase 7+ candidate. Long,
  // expensive and never inline — docs/AI-GATEWAY.md §5.1.
  {
    key: 'video.generate',
    capability: 'VIDEO_GENERATION',
    modality: 'video',
    async: true,
    mvpApproved: false,
  },
  // Post-MVP, and unchanged by D-16, which did not approve a voice modality.
  {
    key: 'voice.synthesize',
    capability: 'TEXT_TO_SPEECH',
    modality: 'voice',
    async: true,
    mvpApproved: false,
  },
  // Internal plumbing, not a customer-facing generation modality.
  {
    key: 'moderation.check',
    capability: 'MODERATION',
    modality: 'moderation',
    async: false,
    mvpApproved: true,
  },
  {
    key: 'brand.retrieve',
    capability: 'EMBEDDINGS',
    modality: 'embedding',
    async: false,
    mvpApproved: true,
  },
] as const satisfies readonly AiTaskDefinition[];

/** Task keys the owner has approved for the MVP — D-16. */
export const MVP_AI_TASK_KEYS: readonly string[] = AI_TASKS.filter((task) => task.mvpApproved).map(
  (task) => task.key,
);

export type AiTaskKey = (typeof AI_TASKS)[number]['key'];

const BY_KEY = new Map<string, AiTaskDefinition>(AI_TASKS.map((task) => [task.key, task]));

export const AI_TASK_KEYS: readonly AiTaskKey[] = AI_TASKS.map((task) => task.key);

export function findAiTask(key: string): AiTaskDefinition | undefined {
  return BY_KEY.get(key);
}

export function isAiTaskKey(key: string): key is AiTaskKey {
  return BY_KEY.has(key);
}

/**
 * The capability a task needs, resolved to its definition.
 *
 * Throws for an unknown task rather than returning undefined: every caller here
 * already holds a key from the closed registry, and a silent undefined would
 * become an unrouted request much further downstream.
 */
export function capabilityForTask(taskKey: string): AiCapabilityKey | undefined {
  return BY_KEY.get(taskKey)?.capability;
}

/** Which product tasks actually request a capability. Empty is legitimate. */
export function tasksForCapability(capability: string): readonly AiTaskDefinition[] {
  return AI_TASKS.filter((task) => task.capability === capability);
}

/**
 * Capabilities at least one MVP-approved task requests.
 *
 * The Control Center shows every capability — an owner configuring
 * `VISION_ANALYSIS` before a feature needs it is doing useful preparation —
 * but it says which ones a shipping feature actually calls, so nobody mistakes
 * an unrouted capability for a broken product.
 */
export const REQUESTED_AI_CAPABILITIES: readonly string[] = [
  ...new Set(AI_TASKS.filter((task) => task.mvpApproved).map((task) => task.capability)),
];

/**
 * Tasks whose declared modality disagrees with their capability.
 *
 * Always empty in a correct build. It exists so a unit test can assert that
 * rather than a comment claiming it: the two fields are written by hand, and a
 * task that drifted would route to models unable to serve it.
 */
export function tasksWithInconsistentModality(): readonly string[] {
  return AI_TASKS.filter((task) => {
    const capability = findAiCapability(task.capability);
    return !capability || capability.executionModality !== task.modality;
  }).map((task) => task.key);
}
