import { ambientTokens } from './tokens';

/**
 * THE AMBIENT BACKGROUND (D-59).
 *
 * The approved direction's signature, and the single reason the rest of the
 * interface can stay almost entirely black and white: the brand purple and
 * yellow appear at full saturation exactly ONCE in the whole product, as three
 * enormous, heavily blurred, low-opacity orbs drifting behind an opaque
 * floating shell.
 *
 * WHY THIS IS NOT A COLOURFUL THEME. At 56vw across with a 100px blur, an orb
 * has no edge, no shape and no boundary — it reads as coloured light on a grey
 * ground. That is what CLAUDE.md's brand colours become here: atmosphere.
 * Buttons, navigation, tables and forms stay monochrome, which is precisely
 * what makes the two brand colours land when they do appear.
 *
 * WHY IT IS SAFE. Nothing legible is ever placed on this layer. It sits at
 * `z-index: -2` behind an opaque shell, is `aria-hidden`, takes no pointer
 * events, and clips its own overflow so the off-canvas orbs cannot widen the
 * page. No contrast ratio anywhere in the system depends on where an orb has
 * drifted to, which is the only way a moving gradient can be accessible.
 *
 * A SERVER COMPONENT ON PURPOSE. It holds no state and no handler, so it must
 * not be dragged across the `'use client'` boundary (F-25) — every root layout
 * renders it directly, and it costs the client bundle nothing.
 */
export function AmbientBackground() {
  return (
    <div className="bs-ambient" aria-hidden="true" data-testid="ambient-background">
      <div
        className="bs-orb"
        style={{
          inlineSize: ambientTokens.size,
          blockSize: ambientTokens.size,
          background: ambientTokens.purple,
          opacity: ambientTokens.purpleOpacity,
          insetInlineStart: ambientTokens.purpleInsetInline,
          insetBlockStart: ambientTokens.purpleInsetBlock,
        }}
      />
      <div
        className="bs-orb"
        style={{
          inlineSize: ambientTokens.size,
          blockSize: ambientTokens.size,
          background: ambientTokens.yellow,
          opacity: ambientTokens.yellowOpacity,
          insetInlineEnd: ambientTokens.yellowInsetInline,
          insetBlockEnd: ambientTokens.yellowInsetBlock,
          animationDelay: '-7s',
        }}
      />
      {/* The third orb sits INSIDE the viewport, which is what puts warm light
          behind the middle of a translucent shell rather than only at a corner. */}
      <div
        className="bs-orb"
        style={{
          inlineSize: ambientTokens.size,
          blockSize: ambientTokens.size,
          background: ambientTokens.blush,
          opacity: ambientTokens.blushOpacity,
          insetInlineEnd: ambientTokens.blushInsetInline,
          insetBlockStart: ambientTokens.blushInsetBlock,
          animationDelay: '-11s',
        }}
      />
    </div>
  );
}
