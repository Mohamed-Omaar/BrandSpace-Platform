'use client';

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  colorTokens,
  inputStyle,
  radiusTokens,
  shadowTokens,
  spacingTokens,
  textareaStyle,
  typographyTokens,
  zIndexTokens,
} from '@brandspace/ui';
import { mentionMatches, mentionQuery, type MentionMember } from './mention-match';

/**
 * A NOTE FIELD WITH REAL @-MENTION TYPEAHEAD (D-277 §28): type "@Sa", pick
 * "Sara". The suggestions are the ACTIVE MEMBERS the service would accept —
 * the same population the old picker showed — so nothing can be offered that
 * the server would drop.
 *
 * WHAT IS SUBMITTED is the note text plus one hidden `mentionedUserIds` per
 * person still named in it: deleting "@Sara" from the text un-mentions her.
 * The server re-validates every id (active member of this workspace) exactly
 * as before; this component decides nothing.
 *
 * KEYBOARD: ↓/↑ move through suggestions, Enter or Tab picks, Escape closes.
 * The field keeps focus throughout (`aria-activedescendant`), which is the
 * ARIA listbox-popup pattern for a text field.
 */
export function MentionField({
  id,
  name,
  multiline,
  required,
  placeholder,
  label,
  suggestionsLabel,
  members,
  testId,
}: {
  readonly id: string;
  readonly name: string;
  readonly multiline: boolean;
  readonly required?: boolean;
  readonly placeholder: string;
  /** The field's accessible name when no visible label points at it. */
  readonly label?: string | undefined;
  readonly suggestionsLabel: string;
  readonly members: readonly MentionMember[];
  readonly testId: string;
}) {
  const listId = useId();
  const [text, setText] = useState('');
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [picked, setPicked] = useState<readonly MentionMember[]>([]);
  const field = useRef<HTMLTextAreaElement & HTMLInputElement>(null);

  /*
   * CLEARED WITH ITS FORM. React resets a form after its server action
   * succeeds; a controlled field would keep the posted text, so it listens.
   */
  useEffect(() => {
    const form = field.current?.form;
    if (!form) return;
    const clear = () => {
      setText('');
      setPicked([]);
      setQuery(null);
    };
    form.addEventListener('reset', clear);
    return () => form.removeEventListener('reset', clear);
  }, []);

  const matches = useMemo(
    () => (query === null ? [] : mentionMatches(members, query)),
    [members, query],
  );
  const open = matches.length > 0;

  // Only the people still named in the text are mentioned.
  const mentioned = picked.filter((member) => text.includes(`@${member.name}`));

  const update = (value: string, caret: number) => {
    setText(value);
    setQuery(mentionQuery(value.slice(0, caret)));
    setActive(0);
  };

  const pick = (member: MentionMember) => {
    const node = field.current;
    const caret = node?.selectionStart ?? text.length;
    const before = text.slice(0, caret).replace(/@([^\s@]{0,30})$/u, `@${member.name} `);
    const next = before + text.slice(caret);
    setText(next);
    setQuery(null);
    setPicked((current) =>
      current.some((entry) => entry.userId === member.userId) ? current : [...current, member],
    );
    requestAnimationFrame(() => {
      node?.focus();
      node?.setSelectionRange(before.length, before.length);
    });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!open) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => (index + 1) % matches.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => (index - 1 + matches.length) % matches.length);
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      const member = matches[active];
      if (member) {
        event.preventDefault();
        pick(member);
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setQuery(null);
    }
  };

  const shared = {
    id,
    name,
    required,
    placeholder,
    value: text,
    dir: 'auto' as const,
    'aria-label': label,
    'aria-autocomplete': 'list' as const,
    'aria-controls': open ? listId : undefined,
    'aria-activedescendant': open ? `${listId}-${active}` : undefined,
    'data-testid': testId,
    onKeyDown,
    onBlur: () => setTimeout(() => setQuery(null), 120),
  };

  return (
    <div style={{ position: 'relative', display: 'grid', gap: spacingTokens.xs }}>
      {multiline ? (
        <textarea
          {...shared}
          className="bs-control"
          ref={field}
          rows={3}
          style={textareaStyle()}
          onChange={(event) => update(event.target.value, event.target.selectionStart)}
        />
      ) : (
        <input
          {...shared}
          className="bs-control"
          ref={field}
          style={inputStyle({ size: 'sm' })}
          onChange={(event) =>
            update(event.target.value, event.target.selectionStart ?? event.target.value.length)
          }
        />
      )}
      {open ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={suggestionsLabel}
          data-testid={`${testId}-suggestions`}
          style={{
            position: 'absolute',
            insetBlockStart: '100%',
            insetInlineStart: 0,
            zIndex: zIndexTokens.overlay,
            minInlineSize: '12rem',
            margin: `${spacingTokens['3xs']} 0 0`,
            padding: spacingTokens['3xs'],
            listStyle: 'none',
            background: colorTokens.surface,
            borderRadius: radiusTokens.md,
            boxShadow: shadowTokens.overlay,
          }}
        >
          {matches.map((member, index) => (
            <li
              key={member.userId}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              onMouseDown={(event) => {
                event.preventDefault();
                pick(member);
              }}
              style={{
                padding: `${spacingTokens.xs} ${spacingTokens.sm}`,
                borderRadius: radiusTokens.sm,
                cursor: 'pointer',
                ...typographyTokens.bodySm,
                background: index === active ? colorTokens.surfaceLavender : 'transparent',
                color: index === active ? colorTokens.brandPurplePressed : colorTokens.textPrimary,
              }}
            >
              {member.name}
            </li>
          ))}
        </ul>
      ) : null}
      {mentioned.map((member) => (
        <input key={member.userId} type="hidden" name="mentionedUserIds" value={member.userId} />
      ))}
    </div>
  );
}
