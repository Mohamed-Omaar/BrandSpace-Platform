'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { AppError, createLogger, internalErrorFields, toPublicErrorCode } from '@brandspace/shared';
import { formSource, type Source } from '../../../../server/simple-areas/fields';
import { findArea, findCollection } from '../../../../server/simple-areas/registry';
import { prepareArchive, prepareEdit, prepareRestore } from '../../../../server/simple-areas/edit';
import {
  PartialWrite,
  areaContext,
  findUndo,
  loadDocs,
  writeDocs,
} from '../../../../server/simple-areas/runtime';
import {
  forgetPartial,
  postedFields,
  readPartial,
  rememberPartial,
  whyOf,
} from '../../../../server/simple-areas/partial';
import type { AreaSpec, CollectionSpec, EditMode } from '../../../../server/simple-areas/types';
import {
  currentEnvironment,
  getConfigService,
  requirePlatformActor,
} from '../../../../server/platform-context';
import { refusalCode } from '../../../../server/simple-config';

const log = createLogger({ context: { component: 'admin.simple.areas' } });

/**
 * THE THREE WRITES OF A SIMPLE AREA: save an edit, archive / remove / hide an
 * item, undo an item's last change.
 *
 * Each re-reads the ACTIVE documents and re-runs the whole edit — fields, the
 * area's rules and the service's validation — rather than trusting what the
 * preview showed, then writes through `writeDocs` (the Configuration Service:
 * draft, validate, impact, activate, audit). The permissions are the service's
 * own, checked here first so a refusal is a plain message, not a stack.
 *
 * A form names only codes back in the URL (`ok`, `error`, `ref`) — nothing the
 * owner typed is ever reflected from it.
 *
 * A change that writes two documents and is refused on the second keeps the
 * first (D-558); the owner is told which part is missing and may try it again
 * (`retryPartAction`, below).
 */

type Kind = 'save' | 'archive' | 'undo';

interface Target {
  readonly locale: 'ar' | 'en';
  readonly area: AreaSpec;
  readonly collection: CollectionSpec;
  readonly itemKey: string | null;
  readonly back: string;
}

function target(formData: FormData): Target {
  const locale = String(formData.get('locale') ?? '') === 'ar' ? 'ar' : 'en';
  const area = findArea(String(formData.get('area') ?? ''));
  const collection = area ? findCollection(area, String(formData.get('c') ?? '')) : null;
  if (!area || !collection) throw new AppError('NOT_FOUND', 'Unknown area.');
  const raw = String(formData.get('item') ?? '');
  return { locale, area, collection, itemKey: raw === '' ? null : raw, back: area.href(locale) };
}

function reason(formData: FormData, base: string): string {
  const note = String(formData.get('note') ?? '')
    .trim()
    .slice(0, 300);
  return note ? `${base} — ${note}` : base;
}

async function run(kind: Kind, formData: FormData): Promise<void> {
  let back = '/en/console';
  let destination: string;
  // What a refused second part needs to be tried again: the card and the item.
  let pending: { area: string; c: string; item: string } | null = null;
  try {
    const where = target(formData);
    back = where.back;
    const actor = await requirePlatformActor('platform.configuration.manage');
    await requirePlatformActor('platform.configuration.activate');
    if (formData.get('confirm') !== 'yes') throw new AppError('VALIDATION_FAILED', 'NOT_CONFIRMED');

    const { area, collection, locale } = where;
    const docs = await loadDocs([...collection.domains, ...(collection.reads ?? [])]);
    const ctx = await areaContext(locale, docs);
    const context = await getConfigService().getContext(currentEnvironment());
    const areaTitle = ctx.t(area.title);

    if (kind === 'save') {
      const rawMode = String(formData.get('mode') ?? 'edit');
      const mode: EditMode = rawMode === 'new' || rawMode === 'duplicate' ? rawMode : 'edit';
      const edit = prepareEdit({
        collection,
        docs,
        ctx,
        context,
        mode,
        itemKey: where.itemKey,
        source: formSource(formData),
      });
      if ('missing' in edit) throw new AppError('CONFLICT', 'STALE');
      if (Object.keys(edit.fieldErrors).length > 0 || edit.problems.length > 0)
        throw new AppError('CONFLICT', 'STALE');
      if (edit.unchanged) throw new AppError('CONFLICT', 'UNCHANGED');
      const title =
        collection.items(edit.after, ctx).find((item) => item.key === edit.targetKey)?.title ??
        edit.targetKey;
      pending = { area: area.key, c: collection.id, item: edit.targetKey };
      await writeDocs({
        actor,
        before: docs,
        after: edit.after,
        reason: reason(formData, ctx.t('ui.reason', { area: areaTitle, item: title })),
      });
      destination = `${back}?ok=SAVED&c=${encodeURIComponent(collection.id)}&item=${encodeURIComponent(edit.targetKey)}`;
    } else if (kind === 'archive') {
      if (!where.itemKey) throw new AppError('CONFLICT', 'STALE');
      const archive = prepareArchive({ collection, docs, ctx, context, itemKey: where.itemKey });
      if (!archive || archive.problems.length > 0) throw new AppError('CONFLICT', 'STALE');
      pending = { area: area.key, c: collection.id, item: where.itemKey };
      await writeDocs({
        actor,
        before: docs,
        after: archive.after,
        reason: reason(formData, ctx.t('ui.reason', { area: areaTitle, item: archive.item.title })),
      });
      destination = `${back}?ok=ARCHIVED&c=${encodeURIComponent(collection.id)}`;
    } else {
      if (!where.itemKey) throw new AppError('CONFLICT', 'STALE');
      const undo = await findUndo(actor, collection, where.itemKey);
      // The change the owner read is the one undone, or nothing is.
      if (!undo || String(undo.changedAt.getTime()) !== String(formData.get('expected') ?? '')) {
        throw new AppError('CONFLICT', 'STALE');
      }
      const restore = prepareRestore({
        collection,
        docs,
        ctx,
        context,
        itemKey: where.itemKey,
        domain: undo.domain,
        write: (doc) => undo.slice.write(doc, undo.value),
      });
      if (!restore || restore.problems.length > 0) throw new AppError('CONFLICT', 'STALE');
      await writeDocs({
        actor,
        before: docs,
        after: restore.after,
        reason: reason(
          formData,
          ctx.t('ui.reasonUndo', { area: areaTitle, item: restore.item.title }),
        ),
      });
      destination = `${back}?ok=UNDONE&c=${encodeURIComponent(collection.id)}&item=${encodeURIComponent(where.itemKey)}`;
    }
  } catch (error: unknown) {
    if (error instanceof PartialWrite && pending && kind !== 'undo') {
      await rememberPartial({
        ...pending,
        kind,
        values: kind === 'save' ? postedFields(formData) : [],
        saved: error.written,
        failed: error.failed,
        why: whyOf(error.refusal),
      });
      log.warn('simple area change saved in part', {
        kind,
        saved: error.written,
        failed: error.failed,
        ...internalErrorFields(error.refusal),
      });
      revalidatePath(back.split('?')[0] ?? back);
      redirect(`${back}?partial=1`);
    }
    const code =
      refusalCode(error) ??
      (error instanceof AppError && (error.message === 'STALE' || error.message === 'NOT_CONFIRMED')
        ? error.message
        : null);
    if (code) {
      destination = `${back}?error=${code}`;
    } else {
      const correlationId = randomUUID();
      log.error('simple area change failed', {
        correlationId,
        kind,
        ...internalErrorFields(error),
      });
      destination = `${back}?error=${toPublicErrorCode(error)}&ref=${correlationId}`;
    }
  }
  revalidatePath(back.split('?')[0] ?? back);
  redirect(destination);
}

export async function saveAreaItemAction(formData: FormData): Promise<void> {
  await run('save', formData);
}

export async function archiveAreaItemAction(formData: FormData): Promise<void> {
  await run('archive', formData);
}

export async function undoAreaItemAction(formData: FormData): Promise<void> {
  await run('undo', formData);
}

/** A posted form's fields, kept as pairs, read the way a live form is. */
function pairsSource(pairs: readonly (readonly [string, string])[]): Source {
  return {
    get: (name) => pairs.find(([key]) => key === name)?.[1] ?? null,
    getAll: (name) => pairs.filter(([key]) => key === name).map(([, value]) => value),
  };
}

/**
 * "TRY THE SECOND PART AGAIN". The kept change is re-run whole against the
 * documents live now — the same edit, area rules and service validation as a
 * save — and written through the same service. The part already saved is
 * unchanged, so only the missing part is activated; if nothing is left to
 * write, the change is complete and the message goes.
 */
export async function retryPartAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? '') === 'ar' ? 'ar' : 'en';
  let back = `/${locale}/console`;
  let destination: string;
  const partial = await readPartial();
  try {
    const area = partial ? findArea(partial.area) : null;
    const collection = area && partial ? findCollection(area, partial.c) : null;
    if (!partial || !area || !collection || collection.id !== partial.c) {
      throw new AppError('CONFLICT', 'STALE');
    }
    back = area.href(locale);
    const actor = await requirePlatformActor('platform.configuration.manage');
    await requirePlatformActor('platform.configuration.activate');
    if (formData.get('confirm') !== 'yes') throw new AppError('VALIDATION_FAILED', 'NOT_CONFIRMED');

    const docs = await loadDocs([...collection.domains, ...(collection.reads ?? [])]);
    const ctx = await areaContext(locale, docs);
    const context = await getConfigService().getContext(currentEnvironment());
    let after;
    let title = partial.item;
    if (partial.kind === 'save') {
      const edit = prepareEdit({
        collection,
        docs,
        ctx,
        context,
        mode: 'edit',
        itemKey: partial.item,
        source: pairsSource(partial.values),
      });
      if ('missing' in edit || Object.keys(edit.fieldErrors).length > 0 || edit.problems.length > 0)
        throw new AppError('CONFLICT', 'STALE');
      after = edit.unchanged ? null : edit.after;
      title = edit.item?.title ?? title;
    } else {
      const archive = prepareArchive({ collection, docs, ctx, context, itemKey: partial.item });
      if (!archive || archive.problems.length > 0) throw new AppError('CONFLICT', 'STALE');
      after = archive.after;
      title = archive.item.title;
    }
    if (after) {
      try {
        await writeDocs({
          actor,
          before: docs,
          after,
          reason: reason(formData, ctx.t('ui.reason', { area: ctx.t(area.title), item: title })),
        });
      } catch (error: unknown) {
        // Nothing left to write: the rest was saved meanwhile.
        if (refusalCode(error) !== 'UNCHANGED') throw error;
      }
    }
    await forgetPartial();
    destination = `${back}?ok=PART_DONE&c=${encodeURIComponent(collection.id)}&item=${encodeURIComponent(partial.item)}`;
  } catch (error: unknown) {
    const refusal = error instanceof PartialWrite ? error.refusal : error;
    if (partial) await rememberPartial({ ...partial, why: whyOf(refusal) });
    const code =
      refusalCode(refusal) ??
      (refusal instanceof AppError &&
      (refusal.message === 'STALE' || refusal.message === 'NOT_CONFIRMED')
        ? refusal.message
        : null);
    if (code) {
      destination = `${back}?partial=1&error=${code}`;
    } else {
      const correlationId = randomUUID();
      log.error('simple area part retry failed', {
        correlationId,
        ...internalErrorFields(refusal),
      });
      destination = `${back}?partial=1&error=${toPublicErrorCode(refusal)}&ref=${correlationId}`;
    }
  }
  revalidatePath(back);
  redirect(destination);
}
