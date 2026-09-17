import { colorTokens, spacingTokens, typographyTokens, CONTROL_CLASS } from '@brandspace/ui';
import { ORB_AREAS, ORB_SLOTS, areaDefinition, localizedFrom } from '@brandspace/brand-brain';
import { requireWorkspace } from '../../../server/customer-context';
import { brandContextFor, requiredBrand } from '../../../server/brand-context';
import { inBrandBrain } from '../../../server/brand-brain-context';
import { translator, type MessageKey } from '../../../i18n/messages';
import { CustomerBanner, WorkspaceShell } from '../../../components/workspace-shell';
import { statusMessage } from '../../../i18n/messages';
import {
  BrandBrainView,
  type AreaCardData,
  type CandidateData,
  type OrbNode,
  type SourceData,
} from './brand-brain-view';

/*
 * The approved demo's stylesheet, transcribed. It is imported here rather than
 * in the layout so that only this route pays for it.
 */
import '@brandspace/ui/brand-brain.css';
import { createBrandAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * Brand Brain — the customer screen.
 *
 * EVERY NUMBER ON THIS PAGE IS COMPUTED. The approved demo showed 82%, 128
 * items and 4 sources; none of those appear here. Completion comes from
 * `computeBrandCompletion` over ACTIVE knowledge, the counts are `count()`
 * queries, and an empty Brand Brain reads 0% rather than borrowing the demo's
 * encouraging number.
 *
 * The page is a SERVER component: it reads under RLS inside the workspace
 * context and hands the client only what the screen renders. The interactive
 * parts — the orb, the drawer, the chat — are the client island below it.
 */
export default async function BrandBrainPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const t = translator(locale);
  const { customer, workspace } = await requireWorkspace(locale, 'brand_brain.read');

  const permissions = workspace.permissionKeys;
  const can = (key: string) => permissions.includes(key);

  /*
   * THE BRAND THIS SCREEN IS ABOUT, CHOSEN RATHER THAN GUESSED (D-190).
   *
   * THIS IS THE SCREEN THE SILENT GUESS LIVED ON. It used to take the
   * workspace's OLDEST brand — `findFirst` ordered by `createdAt` — so a member
   * with four brands arrived already editing one of them, with nothing on the
   * page saying which, and an upload or a knowledge edit landed wherever that
   * query happened to point.
   *
   * The scope is still applied IN THE QUERY (D-132, F-74); what changed is that
   * a member with several brands is now ASKED. `requiredBrand` returns null for
   * every shape but "exactly one brand is selected", so the no-brand branch
   * below cannot be skipped by accident.
   */
  const brandContext = await brandContextFor(
    workspace,
    '/brand-brain',
    typeof query['brand'] === 'string' ? query['brand'] : null,
  );
  const brand = requiredBrand(brandContext);

  const status = typeof query['ok'] === 'string' ? (query['ok'] as string) : null;
  const error = typeof query['error'] === 'string' ? (query['error'] as string) : null;

  // The real outcome, in the reader's language, with the correlation id on a
  // failure — the one value that joins this screen to the redacted server log.
  const reference = typeof query['ref'] === 'string' ? (query['ref'] as string) : undefined;
  const successText = status ? statusMessage(status, locale) : null;
  const errorText = error ? statusMessage(error, locale, reference) : null;

  const banner = successText ? (
    <CustomerBanner tone="success">{successText}</CustomerBanner>
  ) : errorText ? (
    <CustomerBanner tone="error">{errorText}</CustomerBanner>
  ) : error ? (
    <CustomerBanner tone="error">{t('bb.chatError')}</CustomerBanner>
  ) : null;

  // NO BRAND YET. A real, expected state for a new workspace — not an error,
  // and not an empty dashboard that leaves the customer guessing what to do.
  if (!brand) {
    /*
     * TWO DIFFERENT ABSENCES, AND THE READER IS TOLD WHICH. "This workspace has
     * no brand yet" is an invitation to create one; "you have several and have
     * not said which" is a request to choose. Showing the create form for the
     * second would offer to solve a problem the reader does not have.
     */
    const unselected = brandContext.resolution.kind === 'unselected';

    return (
      <WorkspaceShell
        brandContext={brandContext}
        locale={locale}
        heading={t('bb.title')}
        description={t('bb.heroBody')}
        activePath="/brand-brain"
        workspaceName={workspace.workspaceName}
        roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
        customerName={customer.name ?? customer.email}
        permissionKeys={permissions}
      >
        {banner}
        <section
          data-testid="brand-brain-no-brand"
          style={{
            padding: spacingTokens.xl,
            borderRadius: '24px',
            background: colorTokens.surfaceCardAlpha,
            display: 'grid',
            gap: spacingTokens.md,
            justifyItems: 'start',
          }}
        >
          <h2 style={{ margin: 0, ...typographyTokens.h2 }}>
            {unselected ? t('brand.chooseTitle') : t('bb.noBrand')}
          </h2>
          <p style={{ margin: 0, color: colorTokens.textMuted }}>
            {unselected ? t('brand.chooseBody') : t('bb.noBrandBody')}
          </p>
          {!unselected && can('brand.manage') ? (
            <form action={createBrandAction} style={{ display: 'flex', gap: spacingTokens.sm }}>
              <input type="hidden" name="locale" value={locale} />
              <input
                className={CONTROL_CLASS}
                name="name"
                required
                maxLength={120}
                aria-label={t('bb.brandName')}
                placeholder={t('bb.brandName')}
                data-testid="new-brand-name"
                style={{
                  padding: '10px 12px',
                  borderRadius: 12,
                  border: `1px solid ${colorTokens.border}`,
                  font: 'inherit',
                }}
              />
              <button
                type="submit"
                data-testid="create-brand"
                style={{
                  border: 0,
                  borderRadius: 12,
                  padding: '10px 16px',
                  background: colorTokens.brandPurple,
                  color: colorTokens.brandPurpleInk,
                  fontWeight: 700,
                  cursor: 'pointer',
                  font: 'inherit',
                }}
              >
                {t('bb.createBrand')}
              </button>
            </form>
          ) : null}
        </section>
      </WorkspaceShell>
    );
  }

  const { policy, completion, items, candidates, sources, sourceCount } = await inBrandBrain(
    workspace.workspaceId,
    async ({ knowledge, db, policy }) => {
      const computed = await knowledge.completion(brand.id);
      return {
        /*
         * READ, NOT WRITTEN DOWN HERE. The retention window the chat notice
         * states is whatever an owner activated — see brand-brain-context.ts
         * for how it crosses the platform/tenant boundary (CLAUDE.md §2.2).
         */
        policy: await policy(),
        completion: computed,
        items: await db.brandKnowledgeItem.findMany({
          where: { brandId: brand.id, status: { in: ['ACTIVE', 'STALE'] } },
          orderBy: [{ area: 'asc' }, { itemKey: 'asc' }],
          select: {
            id: true,
            area: true,
            itemKey: true,
            title: true,
            body: true,
            origin: true,
            version: true,
            status: true,
            confidenceMilli: true,
          },
          // Bounded: a brand with thousands of items must not send them all to
          // a browser. The drawer pages the rest.
          take: 400,
        }),
        candidates: can('brand_brain.review')
          ? await db.brandKnowledgeCandidate.findMany({
              where: { brandId: brand.id, status: 'PENDING' },
              orderBy: { createdAt: 'desc' },
              take: 50,
              select: {
                id: true,
                area: true,
                itemKey: true,
                extractedTitle: true,
                extractedBody: true,
                confidenceMilli: true,
                evidence: true,
                targetItemId: true,
              },
            })
          : [],
        sources: await db.brandSourceDocument.findMany({
          where: { brandId: brand.id, deletedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 25,
          select: {
            id: true,
            fileName: true,
            status: true,
            pageCount: true,
            chunkCount: true,
            failureMessage: true,
          },
        }),
        sourceCount: await db.brandSourceDocument.count({
          where: { brandId: brand.id, deletedAt: null },
        }),
      };
    },
  );

  const itemsByArea = new Map<string, typeof items>();
  for (const item of items) {
    const list = itemsByArea.get(item.area) ?? [];
    list.push(item);
    itemsByArea.set(item.area, list);
  }

  const areaCards: AreaCardData[] = completion.areas.map((area) => {
    const definition = areaDefinition(area.area);
    return {
      area: area.area,
      label: t(`bb.area.${definition.messageKey}` as MessageKey),
      description: t(`bb.area.${definition.messageKey}.desc` as MessageKey),
      status: area.status,
      statusLabel: t(`bb.status.${area.status}` as MessageKey),
      activeItems: area.activeItems,
      requiredItems: area.requiredItems,
      pendingCandidates: area.pendingCandidates,
      ratioMilli: area.ratioMilli,
      attention: area.attention.map((reason) => t(`bb.attention.${reason}` as MessageKey)),
      items: (itemsByArea.get(area.area) ?? []).map((item) => ({
        id: item.id,
        itemKey: item.itemKey,
        title: pick(localizedFrom(item.title), locale),
        body: pick(localizedFrom(item.body), locale),
        origin: item.origin,
        originLabel: t(`bb.origin.${item.origin}` as MessageKey),
        version: item.version,
        stale: item.status === 'STALE',
      })),
    };
  });

  /*
   * The orb's six nodes. The demo shows six dots and eight cards; the product
   * shows the same six dots and all ten of its areas below the hero (D-87), and
   * each dot carries the workspace's own count rather than the demo's "12 facts".
   */
  const byArea = new Map(areaCards.map((card) => [card.area, card]));
  const orbNodes: OrbNode[] = ORB_AREAS.flatMap((area) => {
    const card = byArea.get(area);
    if (!card) return [];
    return [
      {
        area,
        slot: ORB_SLOTS[area as keyof typeof ORB_SLOTS],
        label: card.label,
        detail: `${card.activeItems} ${t('bb.itemsCount')}`,
      },
    ];
  });

  const candidateData: CandidateData[] = candidates.map((candidate) => ({
    id: candidate.id,
    area: candidate.area,
    itemKey: candidate.itemKey,
    title: pick(localizedFrom(candidate.extractedTitle), locale),
    body: pick(localizedFrom(candidate.extractedBody), locale),
    confidencePercent: Math.round(candidate.confidenceMilli / 10),
    evidence: evidenceLabels(candidate.evidence),
    replacesExisting: candidate.targetItemId !== null,
  }));

  const sourceData: SourceData[] = sources.map((source) => ({
    id: source.id,
    fileName: source.fileName,
    kind: documentKind(source.fileName),
    status: source.status,
    statusLabel: t(`bb.source.${source.status}` as MessageKey),
    /*
     * A FAILURE IS TRANSLATED, NOT ECHOED.
     *
     * `failureMessage` holds a stable reason key, so the customer reads why in
     * their own language and never reads a parser's own words — which name
     * offsets, object numbers and library versions, and belong in an operator
     * log (CLAUDE.md §4 and docs/SECURITY.md).
     */
    detail:
      source.status === 'FAILED'
        ? failureText(source.failureMessage, t)
        : source.pageCount
          ? `${source.pageCount} · ${source.chunkCount}`
          : `${source.chunkCount}`,
  }));

  return (
    <WorkspaceShell
      locale={locale}
      heading={t('bb.title')}
      activePath="/brand-brain"
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={customer.name ?? customer.email}
      permissionKeys={permissions}
    >
      {banner}
      <BrandBrainView
        locale={locale}
        brandId={brand.id}
        completionPercent={completion.percent}
        totalActiveItems={completion.totalActiveItems}
        sourceCount={sourceCount}
        orbNodes={orbNodes}
        areas={areaCards}
        candidates={candidateData}
        sources={sourceData}
        retentionDays={policy.chat.retentionDays}
        permissions={{
          edit: can('brand_brain.edit'),
          upload: can('brand_brain.upload'),
          review: can('brand_brain.review'),
          remove: can('brand_brain.delete'),
          chat: can('brand_brain.chat'),
        }}
      />
    </WorkspaceShell>
  );
}

/**
 * A stored failure reason, in the reader's language.
 *
 * An unrecognised key falls back to the general message rather than printing
 * the key itself: a reason added on the server before a translation exists must
 * not surface as `archive_unsafe_entry` on a customer's screen.
 */
function failureText(reason: string | null, t: (key: MessageKey) => string): string {
  if (!reason) return t('bb.failure.extraction_failed');
  const key = `bb.failure.${reason}` as MessageKey;
  // `translator` returns undefined for a key the catalogue does not have. The
  // cast above is what makes that possible, so the check is not defensive
  // noise — it is the guard the cast removed.
  const translated = t(key) as string | undefined;
  return translated ?? t('bb.failure.extraction_failed');
}

/**
 * The badge the demo prints in the corner of a source row.
 *
 * Derived from the file's own name — never from the browser-declared MIME type,
 * which a caller controls. It is decorative and `aria-hidden`, so a name with no
 * extension falls back to a neutral mark rather than to a guess.
 */
function documentKind(fileName: string): string {
  const match = /\.([A-Za-z0-9]{1,5})$/.exec(fileName);
  const extension = match?.[1]?.toUpperCase();
  if (!extension) return '\u2022';
  if (extension === 'JPEG') return 'JPG';
  if (extension === 'MARKDOWN') return 'MD';
  return extension.slice(0, 4);
}

/** The reader's locale, falling back to the other rather than rendering blank. */
function pick(text: { en?: string | undefined; ar?: string | undefined }, locale: string): string {
  return (locale === 'ar' ? (text.ar ?? text.en) : (text.en ?? text.ar)) ?? '';
}

/**
 * Evidence, reduced to what a customer can act on: where it came from.
 *
 * Never the raw stored object — it carries ids that mean nothing on a screen.
 */
function evidenceLabels(evidence: unknown): string[] {
  if (!Array.isArray(evidence)) return [];
  return evidence
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const record = entry as Record<string, unknown>;
      const locator = typeof record['locator'] === 'string' ? record['locator'] : null;
      const quote = typeof record['quote'] === 'string' ? record['quote'] : null;
      if (!locator && !quote) return null;
      return [locator, quote].filter(Boolean).join(' — ');
    })
    .filter((value): value is string => value !== null)
    .slice(0, 3);
}
