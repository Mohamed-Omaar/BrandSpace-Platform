'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import {
  Dialog,
  Field,
  buttonStyle,
  inputStyle,
  spacingTokens,
  visuallyHiddenStyle,
} from '@brandspace/ui';

/**
 * THE POSTS "…" MENU — PORTED FROM `prototype-2026-09-27` (D-468 batch 2,
 * `Main.dc.html` line 557 and `moreItems`): the glass menu above the card's
 * action row, its items in the prototype's order, the campaign list as the
 * prototype's sub-menu (with ✓ and Back), and Archive's two steps inline
 * ("Archive", then "Sure? Archive").
 *
 * EVERY ITEM IS OFFERED ONLY WHEN THE PERMISSION AND THE POST'S STATE ALLOW IT,
 * and every item posts to the SAME server action the calendar, the Studio or
 * the library already used (B8) — the menu adds no new way to change a post:
 *
 *   Edit / Open        the Studio
 *   Duplicate          `duplicateContentAction` (`content.create`)
 *   Request approval   `submitForReviewAction` (`content.submit`) — the product's
 *   Schedule           the calendar's dialog, this post chosen (`content.schedule`)
 *   Move…              `rescheduleContentAction`, the calendar drawer's form
 *   Campaign           `setContentCampaignAction` — attach with `content.create`,
 *                      move or remove with `campaigns.manage` (Q21)
 *   Unschedule         `cancelScheduleAction`
 *   View on …          the published post's own link, `https:` only
 *   Archive / Restore  `transitionItemAction`, archive with its confirmation intent
 */

export interface PostMenuProps {
  readonly locale: string;
  readonly itemId: string;
  readonly status: string;
  readonly campaignId: string | null;
  /** The campaigns of THIS post's brand the reader may file it under. */
  readonly campaigns: readonly { readonly id: string; readonly name: string }[];
  /** The live plan, only when it can still move. */
  readonly slot: { readonly id: string; readonly date: string; readonly time: string } | null;
  readonly links: readonly { readonly label: string; readonly url: string }[];
  readonly today: string;
  /** The first item: the Studio, as Edit or Open. */
  readonly open: { readonly href: string; readonly label: string };
  /** A per-render key so a double-clicked Duplicate makes one copy. */
  readonly duplicateToken: string | null;
  readonly can: {
    readonly schedule: boolean;
    readonly archive: boolean;
    /** Q21 — attach a campaign to a post that has none. */
    readonly attachCampaign: boolean;
    /** Q21 — move a post to another campaign, or remove it. */
    readonly changeCampaign: boolean;
    readonly submit?: boolean;
  };
  readonly labels: Readonly<Record<string, string>>;
  readonly actions: {
    reschedule(formData: FormData): Promise<void>;
    cancel(formData: FormData): Promise<void>;
    transition(formData: FormData): Promise<void>;
    setCampaign(formData: FormData): Promise<void>;
    duplicate(formData: FormData): Promise<void>;
    submit(formData: FormData): Promise<void>;
  };
}

const ARCHIVABLE = new Set(['DRAFT', 'CHANGES_REQUESTED', 'APPROVED']);

export function PostMenu(props: PostMenuProps) {
  const { locale, itemId, status, campaignId, campaigns, slot, links, can, labels, actions } =
    props;
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState(false);
  const [sure, setSure] = useState(false);
  const [moving, setMoving] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const l = (key: string) => labels[key] ?? '';

  const mayMove = can.schedule && slot !== null;
  const mayArchive = can.archive && ARCHIVABLE.has(status);
  const mayRestore = can.archive && status === 'ARCHIVED';
  const mayCampaign =
    status !== 'PUBLISHED' &&
    status !== 'PUBLISHING' &&
    status !== 'PARTIALLY_PUBLISHED' &&
    status !== 'ARCHIVED' &&
    campaigns.length > 0 &&
    (campaignId === null ? can.attachCampaign : can.changeCampaign);
  const maySubmit = can.submit === true && (status === 'DRAFT' || status === 'CHANGES_REQUESTED');
  const maySchedule = can.schedule && (status === 'APPROVED' || status === 'DRAFT');
  const channelLinks = links.filter((link) => link.url.startsWith('https://'));

  const close = (focusTrigger: boolean) => {
    setOpen(false);
    setSub(false);
    setSure(false);
    if (focusTrigger) triggerRef.current?.focus();
  };

  // The menu closes on Escape and on a press outside it; on opening, the first
  // item takes focus and the arrow keys walk the items (the menu pattern).
  useEffect(() => {
    if (!open) return undefined;
    const items = () =>
      Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    items()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(true);
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const list = items();
      const at = list.indexOf(document.activeElement as HTMLElement);
      const next = event.key === 'ArrowDown' ? at + 1 : at - 1;
      list[(next + list.length) % list.length]?.focus();
    };
    const onDown = (event: PointerEvent) => {
      if (event.target instanceof Node && wrapRef.current?.contains(event.target)) return;
      close(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open, sub]);

  // Edit / Open is always the first item, and the card's own button already
  // opens the post: a menu with nothing else in it is not drawn (B8).
  const nothingElse =
    props.duplicateToken === null &&
    !maySubmit &&
    !maySchedule &&
    !mayMove &&
    !mayCampaign &&
    !mayArchive &&
    !mayRestore;
  if (nothingElse && channelLinks.length === 0) {
    return null;
  }

  const hidden = (
    <>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="returnTo" value="/content" />
    </>
  );

  return (
    <div ref={wrapRef} style={{ display: 'contents' }}>
      <button
        ref={triggerRef}
        type="button"
        className="bsp-btn bsp-sm bsp-sec"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={`post-menu-${itemId}`}
        onClick={() => (open ? close(false) : setOpen(true))}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="19" cy="12" r="1.8" />
        </svg>
        <span style={visuallyHiddenStyle()}>{l('content.menu.label')}</span>
      </button>
      {open ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label={l('content.menu.label')}
          className="bsp-post-menu"
          data-testid={`post-menu-${itemId}-menu`}
        >
          {sub ? (
            <>
              <button
                type="button"
                role="menuitem"
                className="bsp-post-menu-item"
                style={{ color: 'var(--bsp-faint)' }}
                onClick={() => setSub(false)}
              >
                ← {l('content.menu.back')}
              </button>
              {can.changeCampaign || campaignId === null ? (
                <form action={actions.setCampaign}>
                  {hidden}
                  <input type="hidden" name="itemId" value={itemId} />
                  <input type="hidden" name="campaignId" value="" />
                  <button
                    type="submit"
                    role="menuitem"
                    className="bsp-post-menu-item"
                    data-testid={`post-campaign-none-${itemId}`}
                  >
                    {campaignId === null ? '✓ ' : ''}
                    {l('content.campaign.none')}
                  </button>
                </form>
              ) : null}
              {campaigns.map((campaign) => (
                <form key={campaign.id} action={actions.setCampaign}>
                  {hidden}
                  <input type="hidden" name="itemId" value={itemId} />
                  <input type="hidden" name="campaignId" value={campaign.id} />
                  <button
                    type="submit"
                    role="menuitem"
                    className="bsp-post-menu-item"
                    style={
                      campaign.id === campaignId ? { color: 'var(--bsp-purple-ink)' } : undefined
                    }
                    data-testid={`post-campaign-${itemId}-${campaign.id}`}
                  >
                    {campaign.id === campaignId ? '✓ ' : ''}
                    {campaign.name}
                  </button>
                </form>
              ))}
            </>
          ) : (
            <>
              <Link
                href={props.open.href}
                role="menuitem"
                className="bsp-post-menu-item"
                data-testid={`content-menu-edit-${itemId}`}
              >
                {props.open.label}
              </Link>
              {props.duplicateToken !== null ? (
                <form action={actions.duplicate}>
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="itemId" value={itemId} />
                  <input type="hidden" name="token" value={`${props.duplicateToken}:${itemId}`} />
                  <button
                    type="submit"
                    role="menuitem"
                    className="bsp-post-menu-item"
                    data-testid={`content-duplicate-${itemId}`}
                  >
                    {l('content.menu.duplicate')}
                  </button>
                </form>
              ) : null}
              {maySubmit ? (
                <form action={actions.submit}>
                  {hidden}
                  <input type="hidden" name="itemId" value={itemId} />
                  <button
                    type="submit"
                    role="menuitem"
                    className="bsp-post-menu-item"
                    data-testid={`content-request-approval-${itemId}`}
                  >
                    {l('content.action.requestApproval')}
                  </button>
                </form>
              ) : null}
              {maySchedule ? (
                <Link
                  href={`/${locale}/calendar?item=${itemId}`}
                  role="menuitem"
                  className="bsp-post-menu-item"
                  data-testid={`content-schedule-${itemId}`}
                >
                  {l('content.action.schedule')}
                </Link>
              ) : null}
              {mayMove ? (
                <button
                  type="button"
                  role="menuitem"
                  className="bsp-post-menu-item"
                  data-testid={`post-menu-move-${itemId}`}
                  onClick={() => {
                    close(false);
                    setMoving(true);
                  }}
                >
                  {l('content.menu.move')}
                </button>
              ) : null}
              {mayCampaign ? (
                <button
                  type="button"
                  role="menuitem"
                  className="bsp-post-menu-item"
                  data-testid={`post-menu-campaign-${itemId}`}
                  onClick={() => setSub(true)}
                >
                  {campaignId === null
                    ? l('content.menu.addCampaign')
                    : l('content.menu.changeCampaign')}
                </button>
              ) : null}
              {mayMove && slot ? (
                <form action={actions.cancel}>
                  {hidden}
                  <input type="hidden" name="slotId" value={slot.id} />
                  <button
                    type="submit"
                    role="menuitem"
                    className="bsp-post-menu-item"
                    data-testid={`post-menu-unschedule-${itemId}`}
                  >
                    {l('content.menu.unschedule')}
                  </button>
                </form>
              ) : null}
              {channelLinks.map((link) => (
                <a
                  key={link.url}
                  role="menuitem"
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="bsp-post-menu-item"
                  data-testid={`post-menu-view-${itemId}`}
                >
                  {l('content.menu.viewOn').replace('{platform}', link.label)}
                </a>
              ))}
              {mayRestore ? (
                <form action={actions.transition}>
                  {hidden}
                  <input type="hidden" name="itemId" value={itemId} />
                  <input type="hidden" name="to" value="DRAFT" />
                  <button
                    type="submit"
                    role="menuitem"
                    className="bsp-post-menu-item"
                    data-testid={`post-menu-restore-${itemId}`}
                  >
                    {l('content.menu.restore')}
                  </button>
                </form>
              ) : null}
              {mayArchive ? (
                sure ? (
                  // Q21 — the second step: the same confirmation intent the server requires.
                  <form action={actions.transition}>
                    {hidden}
                    <input type="hidden" name="itemId" value={itemId} />
                    <input type="hidden" name="to" value="ARCHIVED" />
                    <input type="hidden" name="intent" value="ARCHIVE" />
                    <button
                      type="submit"
                      role="menuitem"
                      className="bsp-post-menu-item"
                      data-danger=""
                      data-testid={`post-menu-archive-confirm-${itemId}`}
                    >
                      {l('content.menu.archiveSure')}
                    </button>
                  </form>
                ) : (
                  <button
                    type="button"
                    role="menuitem"
                    className="bsp-post-menu-item"
                    data-danger=""
                    data-testid={`post-menu-archive-${itemId}`}
                    onClick={() => setSure(true)}
                  >
                    {l('content.menu.archive')}
                  </button>
                )
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {mayMove && slot ? (
        <Dialog
          open={moving}
          onClose={() => setMoving(false)}
          title={l('content.move.title')}
          closeLabel={l('common.close')}
          testId={`post-move-dialog-${itemId}`}
        >
          <form action={actions.reschedule} style={{ display: 'grid', gap: spacingTokens.md }}>
            {hidden}
            <input type="hidden" name="slotId" value={slot.id} />
            <div className="bs-form-row">
              <Field label={l('calendar.scheduleDate')} htmlFor={`move-date-${itemId}`}>
                <input
                  className="bs-control"
                  id={`move-date-${itemId}`}
                  name="date"
                  type="date"
                  required
                  defaultValue={slot.date}
                  {...(props.today ? { min: props.today } : {})}
                  data-testid={`post-move-date-${itemId}`}
                  style={inputStyle()}
                />
              </Field>
              <Field label={l('calendar.scheduleTime')} htmlFor={`move-time-${itemId}`}>
                <input
                  className="bs-control"
                  id={`move-time-${itemId}`}
                  name="time"
                  type="time"
                  required
                  defaultValue={slot.time}
                  data-testid={`post-move-time-${itemId}`}
                  style={inputStyle()}
                />
              </Field>
            </div>
            <div>
              <button
                type="submit"
                className="bs-pressable"
                style={buttonStyle('primary')}
                data-testid={`post-move-submit-${itemId}`}
              >
                {l('content.move.submit')}
              </button>
            </div>
          </form>
        </Dialog>
      ) : null}
    </div>
  );
}
