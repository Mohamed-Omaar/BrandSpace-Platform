'use client';

import { useRef, useState } from 'react';
import {
  ConfirmDialog,
  Dialog,
  DropdownMenu,
  Field,
  buttonStyle,
  inputStyle,
  menuItemStyle,
  spacingTokens,
  visuallyHiddenStyle,
} from '@brandspace/ui';

/**
 * THE POSTS "…" MENU (B8) — what can be done to one post, from the library.
 *
 * Every item is offered only when the permission AND the post's state allow
 * it, and every item posts to the SAME server action the calendar or the
 * Studio already uses — the menu adds no new way to change a post:
 *
 *   Move…         `rescheduleContentAction` (`content.schedule`, a plan that
 *                 has not started), same form as the calendar drawer
 *   Unschedule    `cancelScheduleAction` (same)
 *   Archive…      `transitionItemAction` with the confirmation `intent` the
 *                 server requires (two steps; `content.archive`)
 *   Restore       `transitionItemAction` back to DRAFT (`content.archive`)
 *   Campaign…     `setContentCampaignAction` — attach with `content.create`,
 *                 move or remove with `campaigns.manage` (Q21); the service
 *                 decides again
 *   View on …     the published post's own link, `https:` only
 *
 * Composed from `DropdownMenu`, `Dialog`, `ConfirmDialog`, `Field` and the
 * menu item style — the design system's own pieces (CLAUDE.md §4.2).
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
  readonly can: {
    readonly schedule: boolean;
    readonly archive: boolean;
    /** Q21 — attach a campaign to a post that has none. */
    readonly attachCampaign: boolean;
    /** Q21 — move a post to another campaign, or remove it. */
    readonly changeCampaign: boolean;
  };
  readonly labels: Readonly<Record<string, string>>;
  readonly actions: {
    reschedule(formData: FormData): Promise<void>;
    cancel(formData: FormData): Promise<void>;
    transition(formData: FormData): Promise<void>;
    setCampaign(formData: FormData): Promise<void>;
  };
}

const ARCHIVABLE = new Set(['DRAFT', 'CHANGES_REQUESTED', 'APPROVED']);

export function PostMenu(props: PostMenuProps) {
  const { locale, itemId, status, campaignId, campaigns, slot, links, can, labels, actions } =
    props;
  const [dialog, setDialog] = useState<'move' | 'campaign' | 'archive' | null>(null);
  const archiveForm = useRef<HTMLFormElement | null>(null);
  const l = (key: string) => labels[key] ?? '';

  const mayMove = can.schedule && slot !== null;
  const mayArchive = can.archive && ARCHIVABLE.has(status);
  const mayRestore = can.archive && status === 'ARCHIVED';
  const mayCampaign =
    status !== 'PUBLISHED' &&
    status !== 'PUBLISHING' &&
    status !== 'PARTIALLY_PUBLISHED' &&
    campaigns.length > 0 &&
    (campaignId === null ? can.attachCampaign : can.changeCampaign);
  const channelLinks = links.filter((link) => link.url.startsWith('https://'));

  if (!mayMove && !mayArchive && !mayRestore && !mayCampaign && channelLinks.length === 0) {
    return null;
  }

  const hidden = (
    <>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="returnTo" value="/content" />
    </>
  );

  return (
    <>
      <DropdownMenu
        label={l('content.menu.label')}
        // The ellipsis is decoration; the trigger is NAMED by the label, which a
        // screen reader reads and a sighted reader does not need.
        triggerContent={
          <>
            <span aria-hidden="true">⋯</span>
            <span style={visuallyHiddenStyle()}>{l('content.menu.label')}</span>
          </>
        }
        testId={`post-menu-${itemId}`}
      >
        {mayMove ? (
          <button
            type="button"
            role="menuitem"
            style={menuItemStyle()}
            data-testid={`post-menu-move-${itemId}`}
            onClick={() => setDialog('move')}
          >
            {l('content.menu.move')}
          </button>
        ) : null}
        {mayMove && slot ? (
          <form action={actions.cancel}>
            {hidden}
            <input type="hidden" name="slotId" value={slot.id} />
            <button
              type="submit"
              role="menuitem"
              style={menuItemStyle()}
              data-testid={`post-menu-unschedule-${itemId}`}
            >
              {l('content.menu.unschedule')}
            </button>
          </form>
        ) : null}
        {mayCampaign ? (
          <button
            type="button"
            role="menuitem"
            style={menuItemStyle()}
            data-testid={`post-menu-campaign-${itemId}`}
            onClick={() => setDialog('campaign')}
          >
            {l('content.menu.campaign')}
          </button>
        ) : null}
        {mayArchive ? (
          <button
            type="button"
            role="menuitem"
            style={menuItemStyle()}
            data-testid={`post-menu-archive-${itemId}`}
            onClick={() => setDialog('archive')}
          >
            {l('content.menu.archive')}
          </button>
        ) : null}
        {mayRestore ? (
          <form action={actions.transition}>
            {hidden}
            <input type="hidden" name="itemId" value={itemId} />
            <input type="hidden" name="to" value="DRAFT" />
            <button
              type="submit"
              role="menuitem"
              style={menuItemStyle()}
              data-testid={`post-menu-restore-${itemId}`}
            >
              {l('content.menu.restore')}
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
            style={menuItemStyle()}
            data-testid={`post-menu-view-${itemId}`}
          >
            {l('content.menu.viewOn').replace('{platform}', link.label)}
          </a>
        ))}
      </DropdownMenu>

      {mayMove && slot ? (
        <Dialog
          open={dialog === 'move'}
          onClose={() => setDialog(null)}
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
                style={buttonStyle('primary')}
                data-testid={`post-move-submit-${itemId}`}
              >
                {l('content.move.submit')}
              </button>
            </div>
          </form>
        </Dialog>
      ) : null}

      {mayCampaign ? (
        <Dialog
          open={dialog === 'campaign'}
          onClose={() => setDialog(null)}
          title={l('content.campaign.title')}
          closeLabel={l('common.close')}
          testId={`post-campaign-dialog-${itemId}`}
        >
          <form action={actions.setCampaign} style={{ display: 'grid', gap: spacingTokens.md }}>
            {hidden}
            <input type="hidden" name="itemId" value={itemId} />
            <Field label={l('content.campaign.title')} htmlFor={`campaign-${itemId}`}>
              <select
                className="bs-control"
                id={`campaign-${itemId}`}
                name="campaignId"
                required={!can.changeCampaign}
                defaultValue={campaignId ?? ''}
                data-testid={`post-campaign-select-${itemId}`}
                style={inputStyle()}
              >
                {/* Removing a campaign is a change, so only a campaign manager is offered it. */}
                {can.changeCampaign || campaignId === null ? (
                  <option value="">{l('content.campaign.none')}</option>
                ) : null}
                {campaigns.map((campaign) => (
                  <option key={campaign.id} value={campaign.id}>
                    {campaign.name}
                  </option>
                ))}
              </select>
            </Field>
            <div>
              <button
                type="submit"
                style={buttonStyle('primary')}
                data-testid={`post-campaign-submit-${itemId}`}
              >
                {l('content.campaign.submit')}
              </button>
            </div>
          </form>
        </Dialog>
      ) : null}

      {mayArchive ? (
        <>
          <form ref={archiveForm} action={actions.transition} hidden>
            {hidden}
            <input type="hidden" name="itemId" value={itemId} />
            <input type="hidden" name="to" value="ARCHIVED" />
            <input type="hidden" name="intent" value="ARCHIVE" />
          </form>
          <ConfirmDialog
            open={dialog === 'archive'}
            onClose={() => setDialog(null)}
            onConfirm={() => {
              setDialog(null);
              archiveForm.current?.requestSubmit();
            }}
            title={l('content.archive.title')}
            description={l('content.archive.confirmBody')}
            confirmLabel={l('content.archive.confirm')}
            cancelLabel={l('common.cancel')}
            closeLabel={l('common.close')}
            testId={`post-archive-dialog-${itemId}`}
          />
        </>
      ) : null}
    </>
  );
}
