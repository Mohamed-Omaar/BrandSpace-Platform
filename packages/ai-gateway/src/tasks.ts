import type { AiModality } from './adapter';

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
  /** Long-running work is queued rather than served inline (§5.1). */
  readonly async: boolean;
}

export const AI_TASKS = [
  { key: 'caption.generate', modality: 'text', async: false },
  { key: 'ideas.generate', modality: 'text', async: false },
  { key: 'plan.monthly', modality: 'text', async: false },
  { key: 'strategy.generate', modality: 'text', async: false },
  { key: 'analytics.explain', modality: 'text', async: false },
  { key: 'copilot.chat', modality: 'text', async: false },
  { key: 'content.translate', modality: 'text', async: false },
  { key: 'image.generate', modality: 'image', async: false },
  // Long, expensive and never inline — docs/AI-GATEWAY.md §5.1.
  { key: 'video.generate', modality: 'video', async: true },
  { key: 'voice.synthesize', modality: 'voice', async: true },
  { key: 'moderation.check', modality: 'moderation', async: false },
  { key: 'brand.retrieve', modality: 'embedding', async: false },
] as const satisfies readonly AiTaskDefinition[];

export type AiTaskKey = (typeof AI_TASKS)[number]['key'];

const BY_KEY = new Map<string, AiTaskDefinition>(AI_TASKS.map((task) => [task.key, task]));

export const AI_TASK_KEYS: readonly AiTaskKey[] = AI_TASKS.map((task) => task.key);

export function findAiTask(key: string): AiTaskDefinition | undefined {
  return BY_KEY.get(key);
}

export function isAiTaskKey(key: string): key is AiTaskKey {
  return BY_KEY.has(key);
}
