'use client';

/**
 * PR A2 (item 10) — AN AI EDIT SHOWS WHAT IT CHANGED, AND CAN BE UNDONE.
 *
 * After Shorter, Longer, Friendlier, More formal (or any other AI edit) the
 * caption shows the words before and after, with Undo — which saves the words
 * from before, at no cost — and Keep, which closes the comparison.
 *
 * An APPROVED DESIGN-SYSTEM EXTENSION (CLAUDE.md §4.2): the prototype draws no
 * comparison. It is composed of the Studio's own changed-fact pattern
 * (`bsp-st-bb`, `bsp-st-bb-line`, `bsp-st-area`) and buttons (`bsp-btn bsp-sm`):
 * no new class, no inline style, no literal.
 */

export interface LastAiEdit {
  readonly variantId: string;
  readonly tool: string;
  readonly before: { readonly body: string; readonly hashtags: readonly string[] };
  readonly after: { readonly body: string; readonly hashtags: readonly string[] };
}

export function AiEditCompare({
  t,
  edit,
  onUndo,
  onKeep,
}: {
  readonly t: Record<string, string>;
  readonly edit: LastAiEdit;
  readonly onUndo?: (() => void) | undefined;
  readonly onKeep?: (() => void) | undefined;
}) {
  const tags = (list: readonly string[]) => list.map((tag) => `#${tag}`).join(' ');
  return (
    <section
      className="bsp-st-bb"
      aria-label={t['editor.ai.compare.label']}
      data-testid="ai-edit-compare"
      data-tool={edit.tool}
    >
      <div className="bsp-st-bb-line">
        <span className="bsp-st-area">{t['editor.ai.compare.before']}</span>
        <span dir="auto" data-testid="ai-edit-before">
          {edit.before.body}
          {edit.tool === 'hashtags' ? ` ${tags(edit.before.hashtags)}` : ''}
        </span>
      </div>
      <div className="bsp-st-bb-line">
        <span className="bsp-st-area">{t['editor.ai.compare.after']}</span>
        <span dir="auto" data-testid="ai-edit-after">
          {edit.after.body}
          {edit.tool === 'hashtags' ? ` ${tags(edit.after.hashtags)}` : ''}
        </span>
      </div>
      <div className="bsp-st-inline">
        {onUndo ? (
          <button
            type="button"
            className="bsp-btn bsp-sm bsp-ghost"
            onClick={onUndo}
            data-testid="ai-edit-undo"
          >
            {t['editor.ai.compare.undo']}
          </button>
        ) : null}
        {onKeep ? (
          <button
            type="button"
            className="bsp-btn bsp-sm bsp-pur"
            onClick={onKeep}
            data-testid="ai-edit-keep"
          >
            {t['editor.ai.compare.keep']}
          </button>
        ) : null}
      </div>
    </section>
  );
}
