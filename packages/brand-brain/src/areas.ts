import type { BrandKnowledgeArea, BrandMemoryLayer } from '@brandspace/database';

/**
 * The ten knowledge areas.
 *
 * WHAT "COMPLETE" MEANS IS NO LONGER WRITTEN HERE. Phase 5 kept a
 * `minimumItems` count per area and turned the ratios into a percentage; Q19
 * (Phase 2C) replaced that with KEY QUESTIONS per area, from configuration, shown
 * as "answered n of m" with no percentage and no overall score — see
 * `completion.ts`. What stays here is the area's identity: its memory layer and
 * its message key.
 */
export interface AreaDefinition {
  readonly area: BrandKnowledgeArea;
  /** Which of D-64's four memories this area belongs to. */
  readonly memory: BrandMemoryLayer;
  /** The i18n key stem. Copy lives in the message catalogue, never here. */
  readonly messageKey: string;
}

export const AREA_DEFINITIONS: readonly AreaDefinition[] = [
  {
    area: 'IDENTITY',
    memory: 'CANONICAL',
    messageKey: 'identity',
  },
  {
    area: 'AUDIENCE',
    memory: 'CANONICAL',
    messageKey: 'audience',
  },
  {
    area: 'TONE_OF_VOICE',
    memory: 'CANONICAL',
    messageKey: 'toneOfVoice',
  },
  {
    area: 'OFFERS',
    memory: 'CANONICAL',
    messageKey: 'offers',
  },
  {
    area: 'PROOF_POINTS',
    memory: 'CANONICAL',
    messageKey: 'proofPoints',
  },
  {
    area: 'DO_DONT',
    memory: 'CANONICAL',
    messageKey: 'doDont',
  },
  {
    area: 'COMPETITORS',
    memory: 'CANONICAL',
    messageKey: 'competitors',
  },
  {
    area: 'GLOSSARY',
    memory: 'CANONICAL',
    messageKey: 'glossary',
  },
  {
    area: 'STRATEGY',
    memory: 'STRATEGY',
    messageKey: 'strategy',
  },
  {
    area: 'LEARNINGS',
    memory: 'LEARNING',
    messageKey: 'learnings',
  },
] as const;

export const BRAND_KNOWLEDGE_AREAS = AREA_DEFINITIONS.map((d) => d.area);

const BY_AREA = new Map<BrandKnowledgeArea, AreaDefinition>(
  AREA_DEFINITIONS.map((d) => [d.area, d]),
);

export function areaDefinition(area: BrandKnowledgeArea): AreaDefinition {
  const found = BY_AREA.get(area);
  // Not a defensive nicety: the enum and this table are two lists that can
  // drift, and a missing definition would otherwise surface as an area that
  // silently never counts toward completion.
  if (!found) throw new Error(`No AreaDefinition for area "${area}".`);
  return found;
}

export function isBrandKnowledgeArea(value: string): value is BrandKnowledgeArea {
  return BY_AREA.has(value as BrandKnowledgeArea);
}

/** The six areas the orb shows as nodes, in the demo's clockwise order. */
export const ORB_AREAS: readonly BrandKnowledgeArea[] = [
  'IDENTITY',
  'AUDIENCE',
  'OFFERS',
  'TONE_OF_VOICE',
  'LEARNINGS',
  'STRATEGY',
] as const;

/**
 * The demo's own name for each orbit position.
 *
 * The approved demo's stylesheet colours the six dots with attribute selectors
 * on its own vocabulary — `[data-area="audience"]` and `[data-area="learnings"]`
 * are purple, `[data-area="offers"]` and `[data-area="strategy"]` are yellow,
 * the other two are ink. The product's area keys are not that vocabulary, so the
 * mapping is written down here rather than guessed at the markup, where a
 * mismatch would silently recolour the orb. See docs/UI-FIDELITY-CONTRACT.md.
 */
export const ORB_SLOTS = {
  IDENTITY: 'identity',
  AUDIENCE: 'audience',
  OFFERS: 'offers',
  TONE_OF_VOICE: 'voice',
  LEARNINGS: 'learnings',
  STRATEGY: 'strategy',
} as const satisfies Record<string, string>;

export type OrbSlot = (typeof ORB_SLOTS)[keyof typeof ORB_SLOTS];
