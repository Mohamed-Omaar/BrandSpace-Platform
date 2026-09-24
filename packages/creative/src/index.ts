/**
 * THE AI CREATIVE STUDIO — image generation and adaptation (D-16, AC-28).
 *
 * IMAGES ONLY, AND THAT IS A DECISION RATHER THAN A STOPPING POINT. D-16
 * excluded video and voice from the MVP; `AI_TASKS` marks both as
 * `mvpApproved: false`, and nothing in this package can reach them.
 *
 * WHY A PACKAGE OF ITS OWN. It is the one place that needs BOTH the AI Gateway
 * (which carries the platform's database identity and moves the credit ledger)
 * and the Asset Library (which is tenant-scoped under RLS). Putting it inside
 * either would drag that dependency into a place F-07 keeps it out of — and
 * `packages/content` would then import the asset upload path purely so that a
 * different feature could live there.
 */
export {
  CreativeStudioService,
  brandTypography,
  creativeBriefRequired,
  creativeGenerationFailed,
  creativeReturnedNoBytes,
  unknownCreativeFormat,
} from './studio';
export type {
  BrandIdentityInput,
  CreativeStudioOptions,
  GenerateCreativeInput,
  GeneratedCreative,
} from './studio';
export { CREATIVE_FORMATS, adaptationsFor, findCreativeFormat } from './formats';
export type { CreativeFormat } from './formats';
