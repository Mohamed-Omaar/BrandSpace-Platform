import type { CSSProperties, SVGProps } from 'react';

/**
 * ONE icon family, drawn in this repository.
 *
 * WHY NOT A LIBRARY. The brief allows introducing a lightweight icon library
 * "only if necessary". It is not: the surfaces in this phase need roughly two
 * dozen glyphs, and a dependency would bring thousands, a bundle cost, a
 * supply-chain surface and a second visual language whose stroke weight and
 * corner radius nobody controls. These are drawn to one specification — 24×24
 * box, 1.75 stroke, round caps and joins, no fills — so they sit together.
 *
 * ACCESSIBILITY. Every icon is `aria-hidden` and `focusable="false"` BY
 * DEFAULT, because an icon beside a label is decoration and announcing it
 * twice is worse than not announcing it. An icon that is the ONLY content of a
 * control gets its name from the control (`aria-label` on the button), never
 * from the SVG — that is what `IconButton` and the collapsed sidebar do.
 *
 * `currentColor` throughout, so an icon inherits the colour of whatever it sits
 * in and no icon carries a colour literal.
 */

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  /** Edge length in CSS pixels. 16 for inline, 20 for controls, 24 for nav. */
  readonly size?: number;
  readonly title?: string | undefined;
  readonly style?: CSSProperties | undefined;
}

function Icon({ size = 20, title, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      // Decoration unless the caller supplies a title. A control that is icon-
      // only names itself on the BUTTON, not here.
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

/* ------------------------------------------------------------------------ */
/* Navigation                                                                */
/* ------------------------------------------------------------------------ */

export function HomeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5.5 9.5V20a1 1 0 0 0 1 1H10v-6h4v6h3.5a1 1 0 0 0 1-1V9.5" />
    </Icon>
  );
}

export function TeamIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="9" cy="8" r="3.25" />
      <path d="M2.75 20a6.25 6.25 0 0 1 12.5 0" />
      <path d="M16.5 5.5a3.25 3.25 0 0 1 0 6" />
      <path d="M17.5 14.25A6.25 6.25 0 0 1 21.25 20" />
    </Icon>
  );
}

export function ShieldIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3l7 2.5v5.75c0 4.5-2.9 8.05-7 9.75-4.1-1.7-7-5.25-7-9.75V5.5z" />
      <path d="m9 12 2 2 4-4" />
    </Icon>
  );
}

export function CreditIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.75" y="5.5" width="18.5" height="13" rx="2" />
      <path d="M2.75 10h18.5" />
      <path d="M6.5 14.75h3.5" />
    </Icon>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 14.5a1.5 1.5 0 0 0 .3 1.65l.05.05a1.8 1.8 0 1 1-2.55 2.55l-.05-.05a1.5 1.5 0 0 0-2.55 1.06V20a1.8 1.8 0 1 1-3.6 0v-.1a1.5 1.5 0 0 0-2.6-1.02l-.05.05A1.8 1.8 0 1 1 5.8 16.4l.05-.05A1.5 1.5 0 0 0 4.8 13.8H4.6a1.8 1.8 0 1 1 0-3.6h.1a1.5 1.5 0 0 0 1.02-2.6l-.05-.05A1.8 1.8 0 1 1 8.22 5l.05.05a1.5 1.5 0 0 0 1.65.3h.08a1.5 1.5 0 0 0 .9-1.37V3.8a1.8 1.8 0 1 1 3.6 0v.1a1.5 1.5 0 0 0 2.6 1.02l.05-.05A1.8 1.8 0 1 1 19.7 7.4l-.05.05a1.5 1.5 0 0 0-.3 1.65v.08a1.5 1.5 0 0 0 1.37.9h.18a1.8 1.8 0 1 1 0 3.6H20.8a1.5 1.5 0 0 0-1.37.9z" />
    </Icon>
  );
}

export function BuildingIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 21V5.5a1.5 1.5 0 0 1 1.5-1.5h7A1.5 1.5 0 0 1 14 5.5V21" />
      <path d="M14 10h4.5A1.5 1.5 0 0 1 20 11.5V21" />
      <path d="M2.5 21h19" />
      <path d="M7.5 8h3M7.5 12h3M7.5 16h3M17 14h0M17 17.5h0" />
    </Icon>
  );
}

export function LifebuoyIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3.75" />
      <path d="m5.6 5.6 3.75 3.75M14.65 14.65l3.75 3.75M18.4 5.6l-3.75 3.75M9.35 14.65 5.6 18.4" />
    </Icon>
  );
}

export function SlidersIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 21v-7M5 10V3M12 21v-11M12 6V3M19 21v-4M19 13V3" />
      <path d="M2.5 14h5M9.5 10h5M16.5 17h5" />
    </Icon>
  );
}

export function KeyIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="4.25" />
      <path d="m11 11 8.5 8.5" />
      <path d="m17 17 2-2M14.5 14.5l1.5-1.5" />
    </Icon>
  );
}

export function FlagIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 21V4" />
      <path d="M5 5h11.5l-1.75 3.5L16.5 12H5" />
    </Icon>
  );
}

export function LayersIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m12 3 8.5 4.5L12 12 3.5 7.5z" />
      <path d="m3.5 12 8.5 4.5 8.5-4.5" />
      <path d="m3.5 16.5 8.5 4.5 8.5-4.5" />
    </Icon>
  );
}

export function SparkIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3.5 13.6 9l5.4 1.6-5.4 1.6L12 17.5l-1.6-5.3L5 10.6 10.4 9z" />
      <path d="M18.5 16.5l.6 1.9 1.9.6-1.9.6-.6 1.9-.6-1.9-1.9-.6 1.9-.6z" />
    </Icon>
  );
}

export function RouteIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="5.5" cy="6" r="2.5" />
      <circle cx="18.5" cy="18" r="2.5" />
      <path d="M8 6h6.5A3.5 3.5 0 0 1 18 9.5v0a3.5 3.5 0 0 1-3.5 3.5h-5A3.5 3.5 0 0 0 6 16.5v0A3.5 3.5 0 0 0 9.5 20H16" />
    </Icon>
  );
}

/**
 * Integrations — a plug, because that is what an owner is doing here.
 *
 * Drawn in the same 24-grid, 1.5-stroke, round-cap language as every icon in
 * this file. A new visual treatment for one nav item is how an icon set starts
 * to look like two.
 */
export function PlugIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 3v5M15 3v5" />
      <path d="M6.5 8h11v2.5a5.5 5.5 0 0 1-5.5 5.5v0a5.5 5.5 0 0 1-5.5-5.5z" />
      <path d="M12 16v5" />
    </Icon>
  );
}

export function ListIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8.5 6.5h12M8.5 12h12M8.5 17.5h12" />
      <path d="M3.75 6.5h0M3.75 12h0M3.75 17.5h0" />
    </Icon>
  );
}

export function PulseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 12h4l2.5-6.5 4.5 13 2.5-6.5h5.5" />
    </Icon>
  );
}

/* ------------------------------------------------------------------------ */
/* Controls                                                                  */
/* ------------------------------------------------------------------------ */

export function MenuIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 6.5h17M3.5 12h17M3.5 17.5h17" />
    </Icon>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m6 6 12 12M18 6 6 18" />
    </Icon>
  );
}

/*
 * THE TWO LOGICAL CHEVRONS, and why they need a class.
 *
 * "Start" and "End" are directions on the INLINE axis, so in Arabic the start
 * chevron must point right. An SVG path cannot know that — the glyph below is
 * drawn pointing left, which is correct in English and backwards in Arabic.
 * The components that use these (pagination, the sidebar collapse toggle, the
 * calendar's month stepper) all documented the flip as though it happened; it
 * did not, and an Arabic reader saw "previous" pointing forwards.
 *
 * `.bs-chevron-logical` is what makes the claim true: `tokens.css` mirrors it
 * under `[dir='rtl']`. Merged rather than overwritten, so a caller's own class
 * still arrives.
 */
const LOGICAL_CHEVRON = 'bs-chevron-logical';

function logicalChevronProps(props: IconProps): IconProps {
  return {
    ...props,
    className: props.className ? `${props.className} ${LOGICAL_CHEVRON}` : LOGICAL_CHEVRON,
  };
}

export function ChevronStartIcon(props: IconProps) {
  return (
    <Icon {...logicalChevronProps(props)}>
      <path d="m14.5 5-6 7 6 7" />
    </Icon>
  );
}

export function ChevronEndIcon(props: IconProps) {
  return (
    <Icon {...logicalChevronProps(props)}>
      <path d="m9.5 5 6 7-6 7" />
    </Icon>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m5 9 7 6 7-6" />
    </Icon>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 4.5 4.5" />
    </Icon>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m4.5 12.5 5 5 10-11" />
    </Icon>
  );
}

export function AlertIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 4 2.75 20h18.5z" />
      <path d="M12 10v4M12 17h0" />
    </Icon>
  );
}

export function InfoIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5M12 7.75h0" />
    </Icon>
  );
}

export function GlobeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c2.5 2.6 3.75 5.6 3.75 9S14.5 18.4 12 21c-2.5-2.6-3.75-5.6-3.75-9S9.5 5.6 12 3z" />
    </Icon>
  );
}

export function UserIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M4.75 20a7.25 7.25 0 0 1 14.5 0" />
    </Icon>
  );
}

export function BellIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6.5 10a5.5 5.5 0 0 1 11 0c0 3.5.9 5.2 1.75 6.25H4.75C5.6 15.2 6.5 13.5 6.5 10z" />
      <path d="M10 19.5a2.25 2.25 0 0 0 4 0" />
    </Icon>
  );
}

/**
 * A speech bubble — the Notes entry in the customer top bar (P6-16).
 *
 * DRAWN, NOT BORROWED, and recorded as the one new glyph the top bar needed
 * (CLAUDE.md §4.2 rule 4): the family had no mark for "a conversation", and
 * reusing `SendIcon` or `PencilIcon` would say "publish" or "edit" to the
 * person looking for their colleagues' notes. Same box, stroke and caps as
 * every other icon here.
 */
export function NoteIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5h-7.5L7 20.5V17H5a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5z" />
      <path d="M8 10h8M8 13h5" />
    </Icon>
  );
}

export function SendIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20.5 3.5 10.75 13.25" />
      <path d="M20.5 3.5 14.25 20.5l-3.5-7.25L3.5 9.75z" />
    </Icon>
  );
}

export function PaperclipIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20 11.5 12.3 19.2a4.6 4.6 0 0 1-6.5-6.5l7.7-7.7a3 3 0 0 1 4.3 4.3l-7.7 7.7a1.5 1.5 0 0 1-2.1-2.1l7-7" />
    </Icon>
  );
}

/** The Content Studio: a pen, for the module that writes. */
export function PencilIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3Z" />
      <path d="M14.5 6.5 17.5 9.5" />
    </Icon>
  );
}

export function ImageIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <circle cx="8.75" cy="9.75" r="1.5" />
      <path d="m4 16.5 4.5-4 4 3.5 3-2.5 4.5 4" />
    </Icon>
  );
}

/**
 * A TAG — the Brand Selector's glyph.
 *
 * Drawn in the same 24-unit box, the same stroke and the same joinery as every
 * other icon in this file, because §4.2 rule 5 forbids a second icon style and a
 * borrowed glyph is exactly how one starts. A tag rather than a swatch or a
 * palette: a brand here is an IDENTITY APPLIED TO WORK, not a colour.
 */
export function TagIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M11.2 3.5H19a1.5 1.5 0 0 1 1.5 1.5v7.8a2 2 0 0 1-.6 1.4l-6.7 6.7a1.5 1.5 0 0 1-2.1 0l-7-7a1.5 1.5 0 0 1 0-2.1l6.7-6.7a2 2 0 0 1 1.4-.6Z" />
      <circle cx="16" cy="8" r="1.4" />
    </Icon>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M10 8.5 16 12l-6 3.5z" />
    </Icon>
  );
}

export function CalendarIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.25" y="5" width="17.5" height="16" rx="2" />
      <path d="M3.25 9.5h17.5M8 3v4M16 3v4" />
    </Icon>
  );
}

export function LockIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
      <path d="M8 10.5V7.75a4 4 0 0 1 8 0v2.75" />
    </Icon>
  );
}

/** Leaving the workspace: a door with an arrow going out through it. */
export function SignOutIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M14.5 4.5h3a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-3" />
      <path d="M10 8.5 6 12l4 3.5" />
      <path d="M6 12h8.5" />
    </Icon>
  );
}

export function EmptyBoxIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 8.5 12 4l9 4.5v7L12 20l-9-4.5z" />
      <path d="M3 8.5 12 13l9-4.5M12 13v7" />
    </Icon>
  );
}
