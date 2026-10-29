'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useId, useRef, useState, type ReactNode } from 'react';
import { Backdrop, useOverlayBehaviour } from '@brandspace/ui';

/**
 * D-496 (Shell 7, Campaigns 1, 15, 16, 21) — THE CAMPAIGN DIALOG, the
 * prototype's campaign form (`Main.dc.html` L1571–1593): a 560px white card
 * over the list (new) or over the campaign (edit).
 *
 * DRIVEN BY THE ADDRESS, as the rule builder is (`automations/rule-dialog.tsx`,
 * whose behaviour this repeats at the campaign form's own size): `?new=1` on
 * Campaigns or `?edit=1` on a campaign renders it on the server, so it opens
 * without script and a saved campaign's redirect closes it. With script,
 * Escape, the veil and ✕ go back; focus is trapped inside while it is open.
 */
export function CampaignDialog({
  title,
  closeHref,
  closeLabel,
  testId,
  children,
}: {
  readonly title: string;
  readonly closeHref: string;
  readonly closeLabel: string;
  readonly testId: string;
  readonly children: ReactNode;
}) {
  const router = useRouter();
  const titleId = useId();
  const panelRef = useRef<HTMLElement | null>(null);
  const close = useCallback(() => router.push(closeHref), [router, closeHref]);
  useOverlayBehaviour({ open: true, onClose: close, containerRef: panelRef });

  return (
    <Backdrop
      layer="dialog"
      fade
      className="bsp-cp-veil"
      testId={`${testId}-scrim`}
      onDismiss={close}
    >
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="bs-dialog-in bsp-cp-dialog"
        data-testid={testId}
      >
        <div className="bsp-cp-dialog-h">
          <h2 id={titleId} className="bsp-sech">
            {title}
          </h2>
          <Link
            href={closeHref}
            className="bsp-btn bsp-sm bsp-ghost"
            aria-label={closeLabel}
            data-testid="campaign-dialog-close"
          >
            ✕
          </Link>
        </div>
        {children}
      </section>
    </Backdrop>
  );
}

/**
 * "Planned posts" − n + (Campaigns 1, `Main.dc.html` L1582): never below one
 * (`Math.max(1, total - 1)`, L3695). The number is posted as
 * `plannedPostCount`; the server decodes and bounds it again.
 */
export function PlannedPostsStepper({
  label,
  initial,
  max,
  minusLabel,
  plusLabel,
}: {
  readonly label: string;
  readonly initial: number;
  readonly max: number;
  readonly minusLabel: string;
  readonly plusLabel: string;
}) {
  const [total, setTotal] = useState(Math.min(Math.max(1, initial), max));
  const labelId = useId();
  return (
    <div className="bsp-cp-step" data-testid="campaign-planned">
      <span className="bsp-lbl" id={labelId}>
        {label}
      </span>
      <span className="bsp-ltr bsp-cp-step-ctl" role="group" aria-labelledby={labelId}>
        <button
          type="button"
          className="bsp-btn bsp-sm bsp-sec"
          aria-label={minusLabel}
          disabled={total <= 1}
          onClick={() => setTotal((value) => Math.max(1, value - 1))}
          data-testid="campaign-planned-minus"
        >
          −
        </button>
        <span className="bsp-cp-step-n" aria-live="polite" data-testid="campaign-planned-total">
          {total}
        </span>
        <button
          type="button"
          className="bsp-btn bsp-sm bsp-sec"
          aria-label={plusLabel}
          disabled={total >= max}
          onClick={() => setTotal((value) => Math.min(max, value + 1))}
          data-testid="campaign-planned-plus"
        >
          +
        </button>
        <input type="hidden" name="plannedPostCount" value={String(total)} />
      </span>
    </div>
  );
}

/**
 * The two-step "Archive" (Campaigns 21, Q5): the prototype's "Delete campaign"
 * → "Sure? Delete it", labelled for what it does — the existing archive, which
 * can be restored. The first press only asks; the second submits.
 */
export function ArchiveTwoStep({
  action,
  locale,
  campaignId,
  label,
  sureLabel,
}: {
  readonly action: (formData: FormData) => Promise<void>;
  readonly locale: string;
  readonly campaignId: string;
  readonly label: string;
  readonly sureLabel: string;
}) {
  const [sure, setSure] = useState(false);
  return (
    <form action={action} data-testid="campaign-archive-form">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="campaignId" value={campaignId} />
      {/*
        Two elements, not one whose type changes: a button that turns into a
        submit inside its own click is submitted by that same click.
      */}
      {sure ? (
        <button
          key="sure"
          type="submit"
          className="bsp-btn bsp-sm bsp-ghost bsp-cp-archive"
          data-testid="campaign-archive-sure"
          autoFocus
        >
          {sureLabel}
        </button>
      ) : (
        <button
          key="ask"
          type="button"
          className="bsp-btn bsp-sm bsp-ghost bsp-cp-archive"
          onClick={(event) => {
            event.preventDefault();
            setSure(true);
          }}
          data-testid="campaign-archive"
        >
          {label}
        </button>
      )}
    </form>
  );
}
