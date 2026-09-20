'use client';

import {
  useId,
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import { ChevronDownIcon } from './icons';
import {
  colorTokens,
  radiusTokens,
  shadowTokens,
  spacingTokens,
  typographyTokens,
  zIndexTokens,
} from './tokens';
import { inputStyle } from './primitives';

export interface SearchableOption {
  readonly value: string;
  readonly label: string;
}

/**
 * A searchable single-select that posts only a canonical option value.
 *
 * Long controlled vocabularies such as countries and IANA time zones should be
 * searchable without turning into free-text storage. The visible input is only
 * a filter; the hidden field carries the selected option's value.
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
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const value = controlledValue ?? internalValue;
  const selected = options.find((option) => option.value === value) ?? null;
  const normalizedQuery = query.trim().toLocaleLowerCase();
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
    setOpen(false);
    setActiveIndex(0);
  };

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
        aria-activedescendant={
          open && filtered[activeIndex] ? `${listId}-option-${activeIndex}` : undefined
        }
        autoComplete="off"
        required={required}
        disabled={disabled}
        value={open ? query : selected?.label ?? ''}
        placeholder={placeholder}
        onFocus={() => {
          setQuery(selected?.label ?? '');
          setOpen(true);
          setActiveIndex(0);
        }}
        onBlur={() => {
          setOpen(false);
          setQuery(selected?.label ?? '');
        }}
        onChange={(event) => {
          const next = event.target.value;
          setQuery(next);
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

      {open && !disabled ? (
        <div
          id={listId}
          role="listbox"
          style={{
            position: 'absolute',
            insetInline: 0,
            insetBlockStart: 'calc(100% + 0.375rem)',
            zIndex: zIndexTokens.overlay,
            maxBlockSize: '18rem',
            overflowY: 'auto',
            padding: spacingTokens.xs,
            borderRadius: radiusTokens.lg,
            background: colorTokens.surface,
            boxShadow: shadowTokens.overlay,
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
                id={`${listId}-option-${index}`}
                key={option.value}
                type="button"
                role="option"
                aria-selected={option.value === value}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(option)}
                style={{
                  display: 'flex',
                  inlineSize: '100%',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: spacingTokens.sm,
                  padding: `${spacingTokens.sm} ${spacingTokens.md}`,
                  border: 0,
                  borderRadius: radiusTokens.md,
                  background:
                    index === activeIndex || option.value === value
                      ? colorTokens.surfaceLavender
                      : 'transparent',
                  color: colorTokens.textPrimary,
                  fontFamily: 'inherit',
                  ...typographyTokens.bodySm,
                  textAlign: 'start',
                  cursor: 'pointer',
                }}
              >
                <span>{option.label}</span>
                <span style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}>
                  {option.value}
                </span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
