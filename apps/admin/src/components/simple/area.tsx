import type { ReactNode } from 'react';
import type { AuthenticatedPlatformActor } from '@brandspace/auth';
import {
  Banner,
  Card,
  ContentGrid,
  Field,
  Stack,
  StatusBadge,
  FIELD_CLASS,
  buttonClass,
  colorTokens,
  radiusTokens,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';
import {
  archiveAreaItemAction,
  retryPartAction,
  saveAreaItemAction,
  undoAreaItemAction,
} from '../../app/[locale]/console/manage/actions';
import {
  displayValue,
  fieldName,
  labelOf,
  parseFields,
  sourceOf,
  toQuery,
} from '../../server/simple-areas/fields';
import { prepareArchive, prepareEdit, prepareRestore } from '../../server/simple-areas/edit';
import { findCollection, type ChangeLine } from '../../server/simple-areas/registry';
import { areaContext, findUndo, loadDocs, mayChange } from '../../server/simple-areas/runtime';
import { planPreview, type PlanPreview } from '../../server/simple-areas/areas/plans';
import type {
  AreaContext,
  AreaSpec,
  CollectionSpec,
  Docs,
  EditMode,
  FieldSpec,
  FieldValue,
  FieldValues,
  ItemView,
} from '../../server/simple-areas/types';
import { currentEnvironment, getConfigService } from '../../server/platform-context';
import { minorToMajorInput } from '../../server/money';
import { loadOpenDrafts } from '../../server/simple-config';
import { readPartial, type PartialChange } from '../../server/simple-areas/partial';
import { sameJson } from '../../server/simple-areas/json';
import { domainName, listJoin } from '../../i18n/simple-names';
import type { ConfigDomain, ConfigContext } from '@brandspace/config';
import { AdvancedLink } from '../mode-switch';
import { OpenDraftNotice } from './open-drafts';
import { ActionLink, ActionOutcome, SimpleSection, flash, formatWhen } from '../simple-ui';

/**
 * ONE SIMPLE AREA — a page of cards, each opening an easy editor (owner
 * decision, Control Center Simple mode; an approved design-system extension,
 * CLAUDE.md §4.2: every piece is an existing `@brandspace/ui` component).
 *
 * THE FLOW IS PLAIN LINKS AND FORMS, so it works before scripts load:
 *
 *   cards ──Edit──▶ editor (GET) ──Check──▶ preview ──Save (POST)──▶ cards
 *                     ▲                       │
 *                     └──── Go back and change it
 *
 * The preview IS the save's input: the confirm form re-posts the same values,
 * and the action re-runs the whole edit against the documents live at that
 * moment (`prepareEdit`), so nothing the owner did not read is written.
 */

type Query = Record<string, string | string[] | undefined>;

const one = (query: Query, key: string): string | null => {
  const value = query[key];
  return typeof value === 'string' ? value : Array.isArray(value) ? (value[0] ?? null) : null;
};

const muted = { margin: 0, ...typographyTokens.caption, color: colorTokens.textMuted } as const;
const body = { margin: 0, ...typographyTokens.bodySm, color: colorTokens.textSecondary } as const;
const idOf = (field: FieldSpec, part?: string) =>
  `f-${field.id}${part ? `-${part}` : ''}`.replace(/\./g, '-');

function hrefWith(
  base: string,
  params: Record<string, string | readonly string[] | null | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value))
      for (const entry of value as readonly string[]) search.append(key, entry);
    else search.set(key, value as string);
  }
  const text = search.toString();
  return text ? `${base}?${text}` : base;
}

export async function SimpleArea({
  locale,
  actor,
  area,
  query,
}: {
  readonly locale: string;
  readonly actor: AuthenticatedPlatformActor;
  readonly area: AreaSpec;
  readonly query: Query;
}) {
  const domains = [...new Set(area.collections.flatMap((c) => c.domains))];
  const docs = await loadDocs([...domains, ...area.collections.flatMap((c) => c.reads ?? [])]);
  const ctx = await areaContext(locale, docs);
  const base = area.href(locale);
  const view = one(query, 'view');
  const collection = view ? findCollection(area, one(query, 'c')) : null;
  const mayWrite = mayChange(actor);
  const drafts = mayWrite ? await loadOpenDrafts(actor, domains) : [];
  // An unfinished draft of these settings blocks a Simple change (D-312): the
  // notice says so up front and no change control is offered until it is gone.
  const canChange = mayWrite && drafts.length === 0;
  const { ok, error, ref } = flash(query);
  const partial = mayWrite ? await readPartial() : null;
  const missingPart =
    partial && partial.area === area.key ? await stillMissing(partial, area, docs, ctx) : null;

  const notices = (
    <>
      <ActionOutcome
        locale={locale}
        ok={ok}
        error={error}
        reference={ref}
        okText={(code) =>
          code === 'SAVED'
            ? ctx.t('ui.saved')
            : code === 'UNDONE'
              ? ctx.t('ui.undone')
              : code === 'ARCHIVED'
                ? ctx.t('ui.archived')
                : code === 'PART_DONE'
                  ? ctx.t('ui.partial.done')
                  : null
        }
        errorText={(code) =>
          code === 'DRAFT_OPEN'
            ? ctx.t('ui.draftOpen')
            : code === 'UNCHANGED'
              ? ctx.t('ui.unchanged')
              : code === 'STALE'
                ? ctx.t('ui.stale')
                : code === 'NOT_CONFIRMED'
                  ? ctx.t('ui.notConfirmed')
                  : null
        }
      />
      {missingPart ? (
        <PartialNotice
          partial={missingPart}
          collection={missingPart.collection}
          ctx={ctx}
          locale={locale}
        />
      ) : null}
      {!mayWrite ? (
        <Banner tone="info" testId="area-read-only">
          {ctx.t('ui.readOnly')}
        </Banner>
      ) : null}
      <OpenDraftNotice
        locale={locale}
        drafts={drafts}
        next={base}
        advancedHref="/configuration"
        mayDiscard={mayWrite}
      />
    </>
  );

  if (view && collection && canChange) {
    const context = await getConfigService().getContext(currentEnvironment());
    const itemKey = one(query, 'item');
    const rawMode = one(query, 'mode');
    const mode: EditMode = rawMode === 'new' || rawMode === 'duplicate' ? rawMode : 'edit';
    let content: ReactNode = null;
    if (view === 'preview') {
      const edit = prepareEdit({
        collection,
        docs,
        ctx,
        context,
        mode,
        itemKey,
        source: sourceOf(query),
      });
      if ('missing' in edit) content = <Missing ctx={ctx} base={base} />;
      else if (Object.keys(edit.fieldErrors).length > 0)
        content = (
          <Editor
            area={area}
            collection={collection}
            ctx={ctx}
            docs={docs}
            mode={mode}
            item={edit.item}
            values={edit.values}
            errors={edit.fieldErrors}
            locale={locale}
          />
        );
      else
        content = (
          <Preview
            area={area}
            collection={collection}
            ctx={ctx}
            mode={mode}
            itemKey={itemKey}
            edit={edit}
            locale={locale}
          />
        );
    } else if (view === 'edit') {
      const item = itemKey
        ? (collection.items(docs, ctx).find((i) => i.key === itemKey) ?? null)
        : null;
      const allowed =
        mode === 'new'
          ? collection.canCreate === true
          : item !== null && (mode === 'edit' || collection.canDuplicate === true);
      content = allowed ? (
        <Editor
          area={area}
          collection={collection}
          ctx={ctx}
          docs={docs}
          mode={mode}
          item={item}
          values={startingValues(collection, docs, ctx, mode, item, query)}
          errors={{}}
          locale={locale}
        />
      ) : (
        <Missing ctx={ctx} base={base} />
      );
    } else if (view === 'archive' && itemKey) {
      const archive = prepareArchive({ collection, docs, ctx, context, itemKey });
      content = archive ? (
        <Confirm
          testId="area-archive"
          title={ctx.t('ui.archiveTitle', {
            action: ctx.t(collection.archiveLabel ?? 'a.archive'),
            item: archive.item.title,
          })}
          intro={null}
          changes={[]}
          impacts={archive.impacts}
          problems={archive.problems}
          ctx={ctx}
          base={base}
          action={archiveAreaItemAction}
          submit={ctx.t(collection.archiveLabel ?? 'a.archive')}
          hidden={{ locale, area: area.key, c: collection.id, item: itemKey }}
        />
      ) : (
        <Missing ctx={ctx} base={base} />
      );
    } else if (view === 'undo' && itemKey) {
      const item = collection.items(docs, ctx).find((i) => i.key === itemKey);
      const undo = item ? await findUndo(actor, collection, itemKey) : null;
      const restore = undo
        ? prepareRestore({
            collection,
            docs,
            ctx,
            context,
            itemKey,
            domain: undo.domain,
            write: (doc) => undo.slice.write(doc, undo.value),
          })
        : null;
      content = !item ? (
        <Missing ctx={ctx} base={base} />
      ) : !undo || !restore ? (
        <Card testId="area-undo">
          <Stack gap={spacingTokens.sm}>
            <p style={body} data-testid="area-undo-nothing">
              {ctx.t('ui.undoNothing', { item: item.title })}
            </p>
            <div>
              <ActionLink href={base}>{ctx.t('a.backToCards')}</ActionLink>
            </div>
          </Stack>
        </Card>
      ) : (
        <Confirm
          testId="area-undo"
          title={ctx.t('ui.undoTitle', { item: item.title })}
          intro={ctx.t('ui.undoIntro', {
            item: item.title,
            when: formatWhen(locale, undo.changedAt),
          })}
          changes={restore.changes}
          impacts={restore.impacts}
          problems={restore.problems}
          ctx={ctx}
          base={base}
          action={undoAreaItemAction}
          submit={ctx.t('a.undo')}
          hidden={{
            locale,
            area: area.key,
            c: collection.id,
            item: itemKey,
            expected: String(undo.changedAt.getTime()),
          }}
        />
      );
    }
    if (content) {
      return (
        <Stack>
          {notices}
          {content}
        </Stack>
      );
    }
  }

  return (
    <Stack>
      {notices}
      <p style={{ ...body, maxInlineSize: '68ch' }} data-testid="area-intro">
        {ctx.t(area.intro)}
      </p>
      {area.guided && area.guided.length > 0 ? (
        <div
          style={{ display: 'flex', flexWrap: 'wrap', gap: spacingTokens.xs }}
          data-testid="area-guided"
        >
          {area.guided.map((guide) => (
            <ActionLink
              key={guide.href}
              href={`/${locale}${guide.href}`}
              testId={`area-guided-${guide.href.split('/').pop()}`}
            >
              {ctx.t(guide.label)}
            </ActionLink>
          ))}
        </div>
      ) : null}
      {area.collections.map((c) => (
        <Cards
          key={c.id}
          collection={c}
          docs={docs}
          ctx={ctx}
          base={base}
          canChange={canChange}
          highlight={one(query, 'item')}
        />
      ))}
      <Developer area={area} docs={docs} ctx={ctx} locale={locale} />
    </Stack>
  );
}

function startingValues(
  collection: CollectionSpec,
  docs: Docs,
  ctx: AreaContext,
  mode: EditMode,
  item: ItemView | null,
  query: Query,
): FieldValues {
  const fields = collection.fields(docs, ctx, mode, mode === 'new' ? null : (item?.key ?? null));
  if (Object.keys(query).some((key) => key.startsWith('f.'))) {
    return { ...defaults(fields, ctx), ...parseFields(fields, sourceOf(query), ctx).values };
  }
  if (!item) return defaults(fields, ctx);
  if (mode !== 'duplicate') return item.values;
  const keyField = fields.find((field) => field.lockedOnEdit);
  return keyField
    ? { ...item.values, [keyField.id]: `${String(item.values[keyField.id] ?? '')}-copy` }
    : item.values;
}

function defaults(fields: readonly FieldSpec[], ctx: AreaContext): FieldValues {
  return Object.fromEntries(
    fields.map((field): [string, FieldValue] => {
      switch (field.kind) {
        case 'number':
          return [field.id, field.min ?? 0];
        case 'switch':
          return [field.id, false];
        case 'choice':
          return [field.id, field.options?.[0]?.value ?? ''];
        case 'multi':
        case 'times':
          return [field.id, []];
        case 'money':
          return [
            field.id,
            {
              kind: 'money',
              minor: Object.fromEntries((field.currencies ?? ctx.currencies).map((c) => [c, 0])),
            },
          ];
        default:
          return [field.id, ''];
      }
    }),
  );
}

function Cards({
  collection,
  docs,
  ctx,
  base,
  canChange,
  highlight,
}: {
  readonly collection: CollectionSpec;
  readonly docs: Docs;
  readonly ctx: AreaContext;
  readonly base: string;
  readonly canChange: boolean;
  readonly highlight: string | null;
}) {
  const items = collection.items(docs, ctx);
  const link = (params: Record<string, string>) => hrefWith(base, { c: collection.id, ...params });
  return (
    <SimpleSection
      title={ctx.t(collection.title)}
      description={collection.intro ? ctx.t(collection.intro) : undefined}
      testId={`area-collection-${collection.id}`}
      actions={
        canChange && collection.canCreate ? (
          <ActionLink
            href={link({ view: 'edit', mode: 'new' })}
            variant="primary"
            testId={`area-new-${collection.id}`}
          >
            {ctx.t('a.new')}
          </ActionLink>
        ) : null
      }
    >
      {items.length === 0 ? (
        <Card testId={`area-empty-${collection.id}`}>
          <p style={body}>{ctx.t('ui.empty')}</p>
        </Card>
      ) : (
        <ContentGrid min="18rem" testId={`area-cards-${collection.id}`}>
          {items.map((item) => (
            <Card key={item.key} testId={`area-card-${collection.id}-${item.key}`}>
              <div
                style={{ display: 'grid', gap: spacingTokens.sm }}
                aria-current={highlight === item.key ? 'true' : undefined}
              >
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: spacingTokens.xs,
                  }}
                >
                  <h3 style={{ margin: 0, ...typographyTokens.h3 }}>{item.title}</h3>
                  {item.status ? (
                    <StatusBadge
                      label={item.status.label}
                      tone={item.status.tone}
                      dot
                      testId={`area-card-${collection.id}-${item.key}-status`}
                    />
                  ) : null}
                </div>
                {item.subtitle ? <p style={muted}>{item.subtitle}</p> : null}
                <Facts facts={item.facts} />
                {item.previewKind === 'plan' ? (
                  <PlanCard preview={planPreview(docs, item.key, ctx)} ctx={ctx} />
                ) : null}
                {canChange ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: spacingTokens.xs }}>
                    <ActionLink
                      href={link({ view: 'edit', item: item.key })}
                      variant="primary"
                      testId={`area-edit-${collection.id}-${item.key}`}
                    >
                      {ctx.t('a.edit')}
                    </ActionLink>
                    {collection.canDuplicate ? (
                      <ActionLink
                        href={link({ view: 'edit', mode: 'duplicate', item: item.key })}
                        testId={`area-duplicate-${collection.id}-${item.key}`}
                      >
                        {ctx.t('a.duplicate')}
                      </ActionLink>
                    ) : null}
                    {collection.archive && !item.archiveBlockedReason ? (
                      <ActionLink
                        href={link({ view: 'archive', item: item.key })}
                        variant="ghost"
                        testId={`area-archive-${collection.id}-${item.key}`}
                      >
                        {ctx.t(collection.archiveLabel ?? 'a.archive')}
                      </ActionLink>
                    ) : null}
                    <ActionLink
                      href={link({ view: 'undo', item: item.key })}
                      variant="ghost"
                      testId={`area-undo-${collection.id}-${item.key}`}
                    >
                      {ctx.t('a.undo')}
                    </ActionLink>
                  </div>
                ) : null}
                {canChange && collection.archive && item.archiveBlockedReason ? (
                  <p
                    style={muted}
                    data-testid={`area-archive-blocked-${collection.id}-${item.key}`}
                  >
                    {item.archiveBlockedReason}
                  </p>
                ) : null}
              </div>
            </Card>
          ))}
        </ContentGrid>
      )}
    </SimpleSection>
  );
}

function Facts({ facts }: { readonly facts: ItemView['facts'] }) {
  return (
    <dl
      style={{
        margin: 0,
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
        columnGap: spacingTokens.sm,
        rowGap: '4px',
        alignItems: 'baseline',
      }}
    >
      {facts.map((fact) => (
        <div key={fact.label} style={{ display: 'contents' }}>
          <dt style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}>
            {fact.label}
          </dt>
          <dd
            style={{
              margin: 0,
              ...typographyTokens.bodySm,
              fontWeight: 600,
              textAlign: 'end',
              overflowWrap: 'anywhere',
            }}
          >
            {fact.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** How a customer reads the plan: name, price, trial, credits, limits, features. */
function PlanCard({
  preview,
  ctx,
}: {
  readonly preview: PlanPreview | null;
  readonly ctx: AreaContext;
}) {
  if (!preview) return null;
  return (
    <details data-testid="plan-customer-preview">
      <summary style={{ cursor: 'pointer', ...typographyTokens.bodySm, fontWeight: 600 }}>
        {ctx.t('ui.customerPreview')}
      </summary>
      <PlanCardBody preview={preview} ctx={ctx} />
    </details>
  );
}

function PlanCardBody({
  preview,
  ctx,
}: {
  readonly preview: PlanPreview;
  readonly ctx: AreaContext;
}) {
  return (
    <div
      data-testid="plan-customer-card"
      style={{
        marginBlockStart: spacingTokens.sm,
        padding: spacingTokens.md,
        borderRadius: radiusTokens.rail,
        border: `1px solid ${colorTokens.hairline}`,
        background: colorTokens.surface,
        display: 'grid',
        gap: spacingTokens.xs,
      }}
    >
      <strong style={{ ...typographyTokens.h3 }}>{preview.name}</strong>
      {preview.description ? (
        <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
          {preview.description}
        </span>
      ) : null}
      <span style={{ ...typographyTokens.h3, color: colorTokens.textPrimary }}>
        {preview.price}
      </span>
      <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
        {ctx.t('plans.c.trial')}: {preview.trial} · {ctx.t('plans.c.monthlyCredits')}:{' '}
        {preview.credits}
      </span>
      <ul style={{ margin: 0, paddingInlineStart: spacingTokens.md, ...typographyTokens.caption }}>
        {preview.limits.map((limit) => (
          <li key={limit.label}>
            {limit.label}: {limit.value}
          </li>
        ))}
        {preview.features.map((feature) => (
          <li key={feature}>✓ {feature}</li>
        ))}
      </ul>
    </div>
  );
}

function Developer({
  area,
  docs,
  ctx,
  locale,
}: {
  readonly area: AreaSpec;
  readonly docs: Docs;
  readonly ctx: AreaContext;
  readonly locale: string;
}) {
  if (area.developer.length === 0) return null;
  return (
    <Card testId="area-developer">
      <SimpleSection title={ctx.t('ui.developerTitle')} description={ctx.t('ui.developerIntro')}>
        <dl style={{ margin: 0, display: 'grid', gap: spacingTokens.xs }}>
          {area.developer.map((setting) => (
            <div
              key={setting.label}
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: spacingTokens.xs,
                justifyContent: 'space-between',
              }}
            >
              <dt style={{ ...typographyTokens.bodySm }}>{ctx.t(setting.label)}</dt>
              <dd
                style={{
                  margin: 0,
                  ...typographyTokens.caption,
                  color: colorTokens.textMuted,
                  overflowWrap: 'anywhere',
                }}
              >
                <bdi>{setting.value(docs, ctx)}</bdi> · {ctx.t('ui.developerBadge')}
              </dd>
            </div>
          ))}
        </dl>
        <div style={{ marginBlockStart: spacingTokens.sm }}>
          <AdvancedLink
            locale={locale}
            href="/configuration"
            label={ctx.t('a.openAdvanced')}
            testId="area-open-advanced"
          />
        </div>
      </SimpleSection>
    </Card>
  );
}

function Missing({ ctx, base }: { readonly ctx: AreaContext; readonly base: string }) {
  return (
    <Card testId="area-missing">
      <Stack gap={spacingTokens.sm}>
        <p style={body}>{ctx.t('ui.notFound')}</p>
        <div>
          <ActionLink href={base} testId="area-missing-back">
            {ctx.t('a.backToCards')}
          </ActionLink>
        </div>
      </Stack>
    </Card>
  );
}

function Editor({
  area,
  collection,
  ctx,
  docs,
  mode,
  item,
  values,
  errors,
  locale,
}: {
  readonly area: AreaSpec;
  readonly collection: CollectionSpec;
  readonly ctx: AreaContext;
  readonly docs: Docs;
  readonly mode: EditMode;
  readonly item: ItemView | null;
  readonly values: FieldValues;
  readonly errors: Readonly<Record<string, string>>;
  readonly locale: string;
}) {
  const fields = collection.fields(docs, ctx, mode, mode === 'new' ? null : (item?.key ?? null));
  const title =
    mode === 'new'
      ? ctx.t('ui.newTitle')
      : mode === 'duplicate'
        ? ctx.t('ui.duplicateTitle', { item: item?.title ?? '' })
        : ctx.t('ui.editTitle', { item: item?.title ?? '' });
  const base = area.href(locale);
  return (
    <Card testId="area-editor">
      <form
        method="get"
        action={base}
        noValidate
        style={{ display: 'grid', gap: spacingTokens.xs }}
      >
        <h2 style={{ margin: 0, ...typographyTokens.h2 }}>{title}</h2>
        <p style={{ ...muted, marginBlockEnd: spacingTokens.sm }}>{ctx.t(collection.title)}</p>
        <input type="hidden" name="view" value="preview" />
        <input type="hidden" name="c" value={collection.id} />
        <input type="hidden" name="mode" value={mode} />
        {item ? <input type="hidden" name="item" value={item.key} /> : null}
        {Object.keys(errors).length > 0 ? (
          <Banner tone="error" testId="area-field-errors">
            <ul style={{ margin: 0, paddingInlineStart: spacingTokens.md }}>
              {Object.values(errors).map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </Banner>
        ) : null}
        <ContentGrid min="20rem" gap={spacingTokens.md}>
          {/* A short name cannot change once made, and is the platform's own
              key for the item: an edit leaves it out rather than show it. */}
          {fields
            .filter((field) => !(mode === 'edit' && field.lockedOnEdit === true))
            .map((field) => (
              <FieldControl
                key={field.id}
                field={field}
                value={values[field.id]}
                now={mode === 'edit' ? item?.values[field.id] : undefined}
                error={errors[field.id]}
                ctx={ctx}
              />
            ))}
        </ContentGrid>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: spacingTokens.xs,
            marginBlockStart: spacingTokens.sm,
          }}
        >
          {/* Nothing to choose anywhere (D-571): no change can be made here, so
              no "Check the change" — the empty field says where to go. */}
          {nothingToChoose(fields) ? null : (
            <button type="submit" className={buttonClass('primary')} data-testid="area-check">
              {ctx.t('a.check')}
            </button>
          )}
          <ActionLink href={base} variant="ghost" testId="area-cancel">
            {ctx.t('a.cancel')}
          </ActionLink>
        </div>
      </form>
    </Card>
  );
}

/** Every field is a choice list with nothing in it: the editor can change nothing. */
function nothingToChoose(fields: readonly FieldSpec[]): boolean {
  return (
    fields.length > 0 &&
    fields.every((field) => field.kind === 'multi' && (field.options ?? []).length === 0)
  );
}

function FieldControl({
  field,
  value,
  now,
  error,
  ctx,
}: {
  readonly field: FieldSpec;
  readonly value: FieldValue | undefined;
  readonly now: FieldValue | undefined;
  readonly error: string | undefined;
  readonly ctx: AreaContext;
}) {
  const label =
    labelOf(ctx, field.label) +
    (field.unit && field.kind === 'number' ? ` (${ctx.t(field.unit)})` : '');
  // S5: the field is `.bs-control.bs-field`; an error is its `data-tone`.
  const tone = error ? 'error' : undefined;
  const extra = (
    <>
      {now !== undefined ? (
        <p style={{ ...muted, marginBlockStart: '4px' }} data-testid={`field-${field.id}-now`}>
          {ctx.t('ui.now', { value: displayValue(field, now, ctx) })}
        </p>
      ) : null}
      {field.impact ? (
        <p style={{ ...muted, marginBlockStart: '2px' }} data-testid={`field-${field.id}-impact`}>
          {ctx.t(field.impact)}
        </p>
      ) : null}
    </>
  );

  if (field.kind === 'multi') {
    const chosen = Array.isArray(value) ? (value as readonly string[]) : [];
    return (
      <fieldset
        style={{ border: 0, margin: 0, padding: 0, minInlineSize: 0 }}
        data-testid={`field-${field.id}`}
      >
        <legend style={{ ...typographyTokens.bodySm, fontWeight: 600, padding: 0 }}>{label}</legend>
        <p style={{ ...muted, marginBlock: '4px' }}>{ctx.t(field.help)}</p>
        {(field.options ?? []).length === 0 && field.empty ? (
          <Banner tone="warning" testId={`field-${field.id}-empty`}>
            <span>{ctx.t(field.empty.text)} </span>
            <ActionLink
              href={`/${ctx.locale}${field.empty.path}`}
              testId={`field-${field.id}-empty-link`}
            >
              {ctx.t(field.empty.link)}
            </ActionLink>
          </Banner>
        ) : null}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: spacingTokens.xs }}>
          {(field.options ?? []).map((option) => (
            <label
              key={option.value}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                ...typographyTokens.bodySm,
              }}
            >
              <input
                type="checkbox"
                name={fieldName(field.id)}
                value={option.value}
                defaultChecked={chosen.includes(option.value)}
                data-testid={`field-${field.id}-${option.value}`}
              />
              {typeof option.label === 'string' ? ctx.t(option.label) : option.label.literal}
            </label>
          ))}
        </div>
        {error ? (
          <p
            role="alert"
            style={{ margin: '4px 0 0', ...typographyTokens.caption, color: colorTokens.danger }}
          >
            {error}
          </p>
        ) : null}
        {extra}
      </fieldset>
    );
  }

  if (field.kind === 'money') {
    const minor = value && typeof value === 'object' && 'kind' in value ? value.minor : {};
    return (
      <fieldset
        style={{ border: 0, margin: 0, padding: 0, minInlineSize: 0 }}
        data-testid={`field-${field.id}`}
      >
        <legend style={{ ...typographyTokens.bodySm, fontWeight: 600, padding: 0 }}>{label}</legend>
        <p style={{ ...muted, marginBlock: '4px' }}>{ctx.t(field.help)}</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: spacingTokens.xs }}>
          {(field.currencies ?? ctx.currencies).map((currency) => (
            <label
              key={currency}
              style={{ display: 'grid', gap: '2px', ...typographyTokens.caption }}
            >
              <span dir="ltr">{currency}</span>
              <input
                type="text"
                inputMode="decimal"
                dir="ltr"
                name={fieldName(field.id, currency)}
                defaultValue={minorToMajorInput(minor[currency] ?? 0, currency)}
                className={FIELD_CLASS}
                data-tone={tone}
                style={{ maxInlineSize: '10rem' }}
                data-testid={`field-${field.id}-${currency}`}
              />
            </label>
          ))}
        </div>
        {error ? (
          <p
            role="alert"
            style={{ margin: '4px 0 0', ...typographyTokens.caption, color: colorTokens.danger }}
          >
            {error}
          </p>
        ) : null}
        {extra}
      </fieldset>
    );
  }

  let control: ReactNode;
  switch (field.kind) {
    case 'switch':
      control = (
        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: spacingTokens.xs,
            ...typographyTokens.bodySm,
          }}
        >
          <input
            type="checkbox"
            role="switch"
            id={idOf(field)}
            name={fieldName(field.id)}
            value="on"
            defaultChecked={value === true}
            data-testid={`field-${field.id}`}
          />
          {ctx.t('w.on')}
        </label>
      );
      break;
    case 'choice':
      control = (
        <select
          id={idOf(field)}
          name={fieldName(field.id)}
          defaultValue={String(value ?? '')}
          className={FIELD_CLASS}
          data-tone={tone}
          data-testid={`field-${field.id}`}
        >
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {typeof option.label === 'string' ? ctx.t(option.label) : option.label.literal}
            </option>
          ))}
        </select>
      );
      break;
    case 'number':
      control = (
        <div
          style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: spacingTokens.xs }}
        >
          <input
            type="number"
            inputMode="numeric"
            step={1}
            min={field.min}
            max={field.max}
            id={idOf(field)}
            name={fieldName(field.id)}
            defaultValue={value === null || value === undefined ? '' : String(value)}
            className={FIELD_CLASS}
            data-tone={tone}
            style={{ maxInlineSize: '10rem' }}
            dir="ltr"
            data-testid={`field-${field.id}`}
          />
          {field.unit ? (
            <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
              {ctx.t(field.unit)}
            </span>
          ) : null}
          {field.unlimited ? (
            <label
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                ...typographyTokens.bodySm,
              }}
            >
              <input
                type="checkbox"
                name={fieldName(field.id, 'none')}
                value="on"
                defaultChecked={value === null}
                data-testid={`field-${field.id}-none`}
              />
              {ctx.t('w.noLimit')}
            </label>
          ) : null}
        </div>
      );
      break;
    case 'times':
      control = (
        <input
          type="text"
          id={idOf(field)}
          name={fieldName(field.id)}
          defaultValue={Array.isArray(value) ? (value as readonly string[]).join(', ') : ''}
          placeholder="10:00, 16:00"
          dir="ltr"
          className={FIELD_CLASS}
          data-tone={tone}
          data-testid={`field-${field.id}`}
        />
      );
      break;
    default:
      control = (
        <input
          type="text"
          id={idOf(field)}
          name={fieldName(field.id)}
          defaultValue={typeof value === 'string' ? value : ''}
          maxLength={field.maxLength}
          dir={field.dir}
          className={FIELD_CLASS}
          data-tone={tone}
          data-testid={`field-${field.id}`}
        />
      );
  }
  return (
    <div>
      <Field
        label={label}
        htmlFor={idOf(field)}
        hint={ctx.t(field.help)}
        error={error}
        required={field.required === true}
      >
        {control}
      </Field>
      <div style={{ marginBlockStart: `calc(-1 * ${spacingTokens.sm})` }}>{extra}</div>
    </div>
  );
}

function Preview({
  area,
  collection,
  ctx,
  mode,
  itemKey,
  edit,
  locale,
}: {
  readonly area: AreaSpec;
  readonly collection: CollectionSpec;
  readonly ctx: AreaContext;
  readonly mode: EditMode;
  readonly itemKey: string | null;
  readonly edit: Exclude<ReturnType<typeof prepareEdit>, { missing: true }>;
  readonly locale: string;
}) {
  const base = area.href(locale);
  const formValues = toQuery(edit.fields, edit.values);
  const back = hrefWith(base, {
    view: 'edit',
    c: collection.id,
    mode,
    item: itemKey,
    ...formValues,
  });
  const afterItem = collection.items(edit.after, ctx).find((i) => i.key === edit.targetKey) ?? null;
  const plan =
    afterItem?.previewKind === 'plan' ? planPreview(edit.after, edit.targetKey, ctx) : null;
  return (
    <Confirm
      testId="area-preview"
      title={ctx.t('ui.previewTitle')}
      intro={
        mode === 'edit'
          ? ctx.t('ui.previewIntro')
          : ctx.t('ui.added', { item: afterItem?.title ?? edit.targetKey })
      }
      changes={edit.changes}
      impacts={edit.impacts}
      problems={edit.unchanged ? [ctx.t('ui.unchanged')] : edit.problems}
      ctx={ctx}
      base={back}
      backLabel={ctx.t('a.back')}
      action={saveAreaItemAction}
      submit={ctx.t('a.save')}
      hidden={{
        locale,
        area: area.key,
        c: collection.id,
        mode,
        item: itemKey ?? '',
        ...formValues,
      }}
      extra={
        plan ? (
          <section>
            <h3 style={{ margin: 0, ...typographyTokens.h3 }}>{ctx.t('ui.customerPreview')}</h3>
            <PlanCardBody preview={plan} ctx={ctx} />
          </section>
        ) : null
      }
    />
  );
}

function Confirm({
  testId,
  title,
  intro,
  changes,
  impacts,
  problems,
  ctx,
  base,
  backLabel,
  action,
  submit,
  hidden,
  extra,
}: {
  readonly testId: string;
  readonly title: string;
  readonly intro: string | null;
  readonly changes: readonly ChangeLine[];
  readonly impacts: readonly string[];
  readonly problems: readonly string[];
  readonly ctx: AreaContext;
  readonly base: string;
  readonly backLabel?: string;
  readonly action: (formData: FormData) => Promise<void>;
  readonly submit: string;
  readonly hidden: Record<string, string | readonly string[]>;
  readonly extra?: ReactNode;
}) {
  return (
    <Card testId={testId}>
      <div style={{ display: 'grid', gap: spacingTokens.md }}>
        <h2 style={{ margin: 0, ...typographyTokens.h2 }}>{title}</h2>
        {intro ? <p style={body}>{intro}</p> : null}
        {changes.length > 0 ? (
          <section>
            <h3 style={{ margin: 0, ...typographyTokens.h3 }}>{ctx.t('ui.changes')}</h3>
            <ul
              style={{
                margin: `${spacingTokens.xs} 0 0`,
                paddingInlineStart: spacingTokens.md,
                ...typographyTokens.bodySm,
              }}
              data-testid={`${testId}-changes`}
            >
              {changes.map((line) => (
                <li key={line.label}>
                  {ctx.t('ui.changeLine', {
                    field: line.label,
                    before: line.before,
                    after: line.after,
                  })}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {impacts.length > 0 ? (
          <section>
            <h3 style={{ margin: 0, ...typographyTokens.h3 }}>{ctx.t('ui.customers')}</h3>
            <ul
              style={{
                margin: `${spacingTokens.xs} 0 0`,
                paddingInlineStart: spacingTokens.md,
                ...typographyTokens.bodySm,
              }}
              data-testid={`${testId}-impacts`}
            >
              {impacts.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>
        ) : null}
        {extra}
        {problems.length > 0 ? (
          <Banner tone="error" testId={`${testId}-problems`}>
            <div>
              <strong>{ctx.t('ui.cannotSave')}</strong>
              <ul style={{ margin: 0, paddingInlineStart: spacingTokens.md }}>
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </div>
          </Banner>
        ) : (
          <form
            action={action}
            style={{ display: 'grid', gap: spacingTokens.sm, justifyItems: 'start' }}
          >
            {Object.entries(hidden).flatMap(([name, value]) =>
              (Array.isArray(value) ? value : [value]).map((entry, index) => (
                <input key={`${name}-${index}`} type="hidden" name={name} value={entry as string} />
              )),
            )}
            <div style={{ inlineSize: '100%', maxInlineSize: '36rem' }}>
              <Field label={ctx.t('ui.note')} htmlFor={`${testId}-note`}>
                <input
                  type="text"
                  id={`${testId}-note`}
                  name="note"
                  maxLength={300}
                  placeholder={ctx.t('ui.notePlaceholder')}
                  className={FIELD_CLASS}

                  data-testid={`${testId}-note`}
                />
              </Field>
            </div>
            <label
              style={{
                display: 'flex',
                gap: spacingTokens.xs,
                alignItems: 'start',
                ...typographyTokens.bodySm,
                maxInlineSize: '40rem',
              }}
            >
              <input
                type="checkbox"
                name="confirm"
                value="yes"
                required
                data-testid={`${testId}-confirm`}
              />
              {ctx.t('ui.confirm')}
            </label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: spacingTokens.xs }}>
              <button
                type="submit"
                className={buttonClass('primary')}
                data-testid={`${testId}-submit`}
              >
                {submit}
              </button>
              <ActionLink href={base} variant="ghost" testId={`${testId}-back`}>
                {backLabel ?? ctx.t('a.cancel')}
              </ActionLink>
            </div>
          </form>
        )}
        {problems.length > 0 ? (
          <div>
            <ActionLink href={base} testId={`${testId}-back`}>
              {backLabel ?? ctx.t('a.back')}
            </ActionLink>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

/**
 * A KEPT HALF-SAVED CHANGE, IF IT IS STILL HALF-SAVED: re-run against the
 * documents live now, it would still change something. Otherwise (someone
 * finished it, or the item is gone) there is nothing to say.
 */
async function stillMissing(
  partial: PartialChange,
  area: AreaSpec,
  docs: Docs,
  ctx: AreaContext,
): Promise<(PartialChange & { readonly collection: CollectionSpec }) | null> {
  const collection = area.collections.find((candidate) => candidate.id === partial.c);
  if (!collection) return null;
  const context: ConfigContext = await getConfigService().getContext(currentEnvironment());
  if (partial.kind === 'archive') {
    const archive = prepareArchive({ collection, docs, ctx, context, itemKey: partial.item });
    if (!archive) return null;
    const changes = (Object.keys(archive.after) as ConfigDomain[]).some(
      (domain) => !sameJson(archive.after[domain], docs[domain]),
    );
    return changes ? { ...partial, collection } : null;
  }
  const source = {
    get: (name: string) => partial.values.find(([key]) => key === name)?.[1] ?? null,
    getAll: (name: string) =>
      partial.values.filter(([key]) => key === name).map(([, value]) => value),
  };
  const edit = prepareEdit({
    collection,
    docs,
    ctx,
    context,
    mode: 'edit',
    itemKey: partial.item,
    source,
  });
  return 'missing' in edit || edit.unchanged ? null : { ...partial, collection };
}

/** "Saved: …. Not saved: …." — one message, and the one button that finishes it. */
function PartialNotice({
  partial,
  collection,
  ctx,
  locale,
}: {
  readonly partial: PartialChange;
  readonly collection: CollectionSpec;
  readonly ctx: AreaContext;
  readonly locale: string;
}) {
  const part = (domain: ConfigDomain) => {
    const key = collection.parts?.[domain];
    return key ? ctx.t(key) : domainName(locale, domain);
  };
  const why =
    partial.why === 'DRAFT_OPEN'
      ? 'ui.partial.whyDraft'
      : partial.why === 'INVALID'
        ? 'ui.partial.whyInvalid'
        : 'ui.partial.whyOther';
  return (
    <Banner tone="warning" testId="area-partial">
      <div style={{ display: 'grid', gap: spacingTokens.xs }}>
        <strong>{ctx.t('ui.partial.title')}</strong>
        <span data-testid="area-partial-saved">
          {ctx.t('ui.partial.saved', { what: listJoin(locale, partial.saved.map(part)) })}
        </span>
        <span data-testid="area-partial-not-saved">
          {ctx.t('ui.partial.notSaved', { what: part(partial.failed) })}
        </span>
        <span data-testid="area-partial-why">{ctx.t(why)}</span>
        <form action={retryPartAction}>
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="confirm" value="yes" />
          <button type="submit" className={buttonClass('primary')} data-testid="area-partial-retry">
            {ctx.t('ui.partial.retry')}
          </button>
        </form>
      </div>
    </Banner>
  );
}
