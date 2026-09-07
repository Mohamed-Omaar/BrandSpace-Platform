import type { CSSProperties, ReactNode } from 'react';
import { colorTokens, radiusTokens, spacingTokens, typographyTokens } from './tokens';
import { scrollContainerStyle } from './a11y';
import { ChevronEndIcon, ChevronStartIcon, SearchIcon } from './icons';
import { CONTROL_CLASS, inputStyle } from './primitives';

/**
 * Tabular data, badges, and the controls that sit above a table.
 *
 * TWO REPRESENTATIONS OF THE SAME DATA. A table is the right shape on a wide
 * screen and the wrong one at 390px, where it either overflows the page or
 * shrinks columns past legibility. `DataTable` scrolls inside its own box; for
 * the phone, `RecordList` renders the same rows as labelled cards. Which one
 * shows is a CSS decision the caller makes, so the markup stays semantic in
 * both.
 */

/**
 * A table that scrolls inside its own container rather than scrolling the page.
 *
 * `tabIndex={0}` because a region that scrolls with a mouse must also scroll
 * with a keyboard, or its content is unreachable without a pointer (WCAG
 * 2.1.1). `scrollContainerStyle()` also establishes a containing block, so an
 * absolutely-positioned descendant — a visually-hidden label, say — is clipped
 * here instead of extending the document (D-48).
 */
export function DataTable({
  headers,
  caption,
  children,
  minWidth = '40rem',
  testId,
}: {
  readonly headers: readonly string[];
  /** Announced to screen readers; the table's accessible name. */
  readonly caption?: string | undefined;
  readonly children: ReactNode;
  readonly minWidth?: string;
  readonly testId?: string | undefined;
}) {
  return (
    <div
      tabIndex={0}
      role="group"
      aria-label={caption}
      style={{
        ...scrollContainerStyle(),
        // A soft container, not a bordered box: the surface and the radius say
        // "this is a table" without drawing a frame around it (D-54).
        borderRadius: radiusTokens.lg,
        background: colorTokens.surface,
      }}
    >
      <table
        data-testid={testId}
        style={{
          inlineSize: '100%',
          borderCollapse: 'collapse',
          minInlineSize: minWidth,
          ...typographyTokens.bodySm,
          textAlign: 'start',
        }}
      >
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header} scope="col" style={thStyle()}>
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/**
 * A table row that responds to the pointer.
 *
 * `bs-row` supplies the hover fill from `tokens.css`; `selected` marks a row
 * with a lavender surface AND `aria-selected`, so the state is never carried by
 * colour alone.
 */
export function Row({
  children,
  selected = false,
  testId,
}: {
  readonly children: ReactNode;
  readonly selected?: boolean;
  readonly testId?: string | undefined;
}) {
  return (
    <tr
      className="bs-row"
      data-testid={testId}
      aria-selected={selected || undefined}
      style={selected ? { background: colorTokens.surfaceLavender } : undefined}
    >
      {children}
    </tr>
  );
}

export function thStyle(): CSSProperties {
  return {
    // `start`, not `left`, so Arabic mirrors.
    textAlign: 'start',
    paddingBlock: spacingTokens.sm,
    paddingInline: spacingTokens.md,
    // No filled header band and no grid: one hairline under the header row is
    // all the separation a column heading needs.
    background: 'transparent',
    borderBlockEnd: `1px solid ${colorTokens.hairline}`,
    color: colorTokens.textMuted,
    ...typographyTokens.caption,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    whiteSpace: 'nowrap',
  };
}

export function tdStyle(): CSSProperties {
  return {
    paddingBlock: spacingTokens.md,
    paddingInline: spacingTokens.md,
    // A row separator, not a cell grid. Vertical rules are what made the old
    // tables read as a spreadsheet.
    borderBlockEnd: `1px solid ${colorTokens.hairline}`,
    verticalAlign: 'middle',
    color: colorTokens.textPrimary,
  };
}

export function Cell({
  children,
  ...rest
}: { readonly children: ReactNode } & Record<string, unknown>) {
  return (
    <td style={tdStyle()} {...rest}>
      {children}
    </td>
  );
}

/**
 * The same rows as `DataTable`, shaped for a phone.
 *
 * Each record is a card of label/value pairs, so a column header that was a
 * `<th>` becomes a visible label rather than disappearing — which is what makes
 * the mobile view readable rather than a table with the headings cut off.
 */
export function RecordList({
  records,
  actionsLabel,
  testId,
}: {
  readonly records: ReadonlyArray<{
    readonly id: string;
    readonly title: ReactNode;
    readonly fields: ReadonlyArray<{ readonly label: string; readonly value: ReactNode }>;
    readonly actions?: ReactNode;
  }>;
  readonly actionsLabel?: string | undefined;
  readonly testId?: string | undefined;
}) {
  return (
    <ul
      data-testid={testId}
      style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: spacingTokens.sm }}
    >
      {records.map((record) => (
        <li
          key={record.id}
          className="bs-liftable"
          style={{
            borderRadius: radiusTokens.lg,
            // A soft filled card, not an outlined record. Same data, shaped for
            // a thumb rather than a cursor.
            background: colorTokens.surfaceSoft,
            padding: spacingTokens.md,
            display: 'grid',
            gap: spacingTokens.sm,
          }}
        >
          <div style={{ ...typographyTokens.h3, color: colorTokens.textPrimary }}>
            {record.title}
          </div>
          <dl style={{ margin: 0, display: 'grid', gap: spacingTokens.xs }}>
            {record.fields.map((field) => (
              <div
                key={field.label}
                style={{ display: 'flex', gap: spacingTokens.sm, justifyContent: 'space-between' }}
              >
                <dt style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
                  {field.label}
                </dt>
                <dd style={{ margin: 0, ...typographyTokens.caption, textAlign: 'end' }}>
                  {field.value}
                </dd>
              </div>
            ))}
          </dl>
          {record.actions ? (
            <div
              aria-label={actionsLabel}
              style={{ display: 'flex', flexWrap: 'wrap', gap: spacingTokens.xs }}
            >
              {record.actions}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'accent';

/**
 * Status badge.
 *
 * THE WORD IS THE LABEL. Colour is a second signal, never the only one, so the
 * meaning survives greyscale, colour-blindness and a monochrome print (WCAG
 * 1.4.1). `accent` is the yellow tone — a tinted surface with near-black ink,
 * never white text on yellow.
 */
export function StatusBadge({
  label,
  tone = 'neutral',
  dot = false,
  testId,
}: {
  readonly label: string;
  readonly tone?: BadgeTone;
  /** A small dot before the label. Decoration; the word is still the label. */
  readonly dot?: boolean;
  readonly testId?: string | undefined;
}) {
  const palette = badgePalette(tone);
  return (
    <span
      data-testid={testId}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: spacingTokens.xs,
        paddingInline: spacingTokens.sm,
        paddingBlock: spacingTokens['2xs'],
        borderRadius: radiusTokens.full,
        ...typographyTokens.caption,
        fontWeight: 600,
        whiteSpace: 'nowrap',
        background: palette.background,
        color: palette.color,
        // No resting stroke: the fill and the WORD carry the meaning, and the
        // word survives greyscale and colour-blindness (WCAG 1.4.1).
        border: '1px solid transparent',
      }}
    >
      {dot ? (
        <span
          aria-hidden="true"
          style={{
            inlineSize: '0.375rem',
            blockSize: '0.375rem',
            borderRadius: radiusTokens.full,
            background: palette.color,
            flexShrink: 0,
          }}
        />
      ) : null}
      {label}
    </span>
  );
}

function badgePalette(tone: BadgeTone): { background: string; color: string; border: string } {
  switch (tone) {
    case 'success':
      return {
        background: colorTokens.successTint,
        color: colorTokens.success,
        border: colorTokens.successBorder,
      };
    case 'warning':
      return {
        background: colorTokens.warningTint,
        color: colorTokens.warning,
        border: colorTokens.warningBorder,
      };
    case 'danger':
      return {
        background: colorTokens.dangerTint,
        color: colorTokens.danger,
        border: colorTokens.dangerBorder,
      };
    case 'info':
      return {
        background: colorTokens.infoTint,
        color: colorTokens.info,
        border: colorTokens.infoBorder,
      };
    case 'accent':
      // Yellow as an accent surface: near-black ink at 15.3:1. Never white.
      return {
        background: colorTokens.brandYellowTint,
        color: colorTokens.brandYellowText,
        border: colorTokens.brandYellow,
      };
    case 'neutral':
      return {
        background: colorTokens.surfaceMuted,
        color: colorTokens.textSecondary,
        border: colorTokens.border,
      };
  }
}

/**
 * Map a lifecycle status to a tone, once.
 *
 * Exported so the customer application and the Control Center cannot disagree
 * about what ACTIVE looks like — which they did before this phase.
 */
export function statusTone(status: string): BadgeTone {
  switch (status) {
    case 'ACTIVE':
    case 'ACCEPTED':
    case 'PUBLISHED':
      return 'success';
    case 'SUSPENDED':
    case 'REVOKED':
    case 'EXPIRED':
    case 'CANCELLED':
    case 'FAILED':
      return 'danger';
    case 'TRIALING':
    case 'PENDING':
    case 'PAST_DUE':
    case 'SCHEDULED':
      return 'warning';
    case 'ARCHIVED':
    case 'DRAFT':
      return 'neutral';
    default:
      return 'neutral';
  }
}

/** A search box with a real label, visible or hidden. */
export function SearchField({
  id,
  label,
  placeholder,
  defaultValue,
  name = 'q',
}: {
  readonly id: string;
  readonly label: string;
  readonly placeholder?: string | undefined;
  readonly defaultValue?: string | undefined;
  readonly name?: string;
}) {
  return (
    /*
      `.search-field { min-width: 240px; height: 36px; border-radius: 11px }` —
      a control in a toolbar, not a full-width band. `flex: 1 1 14rem` let it
      swallow every spare pixel of the calendar's toolbar, which the demo's
      does not.
    */
    <div style={{ position: 'relative', flex: '0 1 15rem', minInlineSize: '15rem' }}>
      <label htmlFor={id} style={visuallyHiddenLabel()}>
        {label}
      </label>
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          insetInlineStart: spacingTokens.sm,
          insetBlockStart: '50%',
          transform: 'translateY(-50%)',
          color: colorTokens.textMuted,
          display: 'inline-flex',
          pointerEvents: 'none',
        }}
      >
        <SearchIcon size={18} />
      </span>
      <input
        id={id}
        name={name}
        type="search"
        defaultValue={defaultValue}
        placeholder={placeholder}
        className={CONTROL_CLASS}
        style={{ ...inputStyle(), paddingInlineStart: '2.5rem' }}
      />
    </div>
  );
}

function visuallyHiddenLabel(): CSSProperties {
  return {
    position: 'absolute',
    inlineSize: '1px',
    blockSize: '1px',
    margin: '-1px',
    padding: 0,
    border: 0,
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
  };
}

/**
 * A toolbar above a table: search, filters and actions on one wrapping row.
 */
export function Toolbar({ children }: { readonly children: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: spacingTokens.sm,
        alignItems: 'center',
        marginBlockEnd: spacingTokens.md,
      }}
    >
      {children}
    </div>
  );
}

/**
 * Pagination as real links.
 *
 * Links, not buttons, so a page is bookmarkable and works without JavaScript —
 * which matters because every list in this product renders on the server.
 * `aria-current="page"` marks the current page for a screen reader.
 */
export function Pagination({
  page,
  pageCount,
  hrefForPage,
  labels,
  testId,
}: {
  readonly page: number;
  readonly pageCount: number;
  readonly hrefForPage: (page: number) => string;
  readonly labels: {
    readonly navigation: string;
    readonly previous: string;
    readonly next: string;
    readonly summary: string;
  };
  readonly testId?: string | undefined;
}) {
  if (pageCount <= 1) return null;
  const linkStyle: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacingTokens.xs,
    minBlockSize: '2rem',
    minInlineSize: '2rem',
    paddingInline: spacingTokens.sm,
    justifyContent: 'center',
    borderRadius: radiusTokens.md,
    background: colorTokens.controlSurface,
    border: '1px solid transparent',
    color: colorTokens.textPrimary,
    textDecoration: 'none',
    ...typographyTokens.caption,
    fontWeight: 600,
  };
  const disabledStyle: CSSProperties = {
    ...linkStyle,
    background: colorTokens.surfaceMuted,
    color: colorTokens.textMuted,
    pointerEvents: 'none',
  };

  return (
    <nav
      aria-label={labels.navigation}
      data-testid={testId ?? 'pagination'}
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: spacingTokens.sm,
        marginBlockStart: spacingTokens.md,
      }}
    >
      <a
        href={hrefForPage(page - 1)}
        rel="prev"
        aria-disabled={page <= 1 ? 'true' : undefined}
        style={page <= 1 ? disabledStyle : linkStyle}
      >
        {/* The chevron is logical: `ChevronStart` points toward the start of the
            inline axis, so it flips with direction rather than pointing the
            wrong way in Arabic. */}
        <ChevronStartIcon size={16} />
        {labels.previous}
      </a>
      <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
        {labels.summary}
      </span>
      <a
        href={hrefForPage(page + 1)}
        rel="next"
        aria-disabled={page >= pageCount ? 'true' : undefined}
        style={page >= pageCount ? disabledStyle : linkStyle}
      >
        {labels.next}
        <ChevronEndIcon size={16} />
      </a>
    </nav>
  );
}

/**
 * Breadcrumbs. An ordered list, because the order is the meaning, with the
 * current page marked and not linked.
 */
export function Breadcrumbs({
  items,
  label,
}: {
  readonly items: ReadonlyArray<{ readonly label: string; readonly href?: string | undefined }>;
  readonly label: string;
}) {
  return (
    <nav aria-label={label} data-testid="breadcrumbs" style={{ marginBlockEnd: spacingTokens.sm }}>
      <ol
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: spacingTokens.xs,
          ...typographyTokens.caption,
          color: colorTokens.textSecondary,
        }}
      >
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          return (
            <li
              key={item.label}
              style={{ display: 'inline-flex', alignItems: 'center', gap: spacingTokens.xs }}
            >
              {item.href && !isLast ? (
                <a href={item.href} style={{ color: colorTokens.textSecondary }}>
                  {item.label}
                </a>
              ) : (
                <span
                  aria-current={isLast ? 'page' : undefined}
                  style={{ color: colorTokens.textPrimary, fontWeight: 600 }}
                >
                  {item.label}
                </span>
              )}
              {!isLast ? (
                <span
                  aria-hidden="true"
                  style={{ color: colorTokens.textMuted, display: 'inline-flex' }}
                >
                  <ChevronEndIcon size={14} />
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
