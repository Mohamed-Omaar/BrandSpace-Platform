import type { CSSProperties, ReactNode } from 'react';
import { StatusBadge, scrollContainerStyle, statusTone } from '@brandspace/ui';

/**
 * Control Center primitives — now a THIN ADAPTER over `@brandspace/ui`.
 *
 * Before Phase 2C this file and the customer dashboard's `workspace-shell`
 * implemented the same eight primitives twice, and they had already diverged:
 * different input widths, different table borders, one with a `Field` component
 * and one without, one table keyboard-scrollable and the other not. The design
 * system is now the single implementation; this file only maps the console's
 * existing names onto it so the migration is incremental rather than a
 * twenty-file rewrite in one commit (Phase 2C-B finishes the job).
 */

export {
  Banner,
  Card,
  Field,
  StateMessage,
  StatusBadge,
  Toolbar,
  scrollContainerStyle,
} from '@brandspace/ui';

/** A table that scrolls inside its own box rather than the page. */
export { DataTable, Cell } from '@brandspace/ui';

/** A wide block that scrolls inside its own box rather than scrolling the page. */
export function TableScroll({ children }: { children: ReactNode }) {
  return <div style={scrollContainerStyle()}>{children}</div>;
}

/**
 * The Control Center's field width. The field itself is `.bs-control` (S5: its
 * geometry is the class's, no longer an inline style); a console form keeps
 * its fields to a readable 28rem.
 */
export function inputStyle(): CSSProperties {
  return { maxInlineSize: '28rem' };
}

/**
 * Status pill.
 *
 * Colour is never the only carrier: the status word itself is the label, so the
 * meaning survives greyscale and colour-blindness (WCAG 1.4.1). The tone map
 * now lives in the design system, so the customer application and the Control
 * Center cannot disagree about what ACTIVE looks like — which they did.
 */
export function StatusPill({ status }: { status: string }) {
  return <StatusBadge label={status} tone={statusTone(status)} testId={`status-${status}`} />;
}
