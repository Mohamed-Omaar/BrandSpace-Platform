import type { ReactNode } from 'react';

/**
 * THE PROTOTYPE'S OWN GLYPHS (D-468), transcribed from
 * `docs/visual-reference/prototype-2026-09-27/Main.dc.html`: the rail at lines
 * 103–128, the top bar at 151–167, the Create menu's `menuItems` at 2235–2240.
 *
 * Every one is a 24×24 viewBox stroked in `currentColor`, round caps and joins,
 * drawn at the size and stroke width the prototype gives it — 18px at 1.75 in
 * the rail and the top bar, 16px at 2 or 2.25 for the small controls. They are
 * decorative: the control that holds one carries the name.
 */

type Glyph =
  | 'home'
  | 'brain'
  | 'strategy'
  | 'campaigns'
  | 'posts'
  | 'media'
  | 'approvals'
  | 'calendar'
  | 'publishing'
  | 'performance'
  | 'automations'
  | 'notes'
  | 'team'
  | 'settings'
  | 'notifications'
  | 'chevron'
  | 'plus'
  | 'down'
  | 'more'
  | 'spark'
  | 'upload';

const PATHS: Record<Glyph, ReactNode> = {
  home: (
    <>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5.5 9.5V20a1 1 0 0 0 1 1H10v-6h4v6h3.5a1 1 0 0 0 1-1V9.5" />
    </>
  ),
  brain: <path d="M12 3.5 13.6 9l5.4 1.6-5.4 1.6L12 17.5l-1.6-5.3L5 10.6 10.4 9z" />,
  strategy: (
    <>
      <circle cx="5.5" cy="6" r="2.5" />
      <circle cx="18.5" cy="18" r="2.5" />
      <path d="M8 6h6.5a3.5 3.5 0 0 1 0 7h-5a3.5 3.5 0 0 0 0 7H16" />
    </>
  ),
  campaigns: (
    <>
      <path d="M5 21V4" />
      <path d="M5 5h11.5l-1.75 3.5L16.5 12H5" />
    </>
  ),
  posts: (
    <>
      <path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3Z" />
      <path d="M14.5 6.5 17.5 9.5" />
    </>
  ),
  media: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <circle cx="8.75" cy="9.75" r="1.5" />
      <path d="m4 16.5 4.5-4 4 3.5 3-2.5 4.5 4" />
    </>
  ),
  approvals: <path d="m4.5 12.5 5 5 10-11" />,
  calendar: (
    <>
      <rect x="3.25" y="5" width="17.5" height="16" rx="2" />
      <path d="M3.25 9.5h17.5M8 3v4M16 3v4" />
    </>
  ),
  publishing: (
    <>
      <path d="M20.5 3.5 10.75 13.25" />
      <path d="M20.5 3.5 14.25 20.5l-3.5-7.25L3.5 9.75z" />
    </>
  ),
  performance: <path d="M2.5 12h4l2.5-6.5 4.5 13 2.5-6.5h5.5" />,
  automations: (
    <>
      <path d="M5 21v-7M5 10V3M12 21v-11M12 6V3M19 21v-4M19 13V3" />
      <path d="M2.5 14h5M9.5 10h5M16.5 17h5" />
    </>
  ),
  notes: <path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4A8 8 0 1 1 20 12z" />,
  team: (
    <>
      <circle cx="9" cy="8" r="3.25" />
      <path d="M3.5 19.5c.6-3 2.9-4.75 5.5-4.75s4.9 1.75 5.5 4.75" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M15.5 14.4c2.6-.2 4.4 1.4 5 4.1" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6" />
    </>
  ),
  notifications: (
    <>
      <path d="M6.5 10a5.5 5.5 0 0 1 11 0c0 3.5.9 5.2 1.75 6.25H4.75C5.6 15.2 6.5 13.5 6.5 10z" />
      <path d="M10 19.5a2.25 2.25 0 0 0 4 0" />
    </>
  ),
  chevron: <path d="m14.5 6-6 6 6 6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  down: <path d="m6 9 6 6 6-6" />,
  more: null,
  spark: <path d="M12 3.5 13.6 9l5.4 1.6-5.4 1.6L12 17.5l-1.6-5.3L5 10.6 10.4 9z" />,
  upload: (
    <>
      <path d="M12 16V4" />
      <path d="M7 9l5-5 5 5" />
      <path d="M4 20h16" />
    </>
  ),
};

export type PrototypeGlyph = Glyph;

/** One prototype glyph. `size` and `stroke` default to the rail's 18px at 1.75. */
export function PrototypeIcon({
  glyph,
  size = 18,
  stroke = 1.75,
  style,
}: {
  readonly glyph: Glyph;
  readonly size?: number;
  readonly stroke?: number;
  readonly style?: React.CSSProperties;
}) {
  if (glyph === 'more') {
    // The user card's `⋮`: three filled dots, `r=1.6` at y 5.5 / 12 / 18.5.
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <circle cx="12" cy="5.5" r="1.6" />
        <circle cx="12" cy="12" r="1.6" />
        <circle cx="12" cy="18.5" r="1.6" />
      </svg>
    );
  }
  if (glyph === 'spark' && stroke === 0) {
    // Filled, as on the Copilot button and the "AI suggestion" pill.
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        {PATHS.spark}
      </svg>
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={style}
    >
      {PATHS[glyph]}
    </svg>
  );
}
