import { colorTokens, spacingTokens, typographyTokens, CONTROL_CLASS } from '@brandspace/ui';
import { maySpendCredits } from '@brandspace/shared';
import {
  BRAND_MEMORY_LAYERS,
  ORB_AREAS,
  ORB_SLOTS,
  areaDefinition,
  confidenceExplanation,
  confidenceLabel,
  isExpired,
  isoDateOf,
  localizedFrom,
  mayOverwrite,
  memoryRank,
  questionsForBrand,
  sourceKnowledge,
  workspaceKnowledgeAsOf,
  usedInPostsCounts,
} from '@brandspace/brand-brain';
import { formatBytes } from '../../../components/format-bytes';
import { TenantOnboardingPolicySource, offersQuestionSetFor } from '@brandspace/onboarding';
import { currentEnvironment, requireWorkspacePage } from '../../../server/customer-context';
import { NoAccessPage } from '../../../components/no-access-page';
import { analyticsEvidence, conflictNote } from '../../../server/learning-review';
import { brandContextFor, requiredBrand } from '../../../server/brand-context';
import { lookDataFor } from '../../../server/brand-fonts';
import { inBrandBrain } from '../../../server/brand-brain-context';
import { translator, type MessageKey } from '../../../i18n/messages';
import { copilotHref } from '../../../server/copilot-surface';
import { CustomerBanner, WorkspaceShell } from '../../../components/workspace-shell';
import { NotesPanel } from '../../../components/notes-panel';
import { statusMessage } from '../../../i18n/messages';
import {
  BrandBrainView,
  type AreaCardData,
  type BrandBrainTab,
  type CandidateData,
  type OrbNode,
  type SourceData,
  type VoiceData,
} from './brand-brain-view';
import type { ChatStart } from './brand-chat';

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
  const access = await requireWorkspacePage(locale, '/brand-brain');
  const { messageLocale } = access.session;
  const t = translator(messageLocale);
  if (!access.allowed) return <NoAccessPage locale={locale} access={access} />;
  const { customer, workspace } = access.session;

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

  const {
    policy,
    completion,
    items,
    candidates,
    sources,
    sourceCount,
    asOf,
    confident,
    usedInPosts,
  } = await inBrandBrain(workspace.workspaceId, async ({ knowledge, db, policy }) => {
    /*
     * Q19 — COMPLETENESS IS KEY QUESTIONS PER AREA, answered by usable facts
     * (approved, not expired). The questions are configuration; Offers takes
     * the set the brand's industry names (D-329). "Today" is the workspace's
     * own calendar day (D6).
     */
    const resolved = await policy();
    const [asOf, onboarding, brandRow] = await Promise.all([
      workspaceKnowledgeAsOf(db),
      new TenantOnboardingPolicySource(db, currentEnvironment()).load(),
      db.brand.findFirst({ where: { id: brand.id }, select: { industry: true } }),
    ]);
    const computed = await knowledge.completion(
      brand.id,
      questionsForBrand(
        resolved.questions,
        offersQuestionSetFor(brandRow?.industry ?? null, onboarding.industries),
      ),
      asOf,
    );
    return {
      asOf,
      /*
       * D4 + C1 — the preview for "Accept the confident ones": the configured
       * threshold, never a conflict. The same rule the action re-applies.
       */
      confident: can('brand_brain.review')
        ? await knowledge.confidentCandidates({
            brandId: brand.id,
            minimumConfidenceMilli: resolved.review.confidentAcceptMilli,
            brandScope: workspace.brandScope,
          })
        : [],
      /*
       * READ, NOT WRITTEN DOWN HERE. The retention window the chat notice
       * states is whatever an owner activated — see brand-brain-context.ts
       * for how it crosses the platform/tenant boundary (CLAUDE.md §2.2).
       */
      policy: resolved,
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
          /*
           * THE MEMORY LAYER (P6-07).
           *
           * The screen showed WHERE an item came from — human, document, AI —
           * and never WHICH OF THE FOUR MEMORIES it lives in. That is half the
           * model, and the half that decides precedence: Canonical outranks
           * Strategy outranks Content outranks Learning, always, and not as a
           * tie-break (`memoryRank`). A reader could see that a fact was
           * AI-inferred but not that it sat in the lowest-authority layer and
           * therefore could never overwrite anything above it.
           */
          memory: true,
          version: true,
          status: true,
          confidenceMilli: true,
          // D-294 — provenance on every value: when, who, from what.
          updatedAt: true,
          createdByUserId: true,
          sourceDocumentId: true,
          // D6 — shown, and an expired fact says it is not used in writing.
          validUntil: true,
        },
        // Bounded: a brand with thousands of items must not send them all to
        // a browser. The drawer pages the rest.
        take: 400,
      }),
      candidates: can('brand_brain.review')
        ? await db.brandKnowledgeCandidate.findMany({
            where: { brandId: brand.id, status: 'PENDING' },
            // D4 — the one inbox works through the queue oldest first.
            orderBy: { createdAt: 'asc' },
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
              /*
               * P6-11 — WHERE IT CAME FROM AND WHAT IT CONTRADICTS. The queue
               * showed neither, so an analytics inference and a document
               * extract looked identical, and a learning that disagreed with
               * a human-approved fact was presented as if it did not.
               */
              sourceKind: true,
              insightId: true,
              conflictsWithItemId: true,
              // D7 (Phase 2C-3) — who sent a MEMBER proposal for review.
              proposedByUserId: true,
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
          mimeType: true,
          byteSize: true,
          storageKey: true,
          createdAt: true,
          status: true,
          pageCount: true,
          chunkCount: true,
          failureMessage: true,
        },
      }),
      sourceCount: await db.brandSourceDocument.count({
        where: { brandId: brand.id, deletedAt: null },
      }),
      /*
       * D6 remainder (Phase 2C-3) — "Used in N posts": distinct posts, not
       * deleted or archived, whose CURRENT recorded usage (M5) holds the fact
       * at any version. A count only; no post is named.
       */
      usedInPosts: await usedInPostsCounts(db, { brandId: brand.id }),
    };
  });

  /*
   * D-294 — WHO ADDED A VALUE AND WHICH DOCUMENT IT CAME FROM, by name. Read
   * under the workspace's own RLS: members of this workspace, documents of
   * this brand. An id that resolves to nothing simply shows no name.
   */
  const provenanceNames = await inBrandBrain(workspace.workspaceId, async ({ db }) => {
    const userIds = [
      ...new Set([
        ...items.flatMap((item) => (item.createdByUserId ? [item.createdByUserId] : [])),
        ...candidates.flatMap((candidate) =>
          candidate.proposedByUserId ? [candidate.proposedByUserId] : [],
        ),
      ]),
    ];
    const documentIds = [
      ...new Set(items.flatMap((item) => (item.sourceDocumentId ? [item.sourceDocumentId] : []))),
    ];
    const [members, documents] = await Promise.all([
      userIds.length
        ? db.membership.findMany({
            where: { userId: { in: userIds } },
            select: { userId: true, user: { select: { name: true, email: true } } },
          })
        : [],
      documentIds.length
        ? db.brandSourceDocument.findMany({
            where: { id: { in: documentIds }, brandId: brand.id },
            select: { id: true, fileName: true },
          })
        : [],
    ]);
    return {
      people: new Map(
        members.map((member) => [member.userId, member.user.name?.trim() || member.user.email]),
      ),
      documents: new Map(documents.map((document) => [document.id, document.fileName])),
    };
  });
  const provenanceDay = new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', {
    dateStyle: 'medium',
    timeZone: 'UTC',
  });
  const provenanceOf = (item: (typeof items)[number]): string =>
    [
      `${t('bb.provenance.updated')} ${provenanceDay.format(item.updatedAt)}`,
      item.createdByUserId && provenanceNames.people.get(item.createdByUserId)
        ? `${t('bb.provenance.by')} ${provenanceNames.people.get(item.createdByUserId)}`
        : null,
      item.sourceDocumentId && provenanceNames.documents.get(item.sourceDocumentId)
        ? `${t('bb.provenance.from')} ${provenanceNames.documents.get(item.sourceDocumentId)}`
        : null,
    ]
      .filter(Boolean)
      .join(' · ');

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
      activeItems: area.usableItems,
      answered: area.answered,
      total: area.total,
      /*
       * Q19 — the area's key questions, in the reader's language, each with
       * the key of the fact that answers it: the drawer lists them and turns
       * an unanswered one into the add form's key and placeholder.
       */
      questions: area.questions.map((question) => ({
        itemKey: question.itemKey,
        prompt: pick(question.prompt, locale),
        answered: question.answered,
      })),
      pendingCandidates: area.pendingCandidates,
      attention: area.attention.map((reason) => t(`bb.attention.${reason}` as MessageKey)),
      attentionCodes: area.attention,
      items: (itemsByArea.get(area.area) ?? []).map((item) => ({
        id: item.id,
        itemKey: item.itemKey,
        title: pick(localizedFrom(item.title), locale),
        body: pick(localizedFrom(item.body), locale),
        origin: item.origin,
        originLabel: t(`bb.origin.${item.origin}` as MessageKey),
        memory: item.memory,
        memoryLabel: t(`bb.memory.${item.memory}` as MessageKey),
        /*
         * THE AUTHORITY POSITION, FROM THE ENGINE RATHER THAN FROM A LIST HERE.
         *
         * `memoryRank` is what `comparePrecedence` and `mayOverwrite` actually
         * consult, so reading it is the difference between the screen EXPLAINING
         * the rule and the screen having its own opinion that happens to agree
         * today. 1 is the highest authority, which is the direction a reader
         * expects from a ranking.
         */
        memoryRank: memoryRank(item.memory) + 1,
        memoryDepth: BRAND_MEMORY_LAYERS.length,
        version: item.version,
        stale: item.status === 'STALE',
        /*
         * D6 — the fact's last valid day (a workspace-local date), and whether
         * that day has passed in the workspace's time zone. Separate from
         * `stale`: a stale fact is still used in writing, an expired one never.
         */
        validUntil: item.validUntil ? isoDateOf(item.validUntil) : null,
        expired: isExpired(item.validUntil, asOf),
        // For "Edit": both languages, as stored.
        edit: editableText(item.title, item.body),
        provenance: provenanceOf(item),
        usedInPosts: usedInPosts.get(item.id) ?? 0,
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
        // The prototype's node line is the area's own "n of m" (`a.sub`).
        detail:
          card.total > 0
            ? t('bb.keyQuestionsOf')
                .replace('{answered}', String(card.answered))
                .replace('{total}', String(card.total))
            : `${card.activeItems} ${t('bb.itemsCount')}`,
        done: card.status === 'COMPLETE',
      },
    ];
  });

  const itemTitles = new Map(
    items.map((item) => [item.id, pick(localizedFrom(item.title), locale) || item.itemKey]),
  );
  const reviewNumber = new Intl.NumberFormat(locale === 'ar' ? 'ar' : 'en');
  const reviewPercent = new Intl.NumberFormat(locale === 'ar' ? 'ar' : 'en', {
    style: 'percent',
    maximumFractionDigits: 1,
  });
  const reviewDay = new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
  /*
   * D4 — WHAT A CANDIDATE WOULD REPLACE, side by side. Either the approved fact
   * with its own key (accepting makes a new version of it) or the approved fact
   * it contradicts (accepting archives it as superseded). And whether a plain
   * accept is allowed at all: the SAME `mayOverwrite` the service applies — an
   * analytics learning never replaces a human, document or setup fact (owner
   * decision 2.a, D-65), so the inbox offers Reject or "Edit fact" instead.
   */
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const itemsByKey = new Map(items.map((item) => [`${item.area}:${item.itemKey}`, item]));
  const candidateData: CandidateData[] = candidates.map((candidate) => {
    const title = localizedFrom(candidate.extractedTitle);
    const body = localizedFrom(candidate.extractedBody);
    const fromAnalytics = candidate.sourceKind === 'ANALYTICS';
    // D7 — a member's own proposal ("Send for review"): lands as HUMAN.
    const fromMember = candidate.sourceKind === 'MEMBER';
    const replaced =
      (candidate.conflictsWithItemId ? itemsById.get(candidate.conflictsWithItemId) : null) ??
      (candidate.targetItemId ? itemsById.get(candidate.targetItemId) : null) ??
      itemsByKey.get(`${candidate.area}:${candidate.itemKey}`) ??
      null;
    const acceptAllowed = replaced
      ? mayOverwrite(
          {
            memory: replaced.memory,
            origin: replaced.origin,
            version: replaced.version,
            id: replaced.id,
          },
          {
            memory: areaDefinition(candidate.area).memory,
            origin: fromAnalytics ? 'AI_INFERRED' : fromMember ? 'HUMAN' : 'DOCUMENT',
            version: replaced.version + 1,
            id: candidate.id,
          },
        ).allowed
      : true;
    const label = confidenceLabel(candidate.confidenceMilli, policy.review);
    const why = confidenceExplanation(candidate);
    /*
     * THE NUMBERS THE INFERENCE WAS DRAWN FROM, in the reader's own language
     * and number format. Parsed rather than cast (learning-review.ts): a row
     * that does not match yields no sentence, and the link to the source
     * insight still stands.
     */
    const measured = fromAnalytics ? analyticsEvidence(candidate.evidence) : null;
    const conflict = conflictNote({
      conflictsWithItemId: candidate.conflictsWithItemId,
      titleOf: (id) => itemTitles.get(id) ?? null,
    });
    return {
      id: candidate.id,
      area: candidate.area,
      itemKey: candidate.itemKey,
      title: pick(title, locale),
      body: pick(body, locale),
      confidencePercent: Math.round(candidate.confidenceMilli / 10),
      // D4 — High / Medium / Low from the CONFIGURED thresholds, and why.
      confidenceLabel: t(`bb.confidence.${label}` as MessageKey),
      confidenceLevel: label,
      confidenceWhy: t(`bb.confidence.why.${why.reason}` as MessageKey).replace(
        '{hits}',
        reviewNumber.format(why.keywordHits ?? 0),
      ),
      areaLabel: t(`bb.area.${areaDefinition(candidate.area).messageKey}` as MessageKey),
      snippet: snippetOf(candidate.evidence),
      replaced: replaced
        ? {
            area: replaced.area,
            title: pick(localizedFrom(replaced.title), locale),
            body: pick(localizedFrom(replaced.body), locale),
          }
        : null,
      acceptAllowed,
      evidence: fromAnalytics || fromMember ? [] : evidenceLabels(candidate.evidence),
      replacesExisting: candidate.targetItemId !== null,
      source: fromAnalytics ? 'ANALYTICS' : fromMember ? 'MEMBER' : 'DOCUMENT',
      proposedBy: fromMember
        ? t('bb.reviewProposedBy').replace(
            '{name}',
            (candidate.proposedByUserId &&
              provenanceNames.people.get(candidate.proposedByUserId)) ||
              t('bb.reviewProposedByMember'),
          )
        : null,
      sourceHref:
        fromAnalytics && candidate.insightId && can('strategy.read')
          ? `/${locale}/intelligence?brand=${brand.id}&insight=${candidate.insightId}`
          : null,
      measured: measured
        ? t('bb.reviewMeasured')
            .replace('{metric}', t(`analytics.metric.${measured.metricKey}` as MessageKey))
            .replace('{observed}', reviewNumber.format(Number(measured.observedValue)))
            .replace('{baseline}', reviewNumber.format(Number(measured.baselineValue)))
            .replace('{deviation}', reviewPercent.format(measured.deviationMilli / 1_000))
            .replace('{from}', reviewDay.format(measured.periodStart))
            .replace('{to}', reviewDay.format(measured.periodEnd))
        : null,
      conflict: conflict
        ? conflict.title
          ? t('bb.reviewConflictNamed').replaceAll('{title}', conflict.title)
          : t('bb.reviewConflict')
        : null,
      edit: {
        titleEn: title.en ?? '',
        titleAr: title.ar ?? '',
        bodyEn: body.en ?? '',
        bodyAr: body.ar ?? '',
      },
    };
  });

  /*
   * D5 (Phase 2C-4) — WHAT EACH SOURCE IS RESPONSIBLE FOR: the approved facts
   * whose CURRENT version came from it and the proposals it is waiting on
   * (`sourceKnowledge`, the one ownership rule), and whether a read is running.
   */
  const sourceIds = sources.map((source) => source.id);
  const { owned, runningReads } = await inBrandBrain(workspace.workspaceId, async ({ db }) => ({
    owned: await sourceKnowledge(db, {
      brandId: brand.id,
      documentIds: sourceIds,
      brandScope: workspace.brandScope,
    }),
    runningReads: new Set(
      (
        await db.brandIngestionJob.findMany({
          where: {
            sourceDocumentId: { in: sourceIds },
            stage: { in: ['QUEUED', 'EXTRACTING', 'CHUNKING', 'EXTRACTING_FACTS'] },
          },
          select: { sourceDocumentId: true },
        })
      ).map((job) => job.sourceDocumentId),
    ),
  }));
  const areaLabelOf = (area: string) =>
    t(`bb.area.${areaDefinition(area as never).messageKey}` as MessageKey);
  const uploadedOn = new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', {
    dateStyle: 'medium',
  });

  const sourceData: SourceData[] = sources.map((source) => ({
    id: source.id,
    fileName: source.fileName,
    kind: documentKind(source.fileName),
    status: source.status,
    statusLabel: t(`bb.source.${source.status}` as MessageKey),
    meta: [
      sourceTypeLabel(source.mimeType, t),
      formatBytes(source.byteSize, locale),
      uploadedOn.format(source.createdAt),
    ].join(' · '),
    approvedCount: owned.get(source.id)?.facts.length ?? 0,
    pendingCount: owned.get(source.id)?.pending.length ?? 0,
    facts: (owned.get(source.id)?.facts ?? []).map((fact) => ({
      id: fact.itemId,
      title: pick(localizedFrom(fact.title as never), locale) || fact.itemKey,
      areaLabel: areaLabelOf(fact.area),
      stateLabel: isExpired(fact.validUntil, asOf)
        ? t('bb.source.state.expired')
        : t(`bb.source.state.${fact.status}` as MessageKey),
    })),
    pending: (owned.get(source.id)?.pending ?? []).map((candidate) => ({
      id: candidate.candidateId,
      title: pick(localizedFrom(candidate.title as never), locale) || candidate.itemKey,
      areaLabel: areaLabelOf(candidate.area),
      stateLabel: t('bb.source.state.PENDING'),
    })),
    // Stored bytes, and no read in flight: a file refused at the door has
    // nothing to read, and a second read waits for the first.
    canReadAgain: source.byteSize > 0 && source.storageKey !== '' && !runningReads.has(source.id),
    reading: runningReads.has(source.id),
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

  /*
   * D-294 — THE FOUR LAYERS, COUNTED. Approved values per memory (only ACTIVE
   * items; a stale value is still shown in its area but is not counted as
   * current knowledge), plus the learnings still waiting on a person.
   */
  const activeIn = (memory: string) =>
    items.filter((item) => item.status === 'ACTIVE' && item.memory === memory).length;
  const pendingLearnings = candidates.filter(
    (candidate) => candidate.sourceKind === 'ANALYTICS',
  ).length;
  const layers = (['CANONICAL', 'STRATEGY', 'CONTENT', 'LEARNING'] as const).map((memory) => ({
    key: memory,
    label: t(`bb.layer.${memory}` as MessageKey),
    description: t(`bb.layer.${memory}.desc` as MessageKey),
    count: activeIn(memory),
    pending: memory === 'LEARNING' ? pendingLearnings : 0,
  }));
  /*
   * Q19 — "WHAT'S MISSING": the first unanswered key questions, from the ONE
   * completeness calculation. Clicking one opens its area with the question as
   * the add form's placeholder and its key already set.
   */
  const cardLabel = new Map(areaCards.map((card) => [card.area, card.label]));
  // The prototype's one row of four (review of #67).
  const missing = completion.missing.slice(0, 4).map((entry) => ({
    area: entry.area,
    areaLabel: cardLabel.get(entry.area) ?? entry.area,
    itemKey: entry.question.itemKey,
    prompt: pick(entry.question.prompt, locale),
  }));

  /*
   * C4 + decision 2.b — THE VOICE CARD, from the one voice store: the
   * TONE_OF_VOICE area. Voice words are the fact `voice.words`; the other
   * TONE_OF_VOICE facts are tone facts; DO_DONT facts are Do (`do.*`) or Don't
   * (`dont.*`) rules, and an older rule with neither prefix is listed as
   * "unsorted" for someone to re-file. `Brand.voiceProfile` is not read.
   */
  const cardItems = (area: string) => areaCards.find((card) => card.area === area)?.items ?? [];
  const voiceTone = cardItems('TONE_OF_VOICE');
  const voiceRules = cardItems('DO_DONT');
  const voice: VoiceData = {
    words: voiceTone.find((item) => item.itemKey === 'voice.words') ?? null,
    tone: voiceTone.filter((item) => item.itemKey !== 'voice.words'),
    dos: voiceRules.filter((item) => item.itemKey.startsWith('do.')),
    donts: voiceRules.filter((item) => item.itemKey.startsWith('dont.')),
    unsorted: voiceRules.filter(
      (item) => !item.itemKey.startsWith('do.') && !item.itemKey.startsWith('dont.'),
    ),
  };

  /*
   * D7 / D8 / D9 (Phase 2C-3) — the chat can open in a mode, prefilled:
   * `?tab=chat&mode=add&area=…&title=…&body=…&key=…` from the Copilot's "save
   * this fact" handoff or a miss in Ask, and `?tab=chat&mode=edit&fact=<id>`
   * from the Studio's "Fix it". A prefill is only a starting point: nothing is
   * saved until the person presses the button, and the server checks their
   * permission then. A fact id this reader cannot see simply opens Edit empty.
   */
  const param = (key: string, max: number): string | null =>
    typeof query[key] === 'string' ? (query[key] as string).slice(0, max) : null;
  const requestedMode = param('mode', 10);
  const fixFactId = param('fact', 40);
  const fixFact =
    requestedMode === 'edit' && can('brand_brain.edit') && fixFactId
      ? (items.find((item) => item.id === fixFactId) ?? null)
      : null;
  const chatStart: ChatStart | null =
    requestedMode === 'add' && can('brand_brain.edit')
      ? {
          mode: 'add',
          area: param('area', 40),
          title: param('title', 200),
          body: param('body', 2_000),
          itemKey: param('key', 120),
        }
      : requestedMode === 'edit' && can('brand_brain.edit')
        ? {
            mode: 'edit',
            fact: fixFact
              ? {
                  id: fixFact.id,
                  area: fixFact.area,
                  itemKey: fixFact.itemKey,
                  version: fixFact.version,
                  title: localizedFrom(fixFact.title),
                  body: localizedFrom(fixFact.body),
                  validUntil: fixFact.validUntil ? isoDateOf(fixFact.validUntil) : null,
                  expired: isExpired(fixFact.validUntil, asOf),
                }
              : null,
          }
        : null;

  /*
   * D12 (Phase 2C-4) — Home's "Brand Brain is missing: <question>" links here
   * with `?area=…&question=<key>`: the area opens with that question as the
   * add form's placeholder, exactly as clicking it under "What's missing"
   * does. Only a configured question of that area is honoured; anything else
   * opens nothing.
   */
  const askedArea = param('area', 40);
  const askedQuestion = param('question', 120);
  const initialFocus =
    askedArea && askedQuestion && !chatStart
      ? (() => {
          const card = areaCards.find((entry) => entry.area === askedArea);
          const question = card?.questions.find((entry) => entry.itemKey === askedQuestion);
          return card && question
            ? { area: card.area, itemKey: question.itemKey, prompt: question.prompt }
            : null;
        })()
      : null;

  const requestedTab = chatStart ? 'chat' : typeof query['tab'] === 'string' ? query['tab'] : '';
  const initialTab: BrandBrainTab = (['knowledge', 'look', 'sources', 'chat'] as const).includes(
    requestedTab as BrandBrainTab,
  )
    ? (requestedTab as BrandBrainTab)
    : 'knowledge';
  const areasWithKnowledge = areaCards.filter((area) => area.activeItems > 0).length;
  const readySourceCount = sources.filter((source) => source.status === 'READY').length;
  const understanding =
    completion.totalUsableItems === 0
      ? t('bb.understands.none')
      : t('bb.understands.some')
          .replace('{facts}', reviewNumber.format(completion.totalUsableItems))
          .replace('{areas}', reviewNumber.format(areasWithKnowledge))
          .replace('{total}', reviewNumber.format(areaCards.length))
          .replace('{sources}', reviewNumber.format(readySourceCount));

  // Phase 2C-2 — Look & voice: colours, logo and fonts, for a member who may read the brand.
  const look = can('brand.read')
    ? await lookDataFor({ session: access.session, locale, brandId: brand.id })
    : null;

  return (
    <WorkspaceShell
      /*
       * THE BRAND CONTEXT, ON THE PATH THAT HAS ONE.
       *
       * It was passed on this page's no-brand branch and dropped here, so the
       * two screens most about a brand lost the Brand Selector from the rail
       * the MOMENT a brand was actually chosen — a reader could pick a brand
       * and then have no way to change it without leaving the page. One shell,
       * one selector, on every route (D-190).
       */
      brandContext={brandContext}
      locale={locale}
      heading={t('bb.title')}
      // The prototype's eyebrow over "Brand Brain" is the brand's own name.
      eyebrow={brand.name}
      description={t('bb.pageSub')}
      activePath="/brand-brain"
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={customer.name ?? customer.email}
      permissionKeys={permissions}
    >
      {banner}
      {look ? (
        /*
         * PHASE 2C-2 — @font-face for the Look & voice previews: the offered
         * catalogue families (same-origin /fonts) and the brand's uploaded fonts
         * this reader may read (the authenticated font route). Built from
         * generated names and validated same-origin paths only; a declared face
         * is fetched only when text renders in it.
         */
        <style data-testid="brand-look-fonts" dangerouslySetInnerHTML={{ __html: look.css }} />
      ) : null}
      <BrandBrainView
        locale={locale}
        brandId={brand.id}
        brandName={brand.name}
        understanding={understanding}
        layers={layers}
        missing={missing}
        voice={voice}
        look={
          look
            ? {
                data: look,
                canManage: can('brand.manage'),
                canUpload: can('assets.upload'),
              }
            : null
        }
        initialTab={initialTab}
        initialFocus={initialFocus}
        focusCandidateId={typeof query['candidate'] === 'string' ? query['candidate'] : null}
        // The review card posts and comes back here: it stays open on the way back.
        reviewOpen={status === 'CANDIDATE_ACCEPTED' || status === 'CANDIDATE_REJECTED'}
        confident={confident.map((entry) => ({
          id: entry.id,
          title: pick(entry.title, locale) || entry.itemKey,
          areaLabel: cardLabel.get(entry.area) ?? entry.area,
          confidencePercent: Math.round(entry.confidenceMilli / 10),
        }))}
        copilotHref={can('copilot.use') ? copilotHref(locale, 'brand_brain') : null}
        profileHref={can('brand.read') ? `/${locale}/settings/brand?brand=${brand.id}` : null}
        answered={completion.areas.reduce((sum, area) => sum + area.answered, 0)}
        totalQuestions={completion.areas.reduce((sum, area) => sum + area.total, 0)}
        totalActiveItems={completion.totalUsableItems}
        sourceCount={sourceCount}
        orbNodes={orbNodes}
        areas={areaCards}
        candidates={candidateData}
        sources={sourceData}
        retentionDays={policy.chat.retentionDays}
        chatStart={chatStart}
        permissions={{
          edit: can('brand_brain.edit'),
          upload: can('brand_brain.upload'),
          review: can('brand_brain.review'),
          // E3 — archiving a fact needs `brand_brain.edit`, the same as the action.
          remove: can('brand_brain.edit'),
          // Q18 — a Brand Brain answer spends credits.
          chat: maySpendCredits(workspace.permissionKeys, 'brand_brain.chat'),
        }}
      />

      {/*
        THE BRAND-LEVEL CONVERSATION (P6-07, P6-09).
      
        Attached to the BRAND rather than to any one fact, because the questions
        that belong here are about the brand as a whole — whether the tone has
        moved, whether a rule still holds, what a conflicting pair should
        resolve to.
      
        AND IT IS STILL NOT BRAND KNOWLEDGE. A thread here reads beside the four
        memories and never enters them: a remark about the brand is not a fact
        the brand has decided, and promoting one is a deliberate act through
        this screen's own review, where it arrives with provenance. The
        separation is structural — `packages/collaboration` has no dependency on
        `packages/brand-brain` in either direction.
      */}
      <NotesPanel
        locale={locale}
        subject={{ type: 'BRAND', brandId: brand.id }}
        returnPath={`/${locale}/brand-brain`}
        highlightThreadId={typeof query['thread'] === 'string' ? query['thread'] : null}
      />
    </WorkspaceShell>
  );
}

/** English sentences older releases stored in `failureMessage`, and their keys. */
const LEGACY_FAILURE_SENTENCES: Readonly<Record<string, string>> = {
  'The uploaded file could not be read.': 'object_missing',
  'Processing took too long and was stopped.': 'stuck_timeout',
};

/**
 * A stored failure reason, in the reader's language.
 *
 * An unrecognised key falls back to the general message rather than printing
 * the key itself: a reason added on the server before a translation exists must
 * not surface as `archive_unsafe_entry` on a customer's screen.
 */
function failureText(reason: string | null, t: (key: MessageKey) => string): string {
  if (!reason) return t('bb.failure.extraction_failed');
  /*
   * PHASE 2C-4 — TWO OLDER ROWS STORED ENGLISH SENTENCES, not keys: a missing
   * object and the stuck-job sweep. Both now store their key; a row written
   * before that is mapped to the same key here, derived from what it already
   * holds, so an Arabic reader never sees the English sentence.
   */
  const legacy = LEGACY_FAILURE_SENTENCES[reason];
  const key = `bb.failure.${legacy ?? reason}` as MessageKey;
  // `translator` returns undefined for a key the catalogue does not have. The
  // cast above is what makes that possible, so the check is not defensive
  // noise — it is the guard the cast removed.
  const translated = t(key) as string | undefined;
  return translated ?? t('bb.failure.extraction_failed');
}

/** The source's type in words, from the type it was accepted as (Phase 2C-4). */
function sourceTypeLabel(mimeType: string, t: (key: MessageKey) => string): string {
  const key = SOURCE_TYPE_KEYS[mimeType];
  return key ? t(key) : t('bb.source.type.other');
}

const SOURCE_TYPE_KEYS: Readonly<Record<string, MessageKey>> = {
  'application/pdf': 'bb.source.type.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'bb.source.type.docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':
    'bb.source.type.pptx',
  'text/plain': 'bb.source.type.text',
  'text/csv': 'bb.source.type.csv',
  'text/markdown': 'bb.source.type.markdown',
};

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

/** Both languages of a fact, for its Edit form. */
function editableText(
  title: unknown,
  body: unknown,
): { titleEn: string; titleAr: string; bodyEn: string; bodyAr: string } {
  const t = localizedFrom(title as never);
  const b = localizedFrom(body as never);
  return { titleEn: t.en ?? '', titleAr: t.ar ?? '', bodyEn: b.en ?? '', bodyAr: b.ar ?? '' };
}

/** D4 — the source's own words the candidate came from: its first quote. */
function snippetOf(evidence: unknown): string | null {
  if (!Array.isArray(evidence)) return null;
  const first = evidence[0] as Record<string, unknown> | undefined;
  return first && typeof first['quote'] === 'string' ? first['quote'] : null;
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
