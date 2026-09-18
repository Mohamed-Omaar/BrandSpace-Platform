import type { AiModality } from './adapter';

/**
 * The AI CAPABILITY vocabulary — Phase 10, docs/AI-GATEWAY.md §5.0.
 *
 * WHAT PROBLEM THIS SOLVES. A task key says what the PRODUCT wants done
 * ("write a caption"). A capability says what KIND OF MODEL can do it
 * ("standard content generation, text in, text out"). Before Phase 10 those
 * two were the same thing, which meant an operator configuring a new product
 * feature had to reason about models one task at a time — and meant a fallback
 * could be any model of the right modality, including one that cannot see an
 * image when the task requires vision.
 *
 * WHY IT IS CODE AND NOT CONFIGURATION, for the same reason `tasks.ts` is.
 * `REASONING_COMPLEX` is a name application code routes by; renaming it is a
 * code change. Which MODEL satisfies it is entirely configuration, appears
 * nowhere in this file, and is the owner's to set (CLAUDE.md §2.2).
 *
 * THE INVARIANT THIS FILE EXISTS TO MAKE ENFORCEABLE. A capability declares
 * the features a model must actually possess, so routing can refuse a model
 * that does not possess them — primary and fallback alike. A text-only
 * fallback silently serving an image-generation request is the failure mode
 * this replaces, and it is the one a modality check alone does not catch:
 * "vision analysis" and "write a caption" are both text models.
 */

/**
 * Model features a capability may require.
 *
 * Every field is a declaration an operator makes about a model in the
 * catalogue, and every one of them is something a real provider either
 * supports or does not. A capability requires the subset it genuinely needs;
 * anything else would narrow the owner's choice of vendor for no reason.
 */
export interface ModelFeatureRequirements {
  /** The model accepts images as input (multimodal understanding). */
  readonly vision?: boolean;
  /** The model can be constrained to emit schema-valid JSON. */
  readonly structuredOutput?: boolean;
  /** The model can call tools / functions. */
  readonly toolUse?: boolean;
  /** The model accepts audio as input. */
  readonly audioInput?: boolean;
  /** The model produces audio as output. */
  readonly audioOutput?: boolean;
  /** The model produces embedding vectors. */
  readonly embeddings?: boolean;
}

export interface AiCapabilityDefinition {
  readonly key: string;
  /**
   * Which adapter method serves it — the EXISTING `AiModality` vocabulary,
   * unchanged.
   *
   * Capability is a layer above modality, not a replacement for it: the
   * gateway pipeline still dispatches on modality, and a model is still
   * declared with one. `VISION_ANALYSIS` executes as `text` because a vision
   * model IS a text model that also accepts pictures, and saying otherwise
   * would have forced a second dispatch path for no gain.
   */
  readonly executionModality: AiModality;
  /** What the caller supplies. Catalogue and UI vocabulary (§6). */
  readonly inputModality: 'text' | 'image' | 'audio' | 'text+image';
  /** What comes back. */
  readonly outputModality: 'text' | 'image' | 'audio' | 'video' | 'embedding' | 'classification';
  /** Features a model MUST declare before it may serve this capability. */
  readonly requires: ModelFeatureRequirements;
  /**
   * Whether cost per request is usually dominated by output length.
   *
   * Read by the Economy profile, which prefers a cheaper OUTPUT price where
   * that is what drives the bill and a cheaper input price where it is not.
   */
  readonly outputDominatesCost: boolean;
}

export const AI_CAPABILITIES = [
  {
    key: 'TEXT_LIGHT',
    executionModality: 'text',
    inputModality: 'text',
    outputModality: 'text',
    requires: {},
    outputDominatesCost: true,
  },
  {
    key: 'CONTENT_STANDARD',
    executionModality: 'text',
    inputModality: 'text',
    outputModality: 'text',
    requires: {},
    outputDominatesCost: true,
  },
  {
    /*
     * Structured output is REQUIRED here and not merely preferred. Every task
     * that asks for complex reasoning in this product — a strategy, a monthly
     * plan, an analytics explanation — parses the answer into typed data, and
     * a model that cannot be held to a schema turns that into string surgery
     * over prose. CLAUDE.md §5 says parse, do not validate ad hoc; this is
     * where that becomes a routing constraint.
     */
    key: 'REASONING_COMPLEX',
    executionModality: 'text',
    inputModality: 'text',
    outputModality: 'text',
    requires: { structuredOutput: true },
    outputDominatesCost: true,
  },
  {
    key: 'IMAGE_GENERATION',
    executionModality: 'image',
    inputModality: 'text',
    outputModality: 'image',
    requires: {},
    // Priced per image, so neither token price drives the bill.
    outputDominatesCost: false,
  },
  {
    key: 'VISION_ANALYSIS',
    executionModality: 'text',
    inputModality: 'text+image',
    outputModality: 'text',
    requires: { vision: true },
    // A picture is a large input and the answer is usually short.
    outputDominatesCost: false,
  },
  {
    key: 'EMBEDDINGS',
    executionModality: 'embedding',
    inputModality: 'text',
    outputModality: 'embedding',
    requires: { embeddings: true },
    outputDominatesCost: false,
  },
  {
    key: 'SPEECH_TO_TEXT',
    executionModality: 'voice',
    inputModality: 'audio',
    outputModality: 'text',
    requires: { audioInput: true },
    outputDominatesCost: false,
  },
  {
    key: 'TEXT_TO_SPEECH',
    executionModality: 'voice',
    inputModality: 'text',
    outputModality: 'audio',
    requires: { audioOutput: true },
    outputDominatesCost: true,
  },
  {
    key: 'VIDEO_GENERATION',
    executionModality: 'video',
    inputModality: 'text',
    outputModality: 'video',
    requires: {},
    outputDominatesCost: false,
  },
  {
    key: 'MODERATION',
    executionModality: 'moderation',
    inputModality: 'text',
    outputModality: 'classification',
    requires: {},
    outputDominatesCost: false,
  },
] as const satisfies readonly AiCapabilityDefinition[];

export type AiCapabilityKey = (typeof AI_CAPABILITIES)[number]['key'];

export const AI_CAPABILITY_KEYS: readonly AiCapabilityKey[] = AI_CAPABILITIES.map((c) => c.key);

const BY_KEY = new Map<string, AiCapabilityDefinition>(AI_CAPABILITIES.map((c) => [c.key, c]));

export function findAiCapability(key: string): AiCapabilityDefinition | undefined {
  return BY_KEY.get(key);
}

export function isAiCapabilityKey(key: string): key is AiCapabilityKey {
  return BY_KEY.has(key);
}

/** What a model in the catalogue declares about itself, as routing needs it. */
export interface ModelFeatureDeclaration {
  readonly vision: boolean;
  readonly structuredOutput: boolean;
  readonly toolUse: boolean;
  readonly audioInput: boolean;
  readonly audioOutput: boolean;
  readonly embeddings: boolean;
}

export const NO_MODEL_FEATURES: ModelFeatureDeclaration = {
  vision: false,
  structuredOutput: false,
  toolUse: false,
  audioInput: false,
  audioOutput: false,
  embeddings: false,
};

/**
 * Why a model may not serve a capability, or `null` when it may.
 *
 * Returns the REASON rather than a boolean because every caller needs it: the
 * router records it on the excluded list, configuration validation reports it
 * to the operator at activation time, and the Control Center shows it beside
 * the model. A boolean would have made all three say "unsupported" and leave
 * the operator to guess which of six declarations was missing.
 */
export function capabilityRefusal(
  capability: AiCapabilityDefinition,
  model: { readonly modality: AiModality; readonly features: ModelFeatureDeclaration },
): string | null {
  if (model.modality !== capability.executionModality) {
    return `needs a ${capability.executionModality} model, this one is ${model.modality}`;
  }
  const missing: string[] = [];
  const required = capability.requires;
  if (required.vision && !model.features.vision) missing.push('vision');
  if (required.structuredOutput && !model.features.structuredOutput)
    missing.push('structured output');
  if (required.toolUse && !model.features.toolUse) missing.push('tool use');
  if (required.audioInput && !model.features.audioInput) missing.push('audio input');
  if (required.audioOutput && !model.features.audioOutput) missing.push('audio output');
  if (required.embeddings && !model.features.embeddings) missing.push('embeddings');
  if (missing.length === 0) return null;
  return `does not declare ${missing.join(', ')}`;
}

export function modelSatisfies(
  capability: AiCapabilityDefinition,
  model: { readonly modality: AiModality; readonly features: ModelFeatureDeclaration },
): boolean {
  return capabilityRefusal(capability, model) === null;
}
