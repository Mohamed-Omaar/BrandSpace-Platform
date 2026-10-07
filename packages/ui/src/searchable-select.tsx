'use client';

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import { ChevronDownIcon } from './icons';
import { colorTokens, spacingTokens, typographyTokens, zIndexTokens } from './tokens';
import { inputStyle } from './primitives';
import { useOpening, usePresence } from './motion-hooks';

export interface SearchableOption {
  readonly value: string;
  readonly label: string;
  /** What the row shows at its end; the value when absent (a country's code). */
  readonly hint?: string | undefined;
}

/**
 * A searchable single-select that still posts a plain scalar value.
 *
 * Used for long controlled vocabularies such as countries and IANA time zones,
 * where a native select is technically complete but painful to scan. The
 * browser receives only the option value in the hidden form field; free text
 * never becomes stored data.
 */
export function SearchableSelect({
  id,
  name,
  options,
  placeholder,
  noResultsLabel,
  value: controlledValue,
  defaultValue = '',
  onChange,
  required = false,
  disabled = false,
  style,
  testId,
}: {
  readonly id: string;
  readonly name: string;
  readonly options: readonly SearchableOption[];
  readonly placeholder: string;
  readonly noResultsLabel: string;
  readonly value?: string | undefined;
  readonly defaultValue?: string | undefined;
  readonly onChange?: ((value: string) => void) | undefined;
  readonly required?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  readonly style?: CSSProperties | undefined;
  readonly testId?: string | undefined;
}) {
  const listId = useId();
  const [internalValue, setInternalValue] = useState(defaultValue);
  const [query, setQuery] = useState('');
  /*
   * BATCH 7 (A5) — THE LIST OPENS WHOLE. Opening puts the chosen label in the
   * box, and that text used to filter the list down to the one row already
   * chosen ("Riyadh" offered only Riyadh). It filters only once the person
   * types; until then every option is there, the chosen one in view.
   */
  const [typed, setTyped] = useState(false);
  const [open, setOpen] = useState(false);
  // MO5: the list enters when it opens and leaves (180 ms) after it closes.
  const listRef = useRef<HTMLDivElement | null>(null);
  const list = usePresence(open && !disabled, listRef);
  const opening = useOpening(open && !disabled);
  const [activeIndex, setActiveIndex] = useState(0);

  const value = controlledValue ?? internalValue;
  const selected = options.find((option) => option.value === value) ?? null;
  const normalizedQuery = typed ? query.trim().toLocaleLowerCase() : '';
  const filtered = useMemo(
    () =>
      normalizedQuery === ''
        ? options
        : options.filter((option) =>
            `${option.label} ${option.value}`.toLocaleLowerCase().includes(normalizedQuery),
          ),
    [normalizedQuery, options],
  );

  const setValue = (next: string) => {
    if (controlledValue === undefined) setInternalValue(next);
    onChange?.(next);
  };

  const choose = (option: SearchableOption) => {
    setValue(option.value);
    setQuery(option.label);
    setTyped(false);
    setOpen(false);
    setActiveIndex(0);
  };

  // The chosen row is the active one, scrolled into view, as the list opens.
  useEffect(() => {
    if (!open || typed) return;
    const index = selected ? options.indexOf(selected) : -1;
    if (index < 0) return;
    setActiveIndex(index);
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${index}"]`)
      ?.scrollIntoView({ block: 'nearest' });
    // Only on opening: later moves through the list are the person's own.
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((current) => {
        if (filtered.length === 0) return 0;
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        return (current + delta + filtered.length) % filtered.length;
      });
      return;
    }
    if (event.key === 'Enter' && open && filtered[activeIndex]) {
      event.preventDefault();
      choose(filtered[activeIndex]!);
    }
  };

  return (
    <div style={{ position: 'relative', inlineSize: '100%' }}>
      <input type="hidden" name={name} value={value} />
      <input
        id={id}
        className="bs-control"
        data-testid={testId}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-required={required}
        autoComplete="off"
        required={required}
        disabled={disabled}
        value={open ? query : (selected?.label ?? '')}
        placeholder={placeholder}
        onFocus={() => {
          setQuery(selected?.label ?? '');
          setTyped(false);
          setOpen(true);
          setActiveIndex(0);
        }}
        onBlur={() => {
          setOpen(false);
          if (!selected) setQuery('');
        }}
        onChange={(event) => {
          const next = event.target.value;
          setQuery(next);
          setTyped(true);
          setOpen(true);
          setActiveIndex(0);
          if (selected && next !== selected.label) setValue('');
        }}
        onKeyDown={onKeyDown}
        style={{
          ...inputStyle({ size: 'lg' }),
          paddingInlineEnd: '2.75rem',
          ...style,
        }}
      />
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          insetInlineEnd: '1rem',
          insetBlockStart: '50%',
          transform: 'translateY(-50%)',
          display: 'inline-flex',
          color: colorTokens.textMuted,
          pointerEvents: 'none',
        }}
      >
        <ChevronDownIcon size={16} />
      </span>

      {list.present ? (
        <div
          id={listId}
          ref={listRef}
          role="listbox"
          className={`bs-dropdown-panel${opening ? ' bs-pop' : ''}`}
          {...(list.leaving ? { 'data-leaving': '', 'aria-hidden': true, inert: true } : {})}
          style={{
            position: 'absolute',
            insetInline: 0,
            insetBlockStart: 'calc(100% + 0.375rem)',
            zIndex: zIndexTokens.overlay,
            maxBlockSize: '18rem',
          }}
          onMouseDown={(event) => event.preventDefault()}
        >
          {filtered.length === 0 ? (
            <p
              style={{
                margin: 0,
                padding: spacingTokens.sm,
                ...typographyTokens.bodySm,
                color: colorTokens.textMuted,
              }}
            >
              {noResultsLabel}
            </p>
          ) : (
            filtered.map((option, index) => (
              <button
                key={option.value}
                type="button"
                role="option"
                data-index={index}
                aria-selected={option.value === value}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(option)}
                className="bs-dropdown-option"
                data-active={index === activeIndex ? 'true' : undefined}
                style={{
                  display: 'flex',
                  inlineSize: '100%',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: spacingTokens.sm,
                  border: 0,
                  color: colorTokens.textPrimary,
                  fontFamily: 'inherit',
                  ...typographyTokens.bodySm,
                  textAlign: 'start',
                  cursor: 'pointer',
                }}
              >
                <span>{option.label}</span>
                <span style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}>
                  {option.hint ?? option.value}
                </span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
