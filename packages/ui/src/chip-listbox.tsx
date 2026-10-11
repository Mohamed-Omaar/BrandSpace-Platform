'use client';

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useDismissOnOutsidePointer, useOverlayBehaviour } from './overlays';
import { usePresence } from './motion-hooks';

export interface ChipListboxOption {
  readonly value: string;
  readonly label: string;
}

/**
 * PR D (Studio S4 / S5) — A CHIP THAT OPENS THE PROTOTYPE'S GLASS LISTBOX.
 *
 * `Main.dc.html` line 352 (campaign) and line 529 (reviewer): a `.chip` with
 * `aria-haspopup="listbox"` opens a 220px glass panel of `role="option"` rows,
 * the current one lavender (`#f6f3ff`, purple text). The Studio drew native
 * `<select>`s styled as chips instead.
 *
 * A NEW COMPONENT, AND WHY: `DropdownMenu` is a `role="menu"` of actions, and
 * `SearchableSelect` is a text combobox with typing; neither is a single-choice
 * list that keeps a value. This one does only that. Its value travels in a
 * hidden input (`name`, `form`), so a form posts it exactly as the select did.
 *
 * KEYBOARD (WAI-ARIA listbox pattern): ArrowDown / ArrowUp on the chip open
 * the list on the current option; in the list ArrowDown / ArrowUp / Home / End
 * move, Enter or Space chooses, Escape closes and returns to the chip.
 */
export function ChipListbox({
  label,
  name,
  form,
  value,
  options,
  onChoose,
  trigger,
  placement = 'below',
  testId,
}: {
  /** The list's accessible name (the chip shows the value). */
  readonly label: string;
  /** With `name`, a hidden input carries the value into a form. */
  readonly name?: string | undefined;
  readonly form?: string | undefined;
  readonly value: string;
  readonly options: readonly ChipListboxOption[];
  /** Called after the value changes, with the hidden input already holding it. */
  readonly onChoose?: ((value: string, input: HTMLInputElement | null) => void) | undefined;
  /** What the chip shows for the current value; the chevron is added. */
  readonly trigger: ReactNode | ((value: string) => ReactNode);
  /** `above` opens upward — for a chip in the sticky bar (line 529). */
  readonly placement?: 'below' | 'above';
  readonly testId: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState(value);
  const [active, setActive] = useState(0);
  const wrapperRef = useRef<HTMLSpanElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => setCurrent(value), [value]);
  const entry = useOverlayBehaviour({ open, onClose: close, containerRef: listRef, trap: false });
  useDismissOnOutsidePointer(wrapperRef, open, close, entry);
  const { present, leaving } = usePresence(open, listRef);

  const indexOfCurrent = Math.max(
    0,
    options.findIndex((option) => option.value === current),
  );
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelectorAll<HTMLElement>('[role="option"]')[active]?.focus();
  }, [open, active]);

  const choose = (next: string) => {
    setCurrent(next);
    setOpen(false);
    chipRef.current?.focus();
    if (inputRef.current) inputRef.current.value = next;
    if (next !== current) onChoose?.(next, inputRef.current);
  };

  return (
    <span ref={wrapperRef} className="bsp-lbx-wrap">
      <button
        ref={chipRef}
        type="button"
        className="bsp-chip bsp-lbx-chip"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        data-testid={testId}
        data-value={current}
        onClick={() => {
          setActive(indexOfCurrent);
          setOpen((value) => !value);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          setActive(indexOfCurrent);
          setOpen(true);
        }}
      >
        {typeof trigger === 'function' ? trigger(current) : trigger}
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {name ? (
        <input ref={inputRef} type="hidden" name={name} form={form} defaultValue={value} />
      ) : null}
      {present ? (
        <div
          ref={listRef}
          id={id}
          role="listbox"
          aria-label={label}
          className="bsp-lbx bs-pop"
          data-placement={placement}
          data-testid={`${testId}-list`}
          {...(leaving ? { 'data-leaving': '', 'aria-hidden': true, inert: true } : {})}
          onKeyDown={(event) => {
            const last = options.length - 1;
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActive((index) => Math.min(last, index + 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActive((index) => Math.max(0, index - 1));
            } else if (event.key === 'Home') {
              event.preventDefault();
              setActive(0);
            } else if (event.key === 'End') {
              event.preventDefault();
              setActive(last);
            }
          }}
        >
          {options.map((option, index) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === current}
              tabIndex={index === active ? 0 : -1}
              className="bsp-lbx-opt"
              data-testid={`${testId}-option-${option.value || 'none'}`}
              onClick={() => choose(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}
