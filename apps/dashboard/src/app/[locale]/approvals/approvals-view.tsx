import type React from 'react';
import Link from 'next/link';
import { MoreDisclosure } from '../../../components/more-disclosure';
import {
  AbstractMedia,
  AssetThumb,
  SegmentPill,
  type LinkTab,
  type MediaSeed,
} from '@brandspace/ui';
import type { MessageKey } from '../../../i18n/messages';

/**
 * The Approvals screen — the prototype's (`Main.dc.html` lines 567–598, D-468
 * batch 3), wired to the product's approval cycles.
 *
 * The composition is the prototype's: a 330px card with the "Waiting for me" /
 * "Sent by me" switch and the list, beside the card of the review being
 * decided — the post as it will look, its facts, the note, and the three
 * verdicts. A queue opens on its first review, as the prototype's does.
 *
 * EVERY PANEL IS GATED BY A SERVER-RESOLVED FLAG, not by a link being left out.
 * A member who may read content but not approve sees "what you sent" and no
 * verdict controls; the flags say what the server already decided — they never
 * decide anything themselves.
 *
 * A SERVER COMPONENT WITH FORMS, and no client JavaScript beyond the switch's
 * sliding pill. Every control is a `<form>` posting to a server action, so the
 * screen works with scripting unavailable and every decision is enforced where
 * it must be.
 */

export interface ApprovalRow {
  readonly id: string;
  readonly itemId: string;
  readonly itemTitle: string;
  readonly brandName: string;
  readonly status: 'PENDING' | 'APPROVED' | 'CHANGES_REQUESTED' | 'REJECTED' | 'CANCELLED';
  readonly requestedByLabel: string;
  readonly requestedAtLabel: string;
  readonly cycle: number;
  readonly requestNote: string | null;
  /** Server-resolved. The button is hidden because this is false, never the reverse. */
  readonly mayDecide: boolean;
  /** True when the reader submitted it and the brand forbids self-approval. */
  readonly blockedAsSelf: boolean;
  /** Q10 — "Assigned to you" / "Assigned to Sara", or null when nobody is. */
  readonly assignedToLabel: string | null;
  /** B5 — on "Sent": who decided, and the reason they gave. */
  readonly decidedByLabel?: string | null;
  readonly decisionNote?: string | null;
  readonly mayWithdraw: boolean;
  /**
   * Whether to offer the Studio link — a link that refuses the person who
   * follows it is what §20 forbids. Every reader of this screen now holds
   * `content.read` (D-62), so this is true in practice; it stays a prop
   * because the composer's gate is the composer's to state, not this screen's
   * to assume.
   */
  readonly mayOpenInStudio: boolean;
  /** Round 3 — the post's real first picture (an expiring grant), or none. */
  readonly cover?: ApprovalCover | null | undefined;
  /** Round 3 — the row's second line: "From Omar · 2 hours ago". */
  readonly fromLabel?: string | undefined;
}

/** A post's first picture, as `firstPictures` resolves it. */
export type ApprovalCover =
  { readonly kind: 'image'; readonly src: string } | { readonly kind: 'video' };

/** The narrowest thing a reviewer needs in order to decide. */
export interface ReviewSubjectView {
  readonly approvalId: string;
  readonly itemId: string;
  readonly itemTitle: string;
  readonly brandName: string;
  readonly cycle: number;
  readonly requestNote: string | null;
  readonly requestedByLabel: string;
  readonly mayDecide: boolean;
  /** Round 4 (5.1) — the reader sent it and the brand forbids self-approval. */
  readonly blockedAsSelf?: boolean | undefined;
  /**
   * PHASE 6 FINAL (D-288) — the post as it will look, and the conversation
   * about it, beside the verdict. Rendered by the page (the preview is the
   * composer's own adapter; the conversation is the ordinary Notes panel).
   */
  readonly previews?: React.ReactNode;
  readonly conversation?: React.ReactNode;
  /** Round 3 — the cover card: the first picture and the first caption. */
  readonly cover?: ApprovalCover | null | undefined;
  readonly caption?: string | undefined;
  /** Round 5 (F1) — the headline designed on the cover image; '' when there is none. */
  readonly coverHeadline?: string | undefined;
  /** "From Omar · 2 hours ago" under the title. */
  readonly fromLabel?: string | undefined;
  /** The planned time ("Oct 16 · 10:00"), or the words for none. */
  readonly requestedTimeLabel?: string | undefined;
  /**
   * Batch 7 PR C (B1.3) — the post carries a proposed time and this reviewer
   * may also schedule: the approve button reads "Approve & schedule".
   */
  readonly approveSchedules?: boolean | undefined;
  /** The campaign's name, or the words for none. */
  readonly campaignLabel?: string | undefined;
  readonly variants: readonly {
    readonly id: string;
    readonly platformKey: string;
    readonly body: string;
    readonly hashtags: readonly string[];
    /**
     * PHASE 8 — THE MEDIA THIS REVIEWER IS APPROVING (AC-29.1).
     *
     * A reviewer who cannot see the picture is approving a caption, not a post.
     * Each carries an expiring, per-viewer preview grant issued by the same
     * download service the Asset Library uses — never a storage key, never a
     * signed url from a column.
     */
    readonly media: readonly {
      readonly id: string;
      readonly name: string;
      readonly kind: string;
      readonly previewToken: string | null;
    }[];
  }[];
}

export interface BrandPolicyRow {
  readonly brandId: string;
  readonly brandName: string;
  readonly requireApprovalBeforeScheduling: boolean;
  readonly allowSelfApproval: boolean;
}

const STATUS_X: Record<ApprovalRow['status'], string> = {
  PENDING: 'bsp-warn',
  APPROVED: '',
  CHANGES_REQUESTED: 'bsp-warn',
  REJECTED: 'bsp-bad',
  CANCELLED: 'bsp-neu',
};

/**
 * The prototype's 52px picture: the post's own first picture (round 3), and
 * the abstract art only for a post with none — or a video, which is not drawn
 * as a broken image.
 */
function RowArt({
  id,
  cover,
}: {
  readonly id: string;
  readonly cover?: ApprovalCover | null | undefined;
}) {
  return (
    <span className="bsp-apr-art" aria-hidden="true">
      {cover?.kind === 'image' ? (
        <img src={cover.src} alt="" />
      ) : (
        <AbstractMedia seed={(id.charCodeAt(0) % 6) as MediaSeed} alt="" />
      )}
    </span>
  );
}

export function ApprovalsView({
  locale,
  t,
  queue,
  mine,
  review,
  tab,
  tabs,
  mayReview,
  mayReadContent,
  actions,
}: {
  readonly locale: string;
  readonly t: (key: MessageKey) => string;
  readonly queue: readonly ApprovalRow[];
  readonly mine: readonly ApprovalRow[];
  readonly review: ReviewSubjectView | null;
  /** B5 — which list is showing, and the two links between them. */
  readonly tab: 'forMe' | 'sent';
  readonly tabs: readonly LinkTab[];
  readonly mayReview: boolean;
  readonly mayReadContent: boolean;
  readonly actions: {
    decide(formData: FormData): Promise<void>;
    withdraw(formData: FormData): Promise<void>;
  };
}) {
  const selected = review?.approvalId ?? null;
  return (
    <div className="bsp-apr">
      <div className="bsp-apr-grid">
        <div className="bsp-apr-side">
          <section
            className="bsp-card bsp-apr-list"
            data-testid={tab === 'forMe' ? 'approvals-queue' : 'approvals-mine'}
          >
            <div className="bsp-apr-tabs-pad">
              <nav
                className="bsp-seg bsp-apr-tabs"
                aria-label={t('approvals.tabs.label')}
                data-testid="approvals-tabs"
              >
                <SegmentPill selector='[aria-current="page"]' />
                {tabs.map((link) => (
                  <Link
                    key={link.id}
                    href={link.href}
                    aria-current={link.id === tab ? 'page' : undefined}
                    data-testid={`approvals-tab-${link.id}`}
                  >
                    {link.label}
                    {link.id === 'forMe' && mayReview ? (
                      <span className="bsp-ltr"> {queue.length}</span>
                    ) : null}
                  </Link>
                ))}
              </nav>
              {/*
                Round 4 (5.1) — no "⋯" beside the tabs: the prototype's queue
                has none. The approval rules are Settings → Approvals (A8), in
                the Settings menu, for the permission that may change them.
              */}
            </div>

            {tab === 'forMe' ? (
              !mayReview ? (
                <div className="bsp-apr-empty">
                  <b>{t('approvals.noPermissionTitle')}</b>
                  <span>{t('approvals.noPermissionBody')}</span>
                </div>
              ) : queue.length === 0 ? (
                <div className="bsp-apr-empty">
                  <b>{t('approvals.queueEmptyTitle')}</b>
                  <span>{t('approvals.queueEmptyBody')}</span>
                </div>
              ) : (
                <ul className="bsp-apr-rows" data-testid="approvals-queue-list">
                  {queue.map((row) => (
                    <li key={row.id} data-testid={`approval-${row.itemId}`}>
                      {/*
                        THE REVIEW CONTEXT, not the content library. The row
                        opens the review it belongs to, which is what a reader of
                        this screen wants from it; opening the draft for EDITING
                        is offered on the review itself.
                      */}
                      <Link
                        className="bsp-apr-row"
                        href={`/${locale}/approvals?review=${row.id}`}
                        aria-current={row.id === selected ? 'true' : undefined}
                      >
                        <RowArt id={row.itemId || row.id} cover={row.cover} />
                        {/*
                          Round 3 — the prototype's two lines: the title, then
                          who sent it and when, with who it is assigned to.
                        */}
                        <span className="bsp-apr-copy">
                          <span className="bsp-apr-title" dir="auto">
                            {row.itemTitle}
                          </span>
                          <span className="bsp-apr-meta">
                            {row.fromLabel ??
                              `${t('approvals.requestedBy')} ${row.requestedByLabel} · ${row.requestedAtLabel}`}
                            {row.assignedToLabel ? (
                              <span data-testid={`assigned-to-${row.itemId}`}>
                                {` · ${row.assignedToLabel}`}
                              </span>
                            ) : null}
                          </span>
                          {!row.mayDecide && row.blockedAsSelf ? (
                            /*
                             * D-122. The reader submitted this and the brand
                             * forbids self-approval, so it says so rather than
                             * silently omitting the verdict — a control that
                             * vanishes without explanation reads as a bug. The
                             * server refuses it regardless.
                             */
                            <span
                              className="bsp-apr-meta bsp-apr-warn"
                              data-testid={`self-blocked-${row.itemId}`}
                            >
                              {t('approvals.selfBlocked')}
                            </span>
                          ) : null}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )
            ) : null}

            {/*
              "What you sent" belongs to members who can send. A Viewer has never
              opened a cycle, so the panel is withheld rather than shown empty —
              and the page does not query it for them either.
            */}
            {tab === 'sent' && mayReadContent ? (
              mine.length === 0 ? (
                <div className="bsp-apr-empty">
                  <b>{t('approvals.mineEmptyTitle')}</b>
                  <span>{t('approvals.mineEmptyBody')}</span>
                  <Link
                    className="bsp-btn bsp-sm bsp-sec bsp-apr-start"
                    href={`/${locale}/content?status=DRAFT`}
                    data-testid="approvals-mine-empty-action"
                  >
                    {t('approvals.mineEmptyAction')}
                  </Link>
                </div>
              ) : (
                <ul className="bsp-apr-rows" data-testid="approvals-mine-list">
                  {mine.map((row) => (
                    <li
                      key={row.id}
                      className="bsp-apr-sent"
                      data-testid={`mine-${row.itemId}`}
                      aria-current={row.id === selected ? 'true' : undefined}
                    >
                      <RowArt id={row.itemId || row.id} cover={row.cover} />
                      <span className="bsp-apr-copy">
                        <Link
                          className="bsp-apr-title bsp-apr-link"
                          href={`/${locale}/approvals?review=${row.id}&tab=sent`}
                          dir="auto"
                        >
                          {row.itemTitle}
                        </Link>
                        <span className="bsp-apr-meta">
                          <span
                            className={`bsp-xstatus ${STATUS_X[row.status]}`}
                            data-testid={`approval-status-${row.itemId}`}
                          >
                            {t(`approvals.status.${row.status}` as MessageKey)}
                          </span>{' '}
                          {row.assignedToLabel ?? row.brandName} · {row.requestedAtLabel}
                        </span>
                        {row.decidedByLabel ? (
                          <span className="bsp-apr-meta" data-testid={`decided-by-${row.itemId}`}>
                            {row.decidedByLabel}
                          </span>
                        ) : null}
                        {row.decisionNote ? (
                          <span
                            className="bsp-apr-meta bsp-apr-note"
                            dir="auto"
                            data-testid={`decision-note-${row.itemId}`}
                          >
                            {row.decisionNote}
                          </span>
                        ) : null}
                        {row.mayOpenInStudio && row.itemId ? (
                          <Link
                            className="bsp-apr-studio"
                            href={`/${locale}/content/compose?item=${row.itemId}`}
                            data-testid={`open-in-studio-${row.itemId}`}
                          >
                            {t('calendar.openInStudio')}
                          </Link>
                        ) : null}
                      </span>
                      {row.mayWithdraw ? (
                        <form action={actions.withdraw}>
                          <input type="hidden" name="locale" value={locale} />
                          <input type="hidden" name="approvalId" value={row.id} />
                          <input type="hidden" name="tab" value={tab} />
                          <button
                            type="submit"
                            className="bsp-btn bsp-sm bsp-sec"
                            data-testid={`withdraw-${row.itemId}`}
                          >
                            {t('approvals.withdraw')}
                          </button>
                        </form>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )
            ) : null}
          </section>
        </div>

        {/*
          THE REVIEW BEING DECIDED: the post as it will look, the captions and
          media under review, the requester's note, and the verdicts. It is
          authorized per approval inside the service, so rendering it here
          discloses nothing the reader could not already fetch.
        */}
        {review ? (
          <section className="bsp-card bsp-apr-detail" data-testid="approvals-review-subject">
            {/*
              ROUND 3 — THE PROTOTYPE'S POST: the large square cover with the
              caption in the card under it (`Main.dc.html` line 585). The
              product's preview of every channel version (D-288) and the post's
              conversation are kept, each behind a compact disclosure under it.
            */}
            <div className="bsp-apr-left">
              <div className="bsp-apr-prev" data-testid="review-cover">
                <div className="bsp-apr-cover">
                  {review.cover?.kind === 'image' ? (
                    <img src={review.cover.src} alt="" />
                  ) : (
                    <AbstractMedia seed={(review.itemId.charCodeAt(0) % 6) as MediaSeed} alt="" />
                  )}
                  {/*
                    Round 5 (F1): the headline DESIGNED on the cover, when the
                    post has one. Without it the title (the caption's opening)
                    was drawn large over the picture and hid it; the caption
                    stays in its card under the cover.
                  */}
                  {review.coverHeadline ? (
                    <span
                      className="bsp-apr-overlay"
                      dir="auto"
                      aria-hidden="true"
                      data-testid="review-cover-headline"
                    >
                      {review.coverHeadline}
                    </span>
                  ) : null}
                </div>
                {review.caption ? (
                  <div className="bsp-apr-caption" dir="auto">
                    {review.caption}
                  </div>
                ) : null}
              </div>
            </div>
            <div className="bsp-apr-side-col">
              <div>
                <div className="bsp-apr-h" dir="auto">
                  {review.itemTitle}
                </div>
                <div className="bsp-apr-sub">
                  {review.fromLabel ?? `${t('approvals.requestedBy')} ${review.requestedByLabel}`}
                </div>
              </div>
              <div className="bsp-apr-facts">
                <div>
                  <span>{t('approvals.channels')}</span>
                  <span className="bsp-ltr">
                    {review.variants
                      .map((variant) => t(`content.platform.${variant.platformKey}` as MessageKey))
                      .join(' · ')}
                  </span>
                </div>
                <div>
                  <span>{t('approvals.requestedTime')}</span>
                  <span data-testid="review-requested-time">
                    {review.requestedTimeLabel ?? t('approvals.noTime')}
                  </span>
                </div>
                <div>
                  <span>{t('approvals.campaign')}</span>
                  <span dir="auto" data-testid="review-campaign">
                    {review.campaignLabel ?? t('approvals.noCampaign')}
                  </span>
                </div>
              </div>
              {review.mayDecide ? (
                <DecisionForm
                  locale={locale}
                  t={t}
                  approvalId={review.approvalId}
                  itemId={review.itemId}
                  tab={tab}
                  andSchedule={review.approveSchedules === true}
                  action={actions.decide}
                />
              ) : review.blockedAsSelf ? (
                /*
                 * Round 4 (5.1) — WHERE THE VERDICTS WOULD BE, the reason there
                 * are none (D-122): the reader sent it and the brand forbids
                 * self-approval. The server refuses it regardless.
                 */
                <p
                  className="bsp-apr-blocked"
                  role="note"
                  data-testid={`self-blocked-review-${review.itemId}`}
                >
                  {t('approvals.selfBlocked')}
                </p>
              ) : null}
              {/*
                Round 4 (5.1) — ONE "⋯", for what the prototype does not draw:
                every channel's preview and versions, the post's notes, and
                opening it in the Studio. Nothing was removed; it is all here.
              */}
              <MoreDisclosure
                label={t('approvals.everyChannel')}
                testId="approvals-review-more"
                align="start"
              >
                <details className="bsp-apr-more" data-testid="review-channels-more">
                  <summary>
                    <span>{t('approvals.everyChannel')}</span>
                    <span className="bsp-ltr">{review.variants.length}</span>
                  </summary>
                  {review.previews ? (
                    <div className="bsp-apr-prev-list" data-testid="review-previews">
                      {review.previews}
                    </div>
                  ) : null}
                  {review.requestNote ? (
                    <p className="bsp-apr-quote" dir="auto">
                      {review.requestNote}
                    </p>
                  ) : null}
                  <ul className="bsp-apr-variants" data-testid="review-variants">
                    {review.variants.map((variant) => (
                      <li key={variant.id}>
                        <span className="bsp-lbl">
                          {t(`content.platform.${variant.platformKey}` as MessageKey)}
                        </span>
                        <p dir="auto">{variant.body}</p>
                        {variant.hashtags.length > 0 ? (
                          <span className="bsp-apr-meta">
                            {variant.hashtags.map((h) => `#${h}`).join(' ')}
                          </span>
                        ) : null}
                        {/*
                          WHAT IS ACTUALLY BEING APPROVED (AC-29.1). The thumbnails
                          are the media the publish pipeline will send — the same
                          asset ids, in the same order — so a reviewer's decision is
                          about the post rather than about its words.
                        */}
                        {variant.media.length > 0 ? (
                          <ul
                            className="bsp-apr-media"
                            data-testid={`approval-media-${variant.id}`}
                          >
                            {variant.media.map((item) => (
                              <li key={item.id}>
                                {item.previewToken ? (
                                  <AssetThumb
                                    src={`/${locale}/assets/file/${item.previewToken}`}
                                    alt={item.name}
                                    size="var(--bsp-rem-3-5)"
                                    testId={`approval-media-thumb-${item.id}`}
                                  />
                                ) : (
                                  <span className="bsp-apr-meta">{item.name}</span>
                                )}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </details>
                {review.conversation ? (
                  /* C1 — the post's notes as a compact card, never a full-width block. */
                  <details className="bsp-apr-more bsp-apr-notes" data-testid="review-notes-more">
                    <summary>
                      <span>{t('approvals.notes')}</span>
                      <span className="bsp-apr-open">{t('approvals.openConversation')}</span>
                    </summary>
                    <div className="bsp-apr-thread">{review.conversation}</div>
                  </details>
                ) : null}
                {mayReadContent ? (
                  <>
                    <Link
                      className="bsp-apr-studio"
                      href={`/${locale}/content/compose?item=${review.itemId}`}
                    >
                      {t('calendar.openInStudio')}
                    </Link>
                    <span className="bsp-apr-meta">
                      {review.brandName} · {t('approvals.cycle')} {review.cycle}
                    </span>
                  </>
                ) : null}
              </MoreDisclosure>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The three verdicts, in one place: the prototype's note and its Approve,
 * Request changes and Reject.
 */
function DecisionForm({
  locale,
  t,
  approvalId,
  itemId,
  tab,
  andSchedule,
  action,
}: {
  readonly locale: string;
  readonly t: (key: MessageKey) => string;
  readonly approvalId: string;
  readonly itemId: string;
  readonly tab: 'forMe' | 'sent';
  readonly andSchedule: boolean;
  readonly action: (formData: FormData) => Promise<void>;
}) {
  /*
   * B5 — THE REASON IS REQUIRED FOR "REQUEST CHANGES", and only for it: the
   * field is `required`, and Approve and Reject skip the browser's validation
   * (`formNoValidate`). The server refuses a blank reason either way.
   */
  return (
    <form action={action} className="bsp-apr-form">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="approvalId" value={approvalId} />
      <input type="hidden" name="tab" value={tab} />
      <label className="bsp-apr-label" htmlFor={`note-${approvalId}`}>
        {t('approvals.decisionNote')}
      </label>
      <textarea
        id={`note-${approvalId}`}
        className="bs-control bsp-apr-textarea"
        name="note"
        dir="auto"
        required
        placeholder={t('approvals.notePlaceholder')}
        maxLength={1000}
        data-testid={`decision-note-input-${itemId}`}
      />
      <div className="bsp-apr-verdicts">
        <button
          type="submit"
          name="verdict"
          value={andSchedule ? 'APPROVE_SCHEDULE' : 'APPROVE'}
          formNoValidate
          className="bsp-btn bsp-pur"
          data-testid={`approve-${itemId}`}
          data-schedules={andSchedule ? 'true' : undefined}
        >
          {t(andSchedule ? 'approvals.approveSchedule' : 'approvals.approve')}
        </button>
        <button
          type="submit"
          name="verdict"
          value="REQUEST_CHANGES"
          className="bsp-btn bsp-sec"
          data-testid={`request-changes-${itemId}`}
        >
          {t('approvals.requestChanges')}
        </button>
        <button
          type="submit"
          name="verdict"
          value="REJECT"
          formNoValidate
          className="bsp-btn bsp-ghost bsp-apr-reject"
          data-testid={`reject-${itemId}`}
        >
          {t('approvals.reject')}
        </button>
      </div>
      {/*
        The prototype's line under the verdicts, in words true of this product:
        approving clears the post to be scheduled; it does not schedule it (B5).
      */}
      <span className="bsp-apr-hint" data-testid={`approve-hint-${itemId}`}>
        {t(andSchedule ? 'approvals.approveScheduleHint' : 'approvals.approveHint')}
      </span>
    </form>
  );
}
