'use client';

import type { ButtonHTMLAttributes, ComponentProps, CSSProperties, ReactNode } from 'react';
import { Button, Spinner } from '@brandspace/ui';
import { useFormStatus } from 'react-dom';

/**
 * Batch 7 PR C (2d) — A SUBMIT BUTTON THAT SAYS IT IS WORKING. The sign-up
 * button had no pending state, so a second press while the first was on its
 * way sent a second email. While its form is being sent it is disabled and
 * reads `pendingLabel`.
 */
export function PendingSubmit({
  label,
  pendingLabel,
  style,
  testId,
  disabled = false,
}: {
  readonly label: ReactNode;
  readonly pendingLabel: ReactNode;
  readonly style?: CSSProperties;
  readonly testId?: string;
  readonly disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      style={style}
      disabled={pending || disabled}
      aria-busy={pending || undefined}
      data-testid={testId}
    >
      {pending ? pendingLabel : label}
    </button>
  );
}

/**
 * P1 — EVERY BUTTON THAT WAITS FOR THE SERVER SAYS SO. A drop-in for a form's
 * `<button type="submit">`: at rest it is exactly that button (the same
 * element, classes and content, so nothing on the screen moves); while the
 * form's server action runs it is disabled, announces `aria-busy` and draws
 * the shared spinner before its label.
 */
export function SubmitButton({
  children,
  className,
  pendingLabel,
  disabled,
  ...button
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> & {
  readonly children?: ReactNode;
  /** Replaces the label while waiting, when the screen has a word for it. */
  readonly pendingLabel?: ReactNode;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      {...button}
      className={className}
      type="submit"
      disabled={disabled === true || pending}
      aria-busy={pending || undefined}
      data-pending={pending || undefined}
    >
      {pending ? <Spinner /> : null}
      {pending && pendingLabel !== undefined ? pendingLabel : children}
    </button>
  );
}

/**
 * P1 — the same, for a submit built with the design system's `Button`: its own
 * `loading` state (spinner, disabled, `aria-busy`) while the form's server
 * action runs.
 */
export function FormButton(props: Omit<ComponentProps<typeof Button>, 'type' | 'loading'>) {
  const { pending } = useFormStatus();
  return <Button {...props} type="submit" loading={pending} />;
}
