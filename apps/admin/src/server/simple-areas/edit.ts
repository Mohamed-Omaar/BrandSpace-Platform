import { validateConfiguration, type ConfigContext, type ConfigDomain } from '@brandspace/config';
import { parseFields, type Source } from './fields';
import { changeLines, type ChangeLine } from './registry';
import type {
  AreaContext,
  CollectionSpec,
  Docs,
  EditMode,
  FieldSpec,
  FieldValues,
  ItemView,
} from './types';

/**
 * ONE EDIT, FROM FORM TO NEXT DOCUMENTS — shared by the preview page and the
 * save action, so what the owner checked is exactly what is saved.
 *
 *   read the fields (plain refusals per field)
 *   -> refuse a short name already in use
 *   -> apply the edit to the active documents
 *   -> the area's own rules (`check`)
 *   -> the SAME validation the Configuration Service runs on a draft
 *      (`validateConfiguration`, with the other active domains as context)
 *   -> what changes, field by field, and what customers will notice.
 *
 * The save action then hands `after` to `writeDocs`, which re-validates
 * inside the service; nothing here writes.
 */

export interface PreparedChange {
  readonly fields: readonly FieldSpec[];
  readonly values: FieldValues;
  /** Per-field refusals, in the reader's language. */
  readonly fieldErrors: Readonly<Record<string, string>>;
  /** Area rules and the service's validation, as sentences. */
  readonly problems: readonly string[];
  readonly before: Docs;
  readonly after: Docs;
  readonly targetKey: string;
  readonly item: ItemView | null;
  readonly changes: readonly ChangeLine[];
  readonly impacts: readonly string[];
  /** Nothing would change. */
  readonly unchanged: boolean;
}

export type EditOutcome = PreparedChange | { readonly missing: true };

function changedDomains(before: Docs, after: Docs): ConfigDomain[] {
  return (Object.keys(after) as ConfigDomain[]).filter(
    (domain) => JSON.stringify(before[domain]) !== JSON.stringify(after[domain]),
  );
}

/** The same check `validateDraft` makes, for every domain this edit changes. */
export function serviceProblems(before: Docs, after: Docs, context: ConfigContext, ctx: AreaContext): string[] {
  const merged: ConfigContext = { ...context, ...after };
  return changedDomains(before, after).flatMap((domain) =>
    validateConfiguration(domain, after[domain], merged)
      .issues.filter((issue) => issue.severity === 'error')
      .map((issue) => ctx.t('v.service', { message: issue.message })),
  );
}

export function prepareEdit(input: {
  readonly collection: CollectionSpec;
  readonly docs: Docs;
  readonly ctx: AreaContext;
  readonly context: ConfigContext;
  readonly mode: EditMode;
  readonly itemKey: string | null;
  readonly source: Source;
}): EditOutcome {
  const { collection, docs, ctx, mode } = input;
  const items = collection.items(docs, ctx);
  const item = input.itemKey === null ? null : (items.find((i) => i.key === input.itemKey) ?? null);
  if (mode !== 'new' && !item) return { missing: true };
  if (mode === 'new' && collection.canCreate !== true) return { missing: true };
  if (mode === 'duplicate' && collection.canDuplicate !== true) return { missing: true };

  const fields = collection.fields(docs, ctx, mode, mode === 'new' ? null : input.itemKey);
  const parsed = parseFields(fields, input.source, ctx);
  const values: Record<string, FieldValues[string]> = { ...parsed.values };
  const fieldErrors: Record<string, string> = { ...parsed.errors };
  // A field locked on edit (a short name) keeps its value whatever is posted.
  if (mode === 'edit' && item) {
    for (const field of fields) {
      if (field.lockedOnEdit && item.values[field.id] !== undefined) {
        values[field.id] = item.values[field.id]!;
        delete fieldErrors[field.id];
      }
    }
  }

  const empty = {
    fields,
    values,
    fieldErrors,
    problems: [],
    before: docs,
    after: docs,
    targetKey: input.itemKey ?? '',
    item,
    changes: [],
    impacts: [],
    unchanged: true,
  } satisfies PreparedChange;
  if (Object.keys(fieldErrors).length > 0) return empty;

  const targetKey = collection.keyOf(values, mode, input.itemKey);
  if (mode !== 'edit' && items.some((existing) => existing.key === targetKey)) {
    const keyField = fields.find((field) => field.lockedOnEdit) ?? fields[0];
    return { ...empty, fieldErrors: { [keyField?.id ?? 'key']: ctx.t('v.keyTaken') } };
  }

  const after: Docs = { ...docs, ...collection.apply(docs, ctx, { mode, itemKey: input.itemKey, values }) };
  const unchanged = changedDomains(docs, after).length === 0;
  const problems = [
    ...(collection.check?.(docs, after, ctx, { mode, itemKey: targetKey }) ?? []),
    ...serviceProblems(docs, after, input.context, ctx),
  ];
  return {
    fields,
    values,
    fieldErrors,
    problems,
    before: docs,
    after,
    targetKey,
    item,
    changes: changeLines(fields, mode === 'edit' ? (item?.values ?? null) : null, values, ctx),
    impacts: unchanged ? [] : (collection.impact?.(docs, after, ctx, targetKey) ?? []),
    unchanged,
  };
}

export interface PreparedArchive {
  readonly item: ItemView;
  readonly after: Docs;
  readonly problems: readonly string[];
  readonly impacts: readonly string[];
}

export function prepareArchive(input: {
  readonly collection: CollectionSpec;
  readonly docs: Docs;
  readonly ctx: AreaContext;
  readonly context: ConfigContext;
  readonly itemKey: string;
}): PreparedArchive | null {
  const { collection, docs, ctx, itemKey } = input;
  if (!collection.archive) return null;
  const item = collection.items(docs, ctx).find((i) => i.key === itemKey);
  if (!item) return null;
  const after: Docs = { ...docs, ...collection.archive(docs, ctx, itemKey) };
  const problems = [
    ...(item.archiveBlockedReason ? [item.archiveBlockedReason] : []),
    ...(collection.check?.(docs, after, ctx, { mode: 'archive', itemKey }) ?? []),
    ...serviceProblems(docs, after, input.context, ctx),
  ];
  return {
    item,
    after,
    problems: [...new Set(problems)],
    impacts: collection.impact?.(docs, after, ctx, itemKey) ?? [],
  };
}

/** What an undo puts back, shown the way an edit is: field by field. */
export function prepareRestore(input: {
  readonly collection: CollectionSpec;
  readonly docs: Docs;
  readonly ctx: AreaContext;
  readonly context: ConfigContext;
  readonly itemKey: string;
  readonly domain: ConfigDomain;
  readonly write: (doc: Record<string, unknown>) => Record<string, unknown>;
}): { readonly item: ItemView; readonly after: Docs; readonly changes: readonly ChangeLine[]; readonly impacts: readonly string[]; readonly problems: readonly string[] } | null {
  const { collection, docs, ctx, itemKey } = input;
  const item = collection.items(docs, ctx).find((i) => i.key === itemKey);
  if (!item) return null;
  const after: Docs = { ...docs, [input.domain]: input.write(docs[input.domain] ?? {}) };
  const restored = collection.items(after, ctx).find((i) => i.key === itemKey) ?? null;
  const fields = collection.fields(docs, ctx, 'edit', itemKey);
  return {
    item,
    after,
    changes: restored ? changeLines(fields, item.values, restored.values, ctx) : [],
    impacts: collection.impact?.(docs, after, ctx, itemKey) ?? [],
    problems: [
      ...(collection.check?.(docs, after, ctx, { mode: 'edit', itemKey }) ?? []),
      ...serviceProblems(docs, after, input.context, ctx),
    ],
  };
}
