import Link from 'next/link';
import { buttonClass, buttonStyle } from '@brandspace/ui';

/**
 * THE "WHAT CAN I DO NOW" OF AN EMPTY STATE (Phase 6 final, D-277 §43, D-299).
 *
 * `StateMessage` has always taken an `action`; almost no screen passed one, so
 * an empty panel said what was missing and stopped. This is the one shape
 * those actions take: a link to a screen that already exists, as a small
 * button, gated by the caller on the permission that screen asks for.
 */
export function EmptyAction({
  href,
  label,
  testId,
  tone = 'brand',
}: {
  readonly href: string;
  readonly label: string;
  readonly testId: string;
  readonly tone?: 'brand' | 'neutral' | 'ghost';
}) {
  return (
    <Link
      href={href}
      className={buttonClass(tone)}
      style={buttonStyle(tone, 'sm')}
      data-testid={testId}
    >
      {label}
    </Link>
  );
}
