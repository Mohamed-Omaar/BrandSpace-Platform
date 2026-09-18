/**
 * THE OUTPUT FORMATS THE CREATIVE STUDIO OFFERS (AC-28.2).
 *
 * WHY THESE ARE CODE AND NOT CONFIGURATION, which is the opposite of almost
 * every other list in this product. A platform's CHARACTER LIMIT is an
 * operator's fact — it changes, and changing it must not need a deploy. An
 * aspect ratio is not: `1:1` and `9:16` are geometry, the preview component
 * already hard-codes the same set (`PLATFORM_ASPECTS` in `packages/ui`), and
 * two sources of truth for "what shape is a story" is exactly the drift that
 * would put a preview and an export out of step.
 *
 * WHAT WOULD MAKE THIS CONFIGURATION: a platform appearing with a shape nobody
 * here anticipated. That is a Phase 10 question — it arrives with the real
 * provider — and the registry below is small enough to extend honestly when it
 * does.
 *
 * THE SIZES ARE THE ONES THE PLATFORMS PUBLISH for each placement. They are
 * also what the mock adapter draws at, so a development image is the shape a
 * real one would be.
 */

export interface CreativeFormat {
  readonly key: string;
  /** A translation key. §4 forbids user-facing copy in a registry. */
  readonly labelKey: string;
  /** Human-readable, for a prompt. Not shown to the customer. */
  readonly label: string;
  /** `<width>x<height>`, the string the gateway's image input carries. */
  readonly size: string;
  readonly aspect: '1:1' | '4:5' | '16:9' | '9:16';
  /** Platforms this shape is meant for, for a screen that groups them. */
  readonly platformKeys: readonly string[];
}

export const CREATIVE_FORMATS: readonly CreativeFormat[] = [
  {
    key: 'square',
    labelKey: 'creative.format.square',
    label: 'Square feed post',
    size: '1080x1080',
    aspect: '1:1',
    platformKeys: ['instagram', 'facebook', 'linkedin', 'x'],
  },
  {
    key: 'portrait',
    labelKey: 'creative.format.portrait',
    label: 'Portrait feed post',
    size: '1080x1350',
    aspect: '4:5',
    platformKeys: ['instagram', 'facebook', 'linkedin'],
  },
  {
    key: 'story',
    labelKey: 'creative.format.story',
    label: 'Full-screen story',
    size: '1080x1920',
    aspect: '9:16',
    platformKeys: ['instagram', 'facebook', 'tiktok'],
  },
  {
    key: 'landscape',
    labelKey: 'creative.format.landscape',
    label: 'Landscape post',
    size: '1200x675',
    aspect: '16:9',
    platformKeys: ['linkedin', 'x', 'facebook'],
  },
];

export function findCreativeFormat(key: string): CreativeFormat | undefined {
  return CREATIVE_FORMATS.find((format) => format.key === key);
}

/**
 * The formats an already-generated image can be ADAPTED to (AC-28.2).
 *
 * Every format except the one it already is. Adaptation is a second generation
 * at a different shape rather than a crop, and deliberately: cropping a
 * composed image moves its subject out of frame, which is the commonest way an
 * automatic resize ruins a picture. The customer pays for the second image and
 * gets one composed for that shape.
 */
export function adaptationsFor(key: string): readonly CreativeFormat[] {
  return CREATIVE_FORMATS.filter((format) => format.key !== key);
}
