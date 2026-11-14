/**
 * PR B — WHAT A SCREEN NEEDS FROM THIS PACKAGE, WITHOUT THE IMAGE LIBRARIES.
 *
 * `@brandspace/creative` composes images on the server with `sharp` and
 * `@napi-rs/canvas` (native code, D-602). A Next.js page that only needs the
 * formats and the Brand Brain selection imports `@brandspace/creative/catalogue`,
 * so neither library is ever bundled into, or loaded by, the dashboard.
 */
export { CREATIVE_FORMATS, adaptationsFor, findCreativeFormat } from './formats';
export type { CreativeFormat } from './formats';
export { brandTypography } from '@brandspace/shared';

/** The Brand Brain areas a generation reads, each its own fenced block. */
export const CREATIVE_KNOWLEDGE_AREAS = ['IDENTITY'] as const;
/** PR B — the voice and the do's and don'ts. */
export const CREATIVE_VOICE_AREAS = ['TONE_OF_VOICE'] as const;
export const CREATIVE_DO_DONT_AREAS = ['DO_DONT'] as const;
/** At most this many lines from each of the three. */
export const CREATIVE_KNOWLEDGE_LINES = 6;
/** All of them, for a screen that counts what a generation reads. */
export const CREATIVE_BRAND_BRAIN_AREAS = [
  ...CREATIVE_KNOWLEDGE_AREAS,
  ...CREATIVE_VOICE_AREAS,
  ...CREATIVE_DO_DONT_AREAS,
] as const;
