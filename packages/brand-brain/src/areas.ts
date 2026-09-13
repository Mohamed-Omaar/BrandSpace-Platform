import type { BrandKnowledgeArea, BrandMemoryLayer } from '@brandspace/database';

/**
 * The ten knowledge areas, and what "complete" means for each.
 *
 * THIS TABLE IS THE COMPLETION RULE. The demo showed a hard-coded 82%; the
 * product computes it, and the only way that computation is defensible is if
 * the requirement per area is written down, deterministic and testable rather
 * than tuned until the number looked encouraging.
 *
 * `minimumItems` is the count of ACTIVE items an area needs before it counts as
 * complete. The numbers are PRODUCT requirements — how much a brand must say
 * before AI grounding is meaningful — not commercial policy, so they live in
 * code rather than in the Configuration Service. A plan cannot buy a lower bar
 * for what "complete" means: that would make the same badge mean different
 * things to different customers.
 */
export interface AreaDefinition {
  readonly area: BrandKnowledgeArea;
  /** Which of D-64's four memories this area belongs to. */
  readonly memory: BrandMemoryLayer;
  /** ACTIVE items required before the area is COMPLETE. */
  readonly minimumItems: number;
  /**
   * Whether the area counts toward overall completion.
   *
   * LEARNINGS does not. It is written back by the system from performance
   * evidence (D-64), so counting it would mean a brand new workspace is
   * permanently incomplete through no fault of its own, and a customer could
   * never reach 100% by doing everything asked of them.
   */
  readonly countsTowardCompletion: boolean;
  /**
   * Whether both locales are required for the area to be complete.
   *
   * Voice and glossary are language-shaped: a tone of voice recorded only in
   * English cannot ground Arabic generation, and that is the failure the
   * bilingual product exists to avoid. The rest accept one locale.
   */
  readonly requiresBothLocales: boolean;
  /** The i18n key stem. Copy lives in the message catalogue, never here. */
  readonly messageKey: string;
}

export const AREA_DEFINITIONS: readonly AreaDefinition[] = [
  {
    area: 'IDENTITY',
    memory: 'CANONICAL',
    minimumItems: 4,
    countsTowardCompletion: true,
    requiresBothLocales: false,
    messageKey: 'identity',
  },
  {
    area: 'AUDIENCE',
    memory: 'CANONICAL',
    minimumItems: 2,
    countsTowardCompletion: true,
    requiresBothLocales: false,
    messageKey: 'audience',
  },
  {
    area: 'TONE_OF_VOICE',
    memory: 'CANONICAL',
    minimumItems: 2,
    countsTowardCompletion: true,
    requiresBothLocales: true,
    messageKey: 'toneOfVoice',
  },
  {
    area: 'OFFERS',
    memory: 'CANONICAL',
    minimumItems: 1,
    countsTowardCompletion: true,
    requiresBothLocales: false,
    messageKey: 'offers',
  },
  {
    area: 'PROOF_POINTS',
    memory: 'CANONICAL',
    minimumItems: 2,
    countsTowardCompletion: true,
    requiresBothLocales: false,
    messageKey: 'proofPoints',
  },
  {
    area: 'DO_DONT',
    memory: 'CANONICAL',
    minimumItems: 2,
    countsTowardCompletion: true,
    requiresBothLocales: false,
    messageKey: 'doDont',
  },
  {
    area: 'COMPETITORS',
    memory: 'CANONICAL',
    minimumItems: 1,
    countsTowardCompletion: true,
    requiresBothLocales: false,
    messageKey: 'competitors',
  },
  {
    area: 'GLOSSARY',
    memory: 'CANONICAL',
    minimumItems: 1,
    countsTowardCompletion: true,
    requiresBothLocales: true,
    messageKey: 'glossary',
  },
  {
    area: 'STRATEGY',
    memory: 'STRATEGY',
    minimumItems: 1,
    countsTowardCompletion: true,
    requiresBothLocales: false,
    messageKey: 'strategy',
  },
  {
    area: 'LEARNINGS',
    memory: 'LEARNING',
    minimumItems: 0,
    // See `countsTowardCompletion` above: written back by the system, so it is
    // reported but never held against the customer.
    countsTowardCompletion: false,
    requiresBothLocales: false,
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
