'use client';

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  colorTokens,
  showToast,
  inputStyle,
  radiusTokens,
  shadowTokens,
  spacingTokens,
  textareaStyle,
  typographyTokens,
  zIndexTokens,
  useOpening,
  usePresence,
} from '@brandspace/ui';
import {
  MENTION_OPEN_EVENT,
  mentionMatches,
  mentionQuery,
  type MentionMember,
} from './mention-match';

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
  postedLabel,
  notifiedLabel,
}: {
  /**
   * PR D (Notes 2) — "Posted · X will be notified", raised once the post has
   * gone (React resets the form after its action succeeds). `notifiedLabel`
   * carries `{names}`; without mentions the toast is `postedLabel` alone.
   */
  readonly postedLabel?: string | undefined;
  readonly notifiedLabel?: string | undefined;
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
  const pickedRef = useRef<readonly MentionMember[]>([]);
  pickedRef.current = picked;
  const field = useRef<HTMLTextAreaElement & HTMLInputElement>(null);

  /*
   * CLEARED WITH ITS FORM. React resets a form after its server action
   * succeeds; a controlled field would keep the posted text, so it listens.
   */
  const notifiedRef = useRef<readonly string[] | null>(null);
  useEffect(() => {
    const form = field.current?.form;
    if (!form) return;
    // The names posted with this note, kept until the post has gone.
    const submitted = () => {
      const node = field.current;
      const value = node?.value ?? '';
      notifiedRef.current = pickedRef.current
        .filter((member) => value.includes(`@${member.name}`))
        .map((member) => member.name);
    };
    const clear = () => {
      setText('');
      setPicked([]);
      setQuery(null);
      const names = notifiedRef.current;
      notifiedRef.current = null;
      if (names && postedLabel) {
        showToast({
          tone: 'success',
          testId: 'note-posted-toast',
          message:
            names.length > 0 && notifiedLabel
              ? notifiedLabel.replace('{names}', names.join(', '))
              : postedLabel,
        });
      }
    };
    form.addEventListener('submit', submitted);
    form.addEventListener('reset', clear);
    return () => {
      form.removeEventListener('submit', submitted);
      form.removeEventListener('reset', clear);
    };
  }, [postedLabel, notifiedLabel]);

  /*
   * PR D (Notes 1) — THE "@ MENTION" BUTTON (`Main.dc.html` line 969) opens
   * the people list: it asks this field, by its id, to start a mention at the
   * caret — an "@" typed for the reader, so the list shows everyone.
   */
  useEffect(() => {
    const open = (event: Event) => {
      if ((event as CustomEvent<{ id?: string }>).detail?.id !== id) return;
      const node = field.current;
      if (!node) return;
      const caret = node.selectionStart ?? node.value.length;
      const before = node.value.slice(0, caret);
      const lead = before === '' || /\s$/u.test(before) ? '@' : ' @';
      const next = before + lead + node.value.slice(caret);
      setText(next);
      setQuery('');
      setActive(0);
      requestAnimationFrame(() => {
        node.focus();
        const at = before.length + lead.length;
        node.setSelectionRange(at, at);
      });
    };
    window.addEventListener(MENTION_OPEN_EVENT, open);
    return () => window.removeEventListener(MENTION_OPEN_EVENT, open);
  }, [id]);

  const matches = useMemo(
    () => (query === null ? [] : mentionMatches(members, query)),
    [members, query],
  );
  const open = matches.length > 0;
  // MO5: the suggestions enter when they open and leave (180 ms) after.
  const listRef = useRef<HTMLUListElement | null>(null);
  const list = usePresence(open, listRef);
  const opening = useOpening(open);

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
      {list.present ? (
        <ul
          id={listId}
          ref={listRef}
          className={opening ? 'bs-pop' : undefined}
          {...(list.leaving ? { 'data-leaving': '', 'aria-hidden': true, inert: true } : {})}
          role="listbox"
          aria-label={suggestionsLabel}
          data-testid={`${testId}-suggestions`}
          style={{
            position: 'absolute',
            insetBlockStart: '100%',
            insetInlineStart: 0,
            zIndex: zIndexTokens.overlay,
            minInlineSize: 'var(--bsp-rem-12)',
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
