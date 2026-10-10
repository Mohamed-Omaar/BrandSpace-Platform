'use client';

import Link from 'next/link';
import type { UploadRules } from '../../../../components/upload-rules';
import { takeStudioCarry, type StudioCarry, type StudioHandoff } from './studio-carry';
import { ChannelAccessLine, type ChannelAccess } from './channel-access-line';
import { fitOf, formatForChannels, listOf } from './format-fit';
import type { AutosaveResult, ProposeTimeResult, ShapeResult } from '../actions';
import { AUTOSAVE_STATUSES } from './autosave-statuses';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  countCharacters,
  fill,
  formatCredits,
  inlineActionsFor,
  parseHashtags,
  previewFormatFor,
  variantIssues,
  type EditorIssue,
} from '../../../../server/composer-editor';
import { useRouter } from 'next/navigation';
import { SegmentPill, type MediaSeed } from '@brandspace/ui';
import { ChannelMark, PostArt } from '../../calendar/prototype-calendar';
import type { MediaOptionView } from './media-picker';
import { MediaSlides } from './media-slides';
import { InlineSchedule } from './inline-schedule';
import { WhenPopover, type PublishChoice, type WhenBest } from './when-popover';
import { localWhenLabel } from '../../../../server/prototype-dates';
import { MediaDrawer, type CreativeFormatOption } from './media-drawer';
import { VariantPreview, previewLabels } from './variant-preview';
import { MoreDisclosure } from '../../../../components/more-disclosure';
import { previewGeometry } from './preview-geometry';
import { StudioCopilotButton } from './studio-copilot';
import type {
  ComposerDraft,
  ComposerPlatform,
  ComposerVariant,
  VariantKnowledgeView,
} from './composer-view';

/**
 * THE DRAFT EDITOR — the prototype's Studio (`Main.dc.html` lines 329–537,
 * D-468 batch 2), wired to the post that exists.
 *
 * The composition is the prototype's: the banner for the post being edited,
 * the settings card (format, the channels it goes to, when, campaign), the
 * editor card with its Words and Design tabs beside the 380px preview card,
 * the per-channel checks, and the sticky bar with the status and the next
 * step. Every control the editor had keeps its behaviour and its test id:
 * one version per channel (the "Post to" chips are its tabs), inline AI
 * actions, friendly validation with the fix beside it, the media slides and
 * drawer, review, scheduling inline, templates and archive.
 *
 * ROUND 4 (3.1) — A DRAFT SAVES AS YOU TYPE; NOTHING FURTHER ALONG DOES.
 * The owner's decision is the prototype's "Saves as you type". It covers the
 * statuses a save changes nothing about — DRAFT, CHANGES_REQUESTED and FAILED
 * (`AUTOSAVE_STATUSES`). An APPROVED, IN_REVIEW or SCHEDULED post still waits
 * for a person pressing Save: a save there revokes an approval, withdraws a
 * review or unschedules (`revokeApprovalOnEdit`), which must never happen
 * because somebody paused mid-sentence. Either way the editor says whether the
 * words on screen are saved, and stops a navigation that would lose them.
 */

/**
 * ROUND 3 (C1) — THE POST'S NOTES AS THE PROTOTYPE DRAWS THEM: a compact card
 * under the preview (`Main.dc.html` lines 507–510) — "NOTES · n", "Open
 * conversation", and the latest note. The conversation itself (the ordinary
 * Notes panel, rendered on the server) opens in place under it.
 */
export interface StudioNotes {
  readonly count: number;
  readonly last: { readonly who: string; readonly text: string } | null;
  readonly panel: ReactNode;
  /** A deep link to one of its threads opens it. */
  readonly open: boolean;
}

export interface DraftEditorProps {
  readonly locale: string;
  readonly notes?: StudioNotes | null;
  /** Q9 (D-332): a channel whose account has expired — "Expired", and what it means. */
  readonly expiredChannels?: Readonly<
    Record<string, { readonly label: string; readonly explanation: string }>
  >;
  readonly t: Record<string, string>;
  readonly draft: ComposerDraft;
  readonly platforms: readonly ComposerPlatform[];
  readonly campaigns: readonly { id: string; name: string }[];
  readonly mediaOptions: readonly MediaOptionView[];
  /** Batch 7 (A3): what an uploaded picture or video may be; null when uploads are off. */
  readonly mediaRules?: UploadRules | null;
  /** Batch 7 (A3): why the last upload was refused, shown in the upload itself. */
  readonly uploadReason?: string | null;
  readonly brandName: string;
  readonly brandHandle: string;
  readonly tools: readonly string[];
  readonly busy: string | null;
  readonly now: number;
  readonly can: {
    /** B-2 — "Duplicate" makes a new post, so it needs `content.create`. */
    create?: boolean;
    edit: boolean;
    submit: boolean;
    archive: boolean;
    manageCampaigns: boolean;
    /** Q21 — may file a post that has no campaign yet. */
    attachCampaign?: boolean;
    uploadMedia: boolean;
    schedule?: boolean;
    /** Q12 — may open the Brand Brain (`brand_brain.read`); a link otherwise refused. */
    readBrain?: boolean;
    /** Q12 — may add knowledge (`brand_brain.edit`), the onboarding "learn" step. */
    teachBrain?: boolean;
    /** E4 (Phase 2B-2) — may save this post as a template (`templates.manage`). */
    manageTemplates?: boolean;
    /** D10 (Phase 2C-3) — may rewrite with AI: `content.edit` AND `copilot.use`. */
    rewriteFacts?: boolean;
  };
  /**
   * B9 / F2 (Phase 2B-2) — what the inline date and time start from: the
   * workspace's today and tomorrow, and the brand's default time.
   */
  readonly scheduling?: {
    readonly today: string;
    readonly tomorrow: string;
    readonly defaultTime: string;
  } | null;
  /**
   * Round 4 (3.3) — the publish time as a time: the slot's own wall clock
   * ("Oct 16 · 09:00") or the ★ day proposed; null when none is set.
   */
  readonly publishTime?: {
    readonly label: string;
    readonly slotId: string | null;
    readonly date: string;
    readonly time: string | null;
  } | null;
  /**
   * Batch 7 PR C (B1.1) — the post's proposed publish time, and the best
   * hours when the brand's real engagement supports them (else null).
   */
  readonly proposal?: {
    readonly value: string | null;
    readonly choice: PublishChoice;
    readonly best: WhenBest | null;
  } | null;
  /** Item 9 — a FAILED post: what the Publishing screen would say about it. */
  readonly failed?: { readonly message: string } | null;
  /** D-288 — the approval policy and a changes request, when there is one. */
  readonly review?: {
    readonly requiresApproval: boolean;
    /**
     * Q10 — who may be asked to review, default first (members before the
     * owner, never the author). Empty when the reader may not send for review.
     */
    readonly reviewers?: readonly { readonly userId: string; readonly name: string }[];
    readonly changes: {
      readonly note: string | null;
      readonly reviewer: string | null;
      readonly threadIds: readonly string[];
    } | null;
  } | null;
  /** The Creative Studio's formats, for "Generate with AI" in the media drawer. */
  readonly creativeFormats: readonly CreativeFormatOption[];
  readonly canGenerateMedia: boolean;
  /** An image carried from the Creative Studio: on the slides, unsaved. */
  readonly attach?: MediaOptionView | null;
  /** Round 4 (3.1) — the new-post Studio's ask: open on Design, or on the time. */
  readonly openOn?: string | null;
  /** G6 (D-329): the ★ day the Studio was opened for; its Schedule link opens there. */
  readonly plannedDate?: string | null;
  readonly onTool: (variantId: string, tool: string, argument?: string) => void;
  /** Review of #67, round 2 — the Studio's "Or start from:" chips, kept on an open post. */
  readonly startFrom?: { readonly idea: string; readonly repurpose: string };
  /** Round 5 (A) — what the new-post Studio was doing as this draft opened. */
  readonly handoff?: StudioHandoff | null;
  /** Round 5 (B) — which channels carry each format, from the publishing policy. */
  readonly formatPlatforms?: Readonly<Record<string, readonly string[]>>;
  /** Round 6 (D-481) — which chosen channels still need an account, per brand. */
  readonly channelAccess?: ChannelAccess | null | undefined;
  readonly actions: {
    save(formData: FormData): Promise<void | AutosaveResult>;
    /** Round 5 (B, D-478) — a draft's format and channels. */
    changeShape?(formData: FormData): Promise<ShapeResult>;
    transition(formData: FormData): Promise<void>;
    submitForReview(formData: FormData): Promise<void>;
    cancelReview(formData: FormData): Promise<void>;
    setCampaign(formData: FormData): Promise<void>;
    uploadMedia(formData: FormData): Promise<void>;
    resubmit(formData: FormData): Promise<void>;
    duplicate?(formData: FormData): Promise<void>;
    /** B9 (Phase 2B-2) — schedule from here, inline. */
    scheduleFromStudio?(formData: FormData): Promise<void>;
    /** Round 4 (3.3) — the calendar's own reschedule, for a post already on it. */
    reschedule?(formData: FormData): Promise<void>;
    /** Batch 7 PR C (B1.1) — store the proposed time; schedules nothing. */
    proposeTime?(formData: FormData): Promise<ProposeTimeResult>;
    /** E4 (Phase 2B-2) — save this post as a template. */
    saveAsTemplate?(formData: FormData): Promise<void>;
    /** D10 (Phase 2C-3) — "Keep as is" on one changed fact. */
    keepFactChange?(formData: FormData): Promise<void>;
  };
}

interface LiveVariant {
  readonly version: string;
  /**
   * Round 4 (3.1) — the version an autosave started from. Until the page is
   * re-read the row is still that version, and the words typed since must
   * stay on screen rather than flick back to the saved row.
   */
  readonly basedOn?: string;
  readonly body: string;
  readonly hashtagText: string;
  readonly firstComment: string;
  readonly assetIds: readonly string[];
  readonly cover: string | null;
  /** B9 — slide headlines by image. */
  readonly headlines: Readonly<Record<string, string>>;
}

const headlinesOf = (variant: ComposerVariant): Record<string, string> =>
  Object.fromEntries((variant.slides ?? []).map((slide) => [slide.assetId, slide.headline]));

/** Only the headlines of images still on the slides, blank ones left out. */
const headlineKey = (headlines: Readonly<Record<string, string>>, assetIds: readonly string[]) =>
  assetIds
    .map((id) => [id, (headlines[id] ?? '').trim()] as const)
    .filter(([, headline]) => headline !== '')
    .map(([id, headline]) => `${id}:${headline}`)
    .join('|');

const hashtagTextOf = (variant: ComposerVariant) =>
  variant.hashtags.map((tag) => `#${tag}`).join(' ');

/** What is on screen for a variant: the local edit of THIS version, or the row. */
function liveOf(
  edits: Readonly<Record<string, LiveVariant>>,
  variant: ComposerVariant,
): LiveVariant {
  const edit = edits[variant.id];
  if (edit && (edit.version === variant.updatedAt || edit.basedOn === variant.updatedAt)) {
    return edit;
  }
  return {
    version: variant.updatedAt,
    body: variant.body,
    hashtagText: hashtagTextOf(variant),
    firstComment: variant.firstComment ?? '',
    assetIds: variant.assetIds,
    cover: variant.coverAssetId ?? null,
    headlines: headlinesOf(variant),
  };
}

/** A variant's on-screen copy with what was typed while its draft was made. */
function withCarry(base: LiveVariant, carry: StudioCarry): LiveVariant {
  const hashtagText =
    carry.tags.length > 0
      ? [...new Set([...parseHashtags(base.hashtagText), ...carry.tags])]
          .map((tag) => `#${tag}`)
          .join(' ')
      : base.hashtagText;
  // Only words that are there: an empty carry never clears a template's.
  const body = carry.caption.trim() !== '' ? carry.caption : base.body;
  return body !== base.body || hashtagText !== base.hashtagText
    ? { ...base, body, hashtagText }
    : base;
}

export function DraftEditor({
  locale,
  notes = null,
  t,
  draft,
  platforms,
  campaigns,
  mediaOptions,
  mediaRules = null,
  uploadReason = null,
  brandName,
  brandHandle,
  tools,
  busy,
  now,
  can,
  creativeFormats,
  canGenerateMedia,
  attach = null,
  openOn = null,
  plannedDate = null,
  expiredChannels = {},
  review = null,
  scheduling = null,
  publishTime = null,
  proposal = null,
  failed = null,
  startFrom,
  handoff = null,
  formatPlatforms,
  channelAccess,
  onTool,
  actions,
}: DraftEditorProps) {
  const router = useRouter();
  const fieldId = useId();
  // One copy per render of this post, however often "Duplicate" is clicked.
  const duplicateToken = `composer:${draft.id}:${draft.variants.map((v) => v.updatedAt).join(',')}`;
  const [active, setActive] = useState(draft.variants[0]?.id ?? '');
  const [compare, setCompare] = useState(false);
  const [toneArgument, setToneArgument] = useState('');
  // The prototype's Words / Design tabs; an image carried in opens on Design.
  // Round 5 (A) — the hand-off for THIS draft, as it stood when the editor opened.
  const [arrival] = useState(() => (handoff && handoff.itemId === draft.id ? handoff : null));
  // The hand-off is newer than the address, which was written as the draft was made.
  const opened = arrival ? arrival.open : openOn;
  const [tab, setTab] = useState<'words' | 'visual'>(
    attach || opened === 'visual' ? 'visual' : 'words',
  );
  const [whenOpen, setWhenOpen] = useState(opened === 'when' || Boolean(arrival?.when));
  /*
   * WHICH "WHEN" OPENED THE PUBLISH-TIME PANEL — the settings card's chip or
   * the bar's (review of #67, round 2). One panel, drawn under the chip that
   * opened it, so its controls exist once on the page.
   */
  const [whenAt, setWhenAt] = useState<'card' | 'bar'>('card');
  const toggleWhen = (at: 'card' | 'bar') => {
    setWhenOpen((open) => (whenAt === at ? !open : true));
    setWhenAt(at);
  };
  /*
   * Round 5 — THE PANEL CLOSES WHEN THE TIME IT SET HAS LANDED. The editor
   * now stays mounted through the schedule's answer (A), so the panel used to
   * stay open over the scheduled post, and the next "When" closed it instead
   * of opening the reschedule.
   */
  const placed = publishTime ? `${publishTime.slotId ?? ''}:${publishTime.label}` : '';
  const placedRef = useRef(placed);
  useEffect(() => {
    if (placedRef.current === placed) return;
    placedRef.current = placed;
    setWhenOpen(false);
  }, [placed]);
  /*
   * Batch 7 PR C (B1.1) — THE PROPOSED TIME, as the popover last stored it.
   * The page's value wins whenever it changes (a reload, another tab's save).
   */
  const [proposed, setProposed] = useState<string | null>(proposal?.value ?? null);
  const [choice, setChoice] = useState<PublishChoice>(proposal?.choice ?? 'NONE');
  useEffect(() => {
    setProposed(proposal?.value ?? null);
    setChoice(proposal?.choice ?? 'NONE');
  }, [proposal?.value, proposal?.choice]);
  const whenText = publishTime?.slotId
    ? publishTime.label
    : proposed
      ? (localWhenLabel(proposed, locale, new Date(now)) ?? proposed)
      : choice === 'AFTER_APPROVAL'
        ? (t['studio.when.mode.after'] ?? null)
        : (publishTime?.label ?? null);
  const whenIsBest = Boolean(
    !publishTime?.slotId && proposed && proposal?.best?.bestLocalTime === proposed,
  );
  /*
   * Step 7 (7.2) — THE PANEL IS A DIALOG, SO ESCAPE CLOSES IT, and focus goes
   * back to the "When" that opened it (WCAG 2.1.2). It stayed open over the
   * Words / Design tabs.
   */
  useEffect(() => {
    if (!whenOpen) return undefined;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setWhenOpen(false);
      document
        .querySelector<HTMLElement>(
          `[data-testid="${whenAt === 'bar' ? 'editor-bar-when' : 'editor-when'}"]`,
        )
        ?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [whenOpen, whenAt]);

  /*
   * WHAT IS ON SCREEN, PER VARIANT. Keyed by the variant's `updatedAt`, so a
   * save or an AI edit that changed the row replaces the local copy — and a
   * copy for an older version is simply ignored rather than shown over the
   * newer words.
   */
  const [edits, setEdits] = useState<Readonly<Record<string, LiveVariant>>>(() => {
    const seeded: Record<string, LiveVariant> = {};
    /*
     * Round 5 (A) — THE HAND-OFF IS THE FIRST THING DRAWN. The words the
     * person is typing are in the field from the editor's very first frame,
     * so a key pressed as it opens lands in them — not in the row as it was
     * saved a round trip ago, to be overwritten a moment later.
     */
    if (arrival && can.edit) {
      for (const variant of draft.variants) {
        const base = liveOf({}, variant);
        seeded[variant.id] = withCarry(base, arrival);
      }
    }
    if (!attach) return seeded;
    for (const variant of draft.variants) {
      const platform = platforms.find((p) => p.key === variant.platformKey);
      if (!platform || platform.maxMediaItems === 0) continue;
      const base = seeded[variant.id] ?? liveOf({}, variant);
      if (base.assetIds.includes(attach.id) || base.assetIds.length >= platform.maxMediaItems) {
        continue;
      }
      seeded[variant.id] = { ...base, assetIds: [...base.assetIds, attach.id] };
    }
    return seeded;
  });
  const live = (variant: ComposerVariant): LiveVariant => liveOf(edits, variant);
  /*
   * ROUND 4 (3.1) — WHAT WAS TYPED WHILE THIS DRAFT WAS BEING MADE, from the
   * new-post Studio, once: it becomes the on-screen words and saves itself.
   */
  useEffect(() => {
    if (!can.edit) return;
    // The live hand-off was drawn first (above); the stored carry is then discarded.
    const stored = takeStudioCarry(draft.id);
    if (arrival || !stored) return;
    setEdits((current) => {
      const next = { ...current };
      for (const variant of draft.variants) {
        const base = liveOf(current, variant);
        const carried = withCarry(base, stored);
        if (carried !== base) next[variant.id] = carried;
      }
      return next;
    });
    // Once, for the draft this editor opened on.
  }, [draft.id]);
  /*
   * ROUND 5 (A) — THE CURSOR STAYS WHERE IT WAS. The composer's caption is
   * replaced by this editor's as the draft opens; the person typing in it
   * keeps typing here, at the same place, rather than into nothing.
   */
  useLayoutEffect(() => {
    if (!arrival || !can.edit || arrival.focus === null) return;
    const first = draft.variants[0];
    if (!first) return;
    const target = document.getElementById(
      arrival.focus === 'tag' ? `${fieldId}-${first.id}-tags` : `${fieldId}-${first.id}`,
    );
    if (!(target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement)) return;
    target.focus();
    // Only while the field still holds exactly what was handed over: a key
    // typed since has put the cursor where the person wants it.
    const place = () => {
      if (document.activeElement !== target || arrival.focus !== 'caption') return;
      if (target.value !== arrival.caption || arrival.caret === null) return;
      target.setSelectionRange(arrival.caret, arrival.caret);
    };
    // Once now, and once the carried words are in the field.
    place();
    window.setTimeout(place, 0);
    // Once, as the editor opens.
  }, []);
  /*
   * ROUND 3 — THE PROTOTYPE'S HASHTAG FIELD: one tag typed, then "Add". What
   * is typed and not yet added still counts — it is saved with the version and
   * shown in the preview — so nothing typed is lost to a missed click.
   */
  const [tagDrafts, setTagDrafts] = useState<Readonly<Record<string, string>>>(() =>
    arrival && arrival.tagDraft.trim() !== '' && draft.variants[0]
      ? { [draft.variants[0].id]: arrival.tagDraft }
      : {},
  );
  const tagTextOf = (variant: ComposerVariant): string =>
    [live(variant).hashtagText, tagDrafts[variant.id] ?? ''].join(' ').trim();
  const addTags = (variant: ComposerVariant) => {
    setEdits((current) => ({
      ...current,
      [variant.id]: {
        ...live(variant),
        hashtagText: parseHashtags(tagTextOf(variant))
          .map((tag) => `#${tag}`)
          .join(' '),
      },
    }));
    setTagDrafts((current) => ({ ...current, [variant.id]: '' }));
  };
  const change = (variant: ComposerVariant, patch: Partial<LiveVariant>) =>
    setEdits((current) => ({ ...current, [variant.id]: { ...live(variant), ...patch } }));
  /*
   * ROUND 4 (3.1) — WHAT THE LAST AUTOSAVE SENT, per version, until the page
   * re-reads the row that holds it. Compared against instead of the row while
   * the row is older, so a save is "saved" the moment it answers — not after
   * a re-read that the next keystroke's save may cancel.
   */
  const [savedAs, setSavedAs] = useState<
    Readonly<Record<string, { readonly version: string; readonly value: LiveVariant }>>
  >({});
  const baselineOf = (variant: ComposerVariant): LiveVariant => {
    const saved = savedAs[variant.id];
    return saved && saved.version > variant.updatedAt ? saved.value : liveOf({}, variant);
  };
  const differs = (value: LiveVariant, base: LiveVariant, tagText: string): boolean =>
    value.body !== base.body ||
    tagText !== base.hashtagText ||
    value.firstComment !== base.firstComment ||
    value.assetIds.join(',') !== base.assetIds.join(',') ||
    value.cover !== base.cover ||
    headlineKey(value.headlines, value.assetIds) !== headlineKey(base.headlines, base.assetIds);
  const isDirty = (variant: ComposerVariant): boolean =>
    differs(live(variant), baselineOf(variant), tagTextOf(variant));
  const anyDirty = draft.variants.some(isDirty);

  /*
   * DO NOT LOSE A DRAFT ON NAVIGATION (§27). A reload, a closed tab or a typed
   * address while words are unsaved asks first; the browser owns the wording.
   * Saving clears it, because the saved row becomes what is on screen.
   */
  const dirtyRef = useRef(anyDirty);
  useEffect(() => {
    dirtyRef.current = anyDirty;
  }, [anyDirty]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, []);

  /*
   * ROUND 4 (3.1) — SAVES AS YOU TYPE. The owner's decision: once the draft
   * exists, every change saves itself — through the version's own form and
   * the SAME `saveVariantAction` its post uses (same permission, same audit),
   * asked for an answer instead of a redirect. One save at a time; a pause
   * of 0.9 s after the last change; a tag still being typed waits for "Add".
   * The local copy is re-keyed to the saved version, so nothing typed during
   * the save is lost, and the page is re-read for the rest (checks, preview).
   */
  const [autosave, setAutosave] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const savingRef = useRef(false);
  /*
   * "Save edit" pressed: its post is the save, so a pause that ends while it
   * is on its way does not send the same words a second time. The page's next
   * answer (a new `draft`) releases it, whether the post saved or was refused.
   */
  const submittedRef = useRef(false);
  useEffect(() => {
    submittedRef.current = false;
  }, [draft]);
  // A tag still being typed waits for "Add".
  const unsavedForAutosave = (variant: ComposerVariant): boolean =>
    differs(live(variant), baselineOf(variant), live(variant).hashtagText);
  const autosaves = AUTOSAVE_STATUSES.includes(draft.status);
  const pendingAutosave =
    autosaves && can.edit && !draft.readOnly ? draft.variants.find(unsavedForAutosave) : undefined;
  /*
   * ROUND 5 (A) — THE SAVE NEVER STANDS BETWEEN THE PERSON AND A CONTROL.
   * Tested from Egypt against Amsterdam, a save took a round trip or more, and
   * the page then re-read itself in full — which also re-fetched every link
   * in the rail. "Send for review", the bar's "Schedule" and the time's "Set"
   * were disabled for all of that, after every keystroke, so a click landed
   * or did not depending on timing. Now:
   *
   *   - one save at a time (`inflightRef`), and what was typed while it ran is
   *     saved next, so the last state the person set is the one saved;
   *   - an action that needs the words saved first saves them at once
   *     (`flushSaves`) and then runs — it is never disabled for a save;
   *   - the page is re-read once, when nothing more is waiting to be saved.
   */
  const inflightRef = useRef<Promise<boolean> | null>(null);
  const pendingRef = useRef<() => readonly ComposerVariant[]>(() => []);
  pendingRef.current = () =>
    autosaves && can.edit && !draft.readOnly ? draft.variants.filter(unsavedForAutosave) : [];
  const runSave = (variant: ComposerVariant): Promise<boolean> => {
    const form = document.getElementById(panelId(variant));
    if (!(form instanceof HTMLFormElement)) return Promise.resolve(true);
    const data = new FormData(form);
    data.set('autosave', '1');
    // What was added, not a tag still being typed.
    const sent = live(variant);
    data.set('hashtags', sent.hashtagText);
    savingRef.current = true;
    setAutosave('saving');
    const run = actions
      .save(data)
      .then((result) => {
        if (result && result.ok && result.version) {
          const version = result.version;
          setSavedAs((current) => ({ ...current, [variant.id]: { version, value: sent } }));
          setEdits((current) => {
            const edit = current[variant.id] ?? liveOf(current, variant);
            return {
              ...current,
              [variant.id]: { ...edit, version, basedOn: variant.updatedAt },
            };
          });
          setAutosave('saved');
          return true;
        }
        setAutosave('failed');
        return false;
      })
      .catch(() => {
        setAutosave('failed');
        return false;
      })
      .finally(() => {
        savingRef.current = false;
        inflightRef.current = null;
      });
    inflightRef.current = run;
    return run;
  };
  /* Everything typed, saved now: waits for a save under way, then saves the rest. */
  // One flush at a time: a second caller joins it, and its rounds re-read what waits.
  const flushRef = useRef<Promise<boolean> | null>(null);
  const flushSaves = (): Promise<boolean> => {
    if (flushRef.current) return flushRef.current;
    const run = (async () => {
      for (let round = 0; round < 5; round += 1) {
        if (inflightRef.current && !(await inflightRef.current)) return false;
        // Let the answer's state land before asking what is still unsaved.
        await new Promise((resolve) => window.setTimeout(resolve, 0));
        const waiting = pendingRef.current();
        if (waiting.length === 0) return true;
        // The latest render's save: it reads what is on screen now.
        for (const variant of waiting) {
          if (!(await runSaveRef.current(variant))) return false;
        }
      }
      return pendingRef.current().length === 0;
    })().finally(() => {
      flushRef.current = null;
    });
    flushRef.current = run;
    return run;
  };
  /*
   * A form whose action needs the words saved (send for review, resubmit):
   * on a draft that saves itself, the press saves them first, then submits.
   */
  const flushThenSubmit = (event: FormEvent<HTMLFormElement>) => {
    if (
      !autosaves ||
      (pendingRef.current().length === 0 && !inflightRef.current && !shapeRunRef.current)
    ) {
      return;
    }
    event.preventDefault();
    const form = event.currentTarget;
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    void settleAll().then((ok) => {
      if (ok) form.requestSubmit(submitter ?? undefined);
    });
  };
  useEffect(() => {
    if (!pendingAutosave || savingRef.current) return undefined;
    // One pause saves every version waiting (each channel has its own), not
    // one per pause — under a slow link that was a pause and a round trip each.
    const timer = window.setTimeout(() => {
      if (submittedRef.current) return;
      void flushSaves();
    }, 900);
    return () => window.clearTimeout(timer);
    // The pending version's words are the dependency: each change restarts the pause.
  }, [pendingAutosave?.id, pendingAutosave ? JSON.stringify(live(pendingAutosave)) : '']);
  /*
   * The page is re-read (checks, preview, the saved line) once the saves have
   * gone quiet — not after each one, which under a slow link queued a full
   * page behind every pause in typing.
   */
  const quiet = autosave === 'saved' && !pendingAutosave;
  useEffect(() => {
    if (!quiet) return undefined;
    const timer = window.setTimeout(() => {
      if (!savingRef.current && pendingRef.current().length === 0) router.refresh();
    }, 600);
    return () => window.clearTimeout(timer);
  }, [quiet, router]);
  /*
   * Leaving the Studio inside the pause (a rail link, the back button) saves
   * what is waiting: a layout cleanup, so the forms are still in the page.
   */
  const runSaveRef = useRef(runSave);
  runSaveRef.current = runSave;
  useLayoutEffect(
    () => () => {
      if (submittedRef.current || inflightRef.current) return;
      for (const variant of pendingRef.current()) void runSaveRef.current(variant);
    },
    [],
  );

  /*
   * ROUND 5 (B, D-478) — THE FORMAT AND THE CHANNELS, CHANGED ON A DRAFT.
   * While the post is a draft (DRAFT, CHANGES_REQUESTED) the switch and the
   * "Post to" chips change it, through `changeDraftShapeAction` (the same
   * `content.edit`, audited). The press shows at once; what is waiting to be
   * saved is saved first, then the change is sent, and presses made while it
   * travels are sent next — the last one the person made is the one kept. A
   * refusal says why, in words, and puts the switch back.
   */
  const shapeEditable =
    actions.changeShape !== undefined &&
    can.edit &&
    !draft.readOnly &&
    (draft.status === 'DRAFT' || draft.status === 'CHANGES_REQUESTED');
  const serverChannels = draft.variants.map((variant) => variant.platformKey);
  const [shape, setShape] = useState<{
    readonly format: string;
    readonly channels: readonly string[];
  } | null>(null);
  const shownFormat = shape?.format ?? draft.contentType;
  const shownChannels = shape?.channels ?? serverChannels;
  const [shapeNote, setShapeNote] = useState<string | null>(null);
  const carriesFormat = (type: string, key: string) =>
    !formatPlatforms || (formatPlatforms[type] ?? []).includes(key);
  const channelLabel = (key: string) =>
    platforms.find((platform) => platform.key === key)?.label ?? key;
  const formatLabel = (type: string) => t[`content.type.${type}`] ?? type;
  const shapeTargetRef = useRef<{ format: string; channels: readonly string[] } | null>(null);
  const shapeRunningRef = useRef(false);
  // The running change, so an action that needs the draft settled can wait for it.
  const shapeRunRef = useRef<Promise<void> | null>(null);
  const sendShape = () => {
    if (shapeRunningRef.current || !actions.changeShape) return shapeRunRef.current;
    shapeRunningRef.current = true;
    const run = runShapes().finally(() => {
      shapeRunningRef.current = false;
      shapeRunRef.current = null;
    });
    shapeRunRef.current = run;
    return run;
  };
  const runShapes = async () => {
    if (!actions.changeShape) return;
    {
      while (shapeTargetRef.current) {
        const target = shapeTargetRef.current;
        shapeTargetRef.current = null;
        if (!(await flushSaves())) {
          setShape(null);
          setShapeNote(t['studio.saveFailed'] ?? null);
          break;
        }
        const data = new FormData();
        data.set('locale', locale);
        data.set('itemId', draft.id);
        data.set('contentType', target.format);
        for (const key of target.channels) data.append('platformKeys', key);
        const result = await actions.changeShape(data);
        if (!result.ok) {
          shapeTargetRef.current = null;
          setShape(null);
          setShapeNote(
            result.reason === 'format_not_carried'
              ? fill(t['studio.shape.notCarried'] ?? '{channels}', {
                  channels: (result.platformKeys ?? []).map(channelLabel).join(', '),
                  format: formatLabel(target.format),
                })
              : result.reason === 'shape_locked'
                ? (t['studio.shape.locked'] ?? '')
                : (t['content.error.generic'] ?? ''),
          );
          break;
        }
        setShapeNote(
          result.mediaDropped.length > 0
            ? fill(t['studio.shape.mediaDropped'] ?? '{channels}', {
                channels: result.mediaDropped.map(channelLabel).join(', '),
              })
            : null,
        );
        router.refresh();
      }
    }
  };
  /*
   * Everything the person did, settled: the words saved and any format or
   * channel change sent. "Set" and "Send for review" wait for this, so a time
   * set right after a format change cannot schedule the post before it.
   */
  const settleAll = async (): Promise<boolean> => {
    if (shapeRunRef.current) await shapeRunRef.current;
    return flushSaves();
  };
  const askShape = (next: { format: string; channels: readonly string[] }) => {
    setShape(next);
    shapeTargetRef.current = next;
    void sendShape();
  };
  // The page answered with what was asked: the local copy steps aside.
  useEffect(() => {
    if (!shape || shapeTargetRef.current || shapeRunningRef.current) return;
    const same =
      draft.contentType === shape.format &&
      serverChannels.length === shape.channels.length &&
      serverChannels.every((key) => shape.channels.includes(key));
    if (same) setShape(null);
  }, [draft, shape, serverChannels]);
  /*
   * Round 6 (D-481) — NO SILENT PRESS ON A DRAFT EITHER. A format the post's
   * channels cannot all carry is dimmed before the press with the reason
   * beside the switch; its press names who can carry it and offers the fix in
   * one press (take the others out and switch). A channel the format cannot
   * carry answers the same way (switch to a format that takes it, and add it).
   */
  const carriersOf = (type: string) =>
    platforms.filter((platform) => carriesFormat(type, platform.key)).map((p) => p.key);
  const fitFor = (type: string) => fitOf(carriersOf(type), shownChannels);
  const names = (keys: readonly string[]) => listOf(locale, keys.map(channelLabel));
  const [fitAsk, setFitAsk] = useState<
    | { readonly kind: 'format'; readonly type: string }
    | { readonly kind: 'channel'; readonly key: string }
    | null
  >(null);
  const reshape = (next: { format: string; channels: readonly string[] }) => {
    setFitAsk(null);
    setShapeNote(null);
    const activeKey = draft.variants.find((variant) => variant.id === active)?.platformKey;
    if (!next.channels.some((key) => key === activeKey)) {
      const staying = draft.variants.find((variant) => next.channels.includes(variant.platformKey));
      if (staying) setActive(staying.id);
    }
    askShape(next);
  };
  const chooseFormat = (type: string) => {
    if (fitFor(type).state !== 'ok') {
      setShapeNote(null);
      setFitAsk({ kind: 'format', type });
      return;
    }
    reshape({ format: type, channels: shownChannels });
  };
  const toggleChannel = (key: string) => {
    setFitAsk(null);
    const on = shownChannels.includes(key);
    if (on && shownChannels.length === 1) return;
    const next = on ? shownChannels.filter((other) => other !== key) : [...shownChannels, key];
    if (on) {
      const leaving = draft.variants.find((variant) => variant.platformKey === key);
      const staying = draft.variants.find((variant) => variant.platformKey !== key);
      if (leaving && staying && leaving.id === active) setActive(staying.id);
    }
    askShape({ format: shownFormat, channels: next });
  };
  /*
   * Round 5 (B) — a channel or format chosen on the new post while its draft
   * was being made is applied to the draft as it opens: the person's last
   * choice is the one kept.
   */
  useEffect(() => {
    if (!arrival || !shapeEditable) return;
    const wanted = arrival.target;
    const same =
      wanted.format === draft.contentType &&
      wanted.channels.length === serverChannels.length &&
      wanted.channels.every((key) => serverChannels.includes(key));
    if (!same && wanted.channels.length > 0) askShape(wanted);
    // Once, as the editor opens.
  }, []);

  /*
   * THE MEDIA DRAWER — for which variant, and whether it replaces a slide.
   */
  // Batch 7 (A3): a refused upload comes back with its drawer open on the upload.
  const [drawer, setDrawer] = useState<{ variantId: string; replace: number | null } | null>(() =>
    uploadReason && draft.variants[0] ? { variantId: draft.variants[0].id, replace: null } : null,
  );
  /*
   * AN IMAGE GENERATED FROM THE DRAWER IS ATTACHED THE MOMENT IT IS USABLE.
   * It is an ordinary asset going through the same scan, so it is not in the
   * library list yet; the page is re-read every few seconds until it is, then
   * it joins the variant's slides (still unsaved, like any other change).
   */
  const [pending, setPending] = useState<{
    variantId: string;
    assetId: string;
    tries: number;
  } | null>(null);
  useEffect(() => {
    if (!pending) return;
    if (mediaOptions.some((option) => option.id === pending.assetId)) {
      const variant = draft.variants.find((row) => row.id === pending.variantId);
      if (variant) {
        setEdits((current) => {
          const base = liveOf(current, variant);
          if (base.assetIds.includes(pending.assetId)) return current;
          return {
            ...current,
            [variant.id]: { ...base, assetIds: [...base.assetIds, pending.assetId] },
          };
        });
      }
      setPending(null);
      return;
    }
    if (pending.tries >= 40) return;
    const timer = window.setTimeout(() => {
      setPending((current) => (current ? { ...current, tries: current.tries + 1 } : current));
      router.refresh();
    }, 3_000);
    return () => window.clearTimeout(timer);
  }, [pending, mediaOptions, router, draft.variants]);

  const drawerVariant = drawer
    ? draft.variants.find((variant) => variant.id === drawer.variantId)
    : undefined;

  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const count = draft.variants.length;
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0 && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const rtl = document.documentElement.dir === 'rtl';
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? count - 1
          : (index + (rtl ? -step : step) + count) % count;
    const target = draft.variants[next];
    if (!target) return;
    setActive(target.id);
    tabRefs.current[target.id]?.focus();
  };

  const format = previewFormatFor(shownFormat);
  const labels = useMemo(() => previewLabels(t), [t]);
  const actionsFor = inlineActionsFor(tools);
  const brainHref = `/${locale}/brand-brain`;

  const mediaFor = (ids: readonly string[]) =>
    ids
      .map((id) => mediaOptions.find((option) => option.id === id))
      .filter((option): option is MediaOptionView => option !== undefined);

  const previewOf = (variant: ComposerVariant, testId: string) => {
    const value = live(variant);
    return (
      <VariantPreview
        locale={locale}
        platformKey={variant.platformKey}
        format={format}
        body={value.body}
        hashtags={parseHashtags(tagTextOf(variant))}
        media={mediaFor(value.assetIds).map((item) => ({
          ...item,
          headline: value.headlines[item.id] ?? '',
        }))}
        cover={value.cover ? (mediaFor([value.cover])[0] ?? null) : null}
        accountName={brandName}
        accountHandle={brandHandle}
        status="DRAFT"
        approval={approvalStateOf(draft.status)}
        labels={labels}
        testId={testId}
      />
    );
  };

  const activeVariant =
    draft.variants.find((variant) => variant.id === active) ?? draft.variants[0];

  /*
   * §20 — WHAT AN AI EDIT WOULD COST, BEFORE IT RUNS. One quote per saved
   * version of the visible variant, through the same gateway quote the edit
   * itself reserves against. It reserves nothing. The edits differ only in one
   * directive line, so one figure is stated as "about" rather than seven calls.
   */
  const [estimates, setEstimates] = useState<Readonly<Record<string, string>>>({});
  const estimateKey = activeVariant ? `${activeVariant.id}:${activeVariant.updatedAt}` : '';
  const canQuote = can.edit && actionsFor.length > 0 && activeVariant !== undefined;
  useEffect(() => {
    if (!canQuote || !activeVariant || estimateKey in estimates) return;
    let current = true;
    fetch('/api/content/tool-quote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ variantId: activeVariant.id, tool: 'rewrite' }),
    })
      .then(async (response) =>
        response.ok ? ((await response.json()) as { estimateMilli?: string }) : null,
      )
      .then((payload) => {
        if (current && payload?.estimateMilli) {
          setEstimates((all) => ({ ...all, [estimateKey]: String(payload.estimateMilli) }));
        }
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [canQuote, activeVariant, estimateKey, estimates]);
  const estimate = estimates[estimateKey];

  /*
   * "WRITE CAPTION WITH AI · N" ON AN OPEN POST (review of #67, round 2): the
   * prototype keeps the button in its editing state. Writing a saved post anew
   * from its topic is not something the product does yet, so the button waits,
   * and still states what a caption costs: the same gateway quote the new-post
   * Studio asks for, for this post's topic, channels and format. It reserves
   * nothing.
   */
  const [writeQuote, setWriteQuote] = useState<string | null>(null);
  const writeQuoteKey = `${draft.brandId}|${draft.title}|${draft.contentType}|${draft.variants
    .map((variant) => variant.platformKey)
    .join(',')}`;
  useEffect(() => {
    if (!canQuote || draft.title.trim() === '') return;
    let current = true;
    fetch('/api/content/quote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        brandId: draft.brandId,
        brief: draft.title,
        platformKeys: draft.variants.map((variant) => variant.platformKey),
        locale: draft.variants[0]?.locale ?? 'EN',
        contentType: draft.contentType,
      }),
    })
      .then(async (response) =>
        response.ok ? ((await response.json()) as { estimateMilli?: string }) : null,
      )
      .then((payload) => {
        if (current && payload?.estimateMilli) setWriteQuote(String(payload.estimateMilli));
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
    // The key stands for every input of the quote.
  }, [canQuote, writeQuoteKey]);

  /*
   * D10 (Phase 2C-3) — A FACT THIS CAPTION USED CHANGED, EXPIRED OR WAS
   * REMOVED. The banner lists the active variant's undismissed changes; its
   * Rewrite is priced by the SAME quote path the rewrite reserves against
   * (`/api/content/tool/quote`, tool `refresh_facts`) — never a fixed price.
   */
  const flaggedFacts: readonly VariantKnowledgeView[] =
    activeVariant?.knowledge?.filter((entry) => entry.flagged) ?? [];
  const [refreshEstimates, setRefreshEstimates] = useState<Readonly<Record<string, string>>>({});
  const refreshKey =
    activeVariant && flaggedFacts.length > 0
      ? `${activeVariant.id}:${activeVariant.updatedAt}:${flaggedFacts
          .map((entry) => entry.signature)
          .join(',')}`
      : '';
  const canQuoteRefresh = can.rewriteFacts === true && can.edit && refreshKey !== '';
  useEffect(() => {
    if (!canQuoteRefresh || !activeVariant || refreshKey in refreshEstimates) return;
    let current = true;
    fetch('/api/content/tool-quote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ variantId: activeVariant.id, tool: 'refresh_facts' }),
    })
      .then(async (response) =>
        response.ok ? ((await response.json()) as { estimateMilli?: string }) : null,
      )
      .then((payload) => {
        if (current && payload?.estimateMilli) {
          setRefreshEstimates((all) => ({ ...all, [refreshKey]: String(payload.estimateMilli) }));
        }
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [canQuoteRefresh, activeVariant, refreshKey, refreshEstimates]);
  const refreshEstimate = refreshEstimates[refreshKey];
  // "with the new fact" when a newer or replacement fact exists; otherwise "without".
  const rewriteWithNew = flaggedFacts.some(
    (entry) => entry.state === 'changed' || entry.state === 'replaced',
  );
  const factTitle = (entry: VariantKnowledgeView, which: 'used' | 'now' | 'new') =>
    (which === 'used' ? entry.usedTitle : which === 'new' ? entry.newTitle : entry.title) ??
    t['editor.facts.removedFact'] ??
    '';

  /*
   * Q10 — WHO TO ASK. "Automatic" sends the review to the default reviewer the
   * service picks (the first name below); choosing a name asks that person.
   * Either way anyone who may approve for the brand can decide it.
   */
  const reviewerPicker = (id: string, form?: string) =>
    review?.reviewers && review.reviewers.length > 0 ? (
      <span className="bsp-chip bsp-st-rev">
        <label className="bsp-st-rev-label" htmlFor={`${fieldId}-${id}`}>
          {t['editor.reviewer.label']}
        </label>
        <select
          id={`${fieldId}-${id}`}
          className="bs-control bsp-st-rev-select"
          name="assignedToUserId"
          form={form}
          defaultValue=""
          data-testid={`${id}-reviewer`}
        >
          <option value="">
            {fill(t['editor.reviewer.auto'] ?? '{name}', { name: review.reviewers[0]?.name ?? '' })}
          </option>
          {review.reviewers.map((reviewer) => (
            <option key={reviewer.userId} value={reviewer.userId}>
              {reviewer.name}
            </option>
          ))}
        </select>
      </span>
    ) : null;

  const channelOf = (platformKey: string) => ({
    key: platformKey,
    name: platforms.find((p) => p.key === platformKey)?.label ?? platformKey,
  });
  const panelId = (variant: ComposerVariant) => `${fieldId}-panel-${variant.id}`;

  /*
   * WHAT EACH CHANNEL'S CHECK CARD SAYS — the same configured limits and the
   * same `variantIssues` the editor always validated with, read from the words
   * on screen. The rows are the prototype's caption, hashtags and media.
   */
  const checkOf = (variant: ComposerVariant) => {
    const platform = platforms.find((p) => p.key === variant.platformKey);
    const value = live(variant);
    const hashtags = parseHashtags(tagTextOf(variant));
    const media = mediaFor(value.assetIds);
    const issues = platform
      ? variantIssues(platform, shownFormat, {
          body: value.body,
          hashtags,
          mediaKinds: media.map((option) => option.kind),
          expiredMedia: media.filter((option) => option.rightsExpired).length,
        })
      : [];
    const characters = countCharacters(value.body);
    const limit = platform?.maxBodyChars ?? 0;
    const has = (keys: readonly string[]) => issues.some((issue) => keys.includes(issue.key));
    return {
      platform,
      issues,
      hashtags,
      characters,
      limit,
      rows: [
        {
          key: 'caption',
          ok: !has(['editor.issue.empty', 'editor.issue.tooLong']),
          value: `${characters} / ${limit}`,
        },
        {
          key: 'tags',
          ok: !has(['editor.issue.tooManyHashtags']),
          value: `${hashtags.length} / ${platform?.maxHashtags ?? 0}`,
        },
        {
          key: 'media',
          ok: !issues.some(
            (issue) => issue.fix === 'media' || issue.key === 'editor.issue.tooMuchMedia',
          ),
          value: `${value.assetIds.length} / ${platform?.maxMediaItems ?? 0}`,
        },
      ],
    };
  };

  /* "Choose media" from a check: the Design tab of that channel, then its slides. */
  const focusMedia = (variant: ComposerVariant) => {
    setActive(variant.id);
    setTab('visual');
    window.setTimeout(() => document.getElementById(`${fieldId}-${variant.id}-media`)?.focus(), 0);
  };

  /*
   * Batch 7 PR C (B1.1, B1.4) — who may keep a time on this post: the author's
   * own permission, while it is a draft, has changes requested or is approved
   * and not yet on the calendar. `propose()` holds the same rule.
   */
  const mayPropose =
    can.edit &&
    !draft.readOnly &&
    !publishTime?.slotId &&
    (draft.status === 'DRAFT' ||
      draft.status === 'CHANGES_REQUESTED' ||
      draft.status === 'APPROVED');
  const mayScheduleHere = Boolean(
    can.schedule &&
    ((draft.status === 'DRAFT' && review && !review.requiresApproval) ||
      draft.status === 'APPROVED'),
  );
  const epTone = draft.readOnly ? 'pub' : (EP_TONE[draft.status] ?? 'draft');
  const firstMedia = activeVariant ? mediaFor(live(activeVariant).assetIds)[0] : undefined;
  const epArt = {
    src:
      firstMedia?.previewToken && firstMedia.kind !== 'VIDEO'
        ? `/${locale}/assets/file/${firstMedia.previewToken}`
        : null,
    seed: (draft.id.charCodeAt(0) % 6) as MediaSeed,
  };
  const activeValue = activeVariant ? live(activeVariant) : null;
  const activeDirty = activeVariant ? isDirty(activeVariant) : false;
  const statusLabel = t[`content.status.${draft.status}`] ?? draft.status;

  const mayReview = (draft.status === 'DRAFT' || draft.status === 'FAILED') && can.submit;
  const reviewFormId = `${fieldId}-review`;
  const activePlatform = activeVariant
    ? platforms.find((p) => p.key === activeVariant.platformKey)
    : undefined;

  /*
   * THE PUBLISH-TIME PANEL, under whichever "When" opened it (review of #67,
   * round 2): the settings card's chip, or the bar's.
   */
  const whenPanel = (at: 'card' | 'bar') => (
    <>
      {/*
              THE PUBLISH TIME, where the prototype keeps it: the calendar's
              own date and time controls (B9 / F2), offered exactly where the
              Schedule step is, and the calendar for everything else.
            */}
      <div
        role="dialog"
        aria-label={t['studio.whenTitle']}
        className={`bsp-st-when${at === 'bar' ? ' bsp-st-when-up' : ''}`}
        hidden={!whenOpen}
        data-testid="editor-when-panel"
      >
        <span className="bsp-st-when-title">{t['studio.whenTitle']}</span>
        {scheduling &&
        actions.reschedule &&
        can.schedule &&
        publishTime?.slotId &&
        publishTime.time ? (
          /*
            Round 4 (3.3) — A POST ON THE CALENDAR: its time, editable right
            here, through the calendar's own reschedule (same permission, same
            rules: approval, lead time, the day's room, the audit).
          */
          <InlineSchedule
            locale={locale}
            itemId={draft.id}
            today={scheduling.today}
            tomorrow={scheduling.tomorrow}
            defaultTime={scheduling.defaultTime}
            plannedDate={null}
            initial={{ date: publishTime.date, time: publishTime.time }}
            hidden={{ slotId: publishTime.slotId, returnTo: '/content/compose', item: draft.id }}
            disabled={anyDirty}
            action={actions.reschedule}
            submitLabel={t['editor.schedule.move']}
            testId="editor-reschedule-inline"
            t={t}
          />
        ) : scheduling && actions.proposeTime && mayPropose ? (
          /*
            Batch 7 PR C (B1.1, B1.2, B1.4) — "WHEN SHOULD IT GO OUT?": the
            time chosen here is kept on the post and schedules nothing. The
            bar's Schedule press, or "Approve & schedule", puts it on the
            calendar. A brand that needs approval edits it too.
          */
          <WhenPopover
            locale={locale}
            itemId={draft.id}
            t={t}
            today={scheduling.today}
            tomorrow={scheduling.tomorrow}
            defaultTime={scheduling.defaultTime}
            plannedDate={plannedDate}
            proposed={proposed}
            choice={choice}
            best={proposal?.best ?? null}
            requiresApproval={Boolean(review?.requiresApproval) && draft.status !== 'APPROVED'}
            reviewerName={review?.reviewers?.[0]?.name ?? null}
            propose={actions.proposeTime}
            onProposed={(value, next) => {
              setProposed(value);
              setChoice(next);
            }}
            onDone={() => setWhenOpen(false)}
            initial={arrival?.when ? { date: arrival.when.date, time: arrival.when.time } : null}
            saveOnMount={arrival?.when?.submit === true}
          >
            {mayScheduleHere && proposed && actions.scheduleFromStudio ? (
              <button
                type="submit"
                form={`${fieldId}-schedule`}
                className="bsp-btn bsp-sm bsp-pur bsp-st-end"
                disabled={anyDirty && !autosaves}
                data-testid="editor-schedule-submit"
              >
                {t['editor.next.schedule']}
              </button>
            ) : null}
            {/* The calendar's own Schedule, for choosing on the month (round 2). */}
            {mayScheduleHere ? (
              <Link
                className="bsp-st-link"
                href={`/${locale}/calendar?item=${draft.id}${plannedDate ? `&date=${plannedDate}` : ''}`}
                aria-disabled={anyDirty}
                data-testid="editor-schedule"
              >
                {t['editor.next.schedule']} →
              </Link>
            ) : null}
          </WhenPopover>
        ) : (
          <>
            <span className="bsp-st-when-note">{statusLabel}</span>
            <button
              type="button"
              className="bsp-btn bsp-sm bsp-st-end"
              onClick={() => setWhenOpen(false)}
            >
              {t['studio.whenDone']}
            </button>
          </>
        )}
      </div>
    </>
  );

  /*
   * Round 3 (C1) — the post's notes, as the prototype's compact card: the
   * count, the latest note, and the conversation opening in place.
   */
  const notesCard = notes ? (
    <details className="bsp-st-notes" open={notes.open} data-testid="studio-notes">
      <summary>
        <span className="bsp-lbl">
          {t['studio.notesLabel']} · <span className="bsp-ltr">{notes.count}</span>
        </span>
        <span className="bsp-st-notes-open" data-testid="studio-notes-open">
          {t['studio.openConversation']}
        </span>
      </summary>
      {notes.last ? (
        <div className="bsp-st-notes-last">
          <b>{notes.last.who}</b> <span dir="auto">{notes.last.text}</span>
        </div>
      ) : null}
      <div className="bsp-st-notes-panel">{notes.panel}</div>
    </details>
  ) : null;

  return (
    <div className="bsp-st" data-testid="draft-editor">
      {/*
        THE POST BEING EDITED — the prototype's banner for an existing post
        (`ep`): its picture, "Editing", its status, its title, and what that
        status means here, with the ways on. Every note is the product's own.
      */}
      <section className="bsp-st-ep" data-tone={epTone} data-testid="draft-context">
        <span className="bsp-st-ep-art" aria-hidden="true">
          <PostArt art={epArt} />
        </span>
        <span className="bsp-st-ep-copy">
          <span className="bsp-st-ep-kick">
            <span>{t['studio.editing']}</span>
            <span className={`bsp-xstatus ${XSTATUS[draft.status] ?? 'bsp-neu'}`}>
              {statusLabel}
            </span>
          </span>
          <span className="bsp-st-ep-title" dir="auto">
            {draft.title}
          </span>
          {attach && can.edit ? (
            <span className="bsp-st-ep-note" role="status" data-testid="editor-attached-media">
              {(t['editor.media.attached'] ?? '{name}').replace('{name}', attach.name)}
            </span>
          ) : null}
          {draft.readOnly ? (
            <span className="bsp-st-ep-note" role="note" data-testid="editor-published-readonly">
              {t['editor.published.readOnly']}
            </span>
          ) : null}
          {draft.status === 'IN_REVIEW' && can.edit ? (
            <span className="bsp-st-ep-note" role="note" data-testid="editor-in-review-warning">
              {t['editor.inReviewWarning']}
            </span>
          ) : null}
          {draft.status === 'APPROVED' && can.edit ? (
            <span className="bsp-st-ep-note" role="note" data-testid="editor-approved-warning">
              {t['editor.approvedWarning']}
            </span>
          ) : null}
          {/* Q8 — what saving does to a scheduled post depends on who saves it. */}
          {draft.status === 'SCHEDULED' && can.edit ? (
            <span className="bsp-st-ep-note" role="note" data-testid="editor-scheduled-warning">
              {can.schedule
                ? t['editor.scheduledWarning.scheduler']
                : t['editor.scheduledWarning.unschedules']}
            </span>
          ) : null}
          {draft.status === 'CHANGES_REQUESTED' ? (
            <span className="bsp-st-ep-note">{t['editor.lifecycle.changesRequested']}</span>
          ) : null}
          {/* The prototype's note line names the campaign the post is filed under. */}
          {draft.campaignId && campaigns.some((campaign) => campaign.id === draft.campaignId) ? (
            <span className="bsp-st-ep-note" data-testid="editor-campaign-note">
              {statusLabel} · {campaigns.find((campaign) => campaign.id === draft.campaignId)?.name}
            </span>
          ) : null}
          {review?.requiresApproval && draft.status === 'DRAFT' ? (
            <span className="bsp-st-ep-note" data-testid="editor-needs-approval">
              {t['editor.next.needsApproval']}
            </span>
          ) : null}
        </span>
        {draft.readOnly && can.create && actions.duplicate ? (
          <form action={actions.duplicate}>
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="itemId" value={draft.id} />
            <input type="hidden" name="token" value={duplicateToken} />
            <button type="submit" className="bsp-btn bsp-sm bsp-pur" data-testid="editor-duplicate">
              {t['content.action.duplicate']}
            </button>
          </form>
        ) : null}
        {can.submit && draft.status === 'IN_REVIEW' && draft.openApprovalId ? (
          <form action={actions.cancelReview}>
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="itemId" value={draft.id} />
            <input type="hidden" name="approvalId" value={draft.openApprovalId} />
            <button type="submit" className="bsp-btn bsp-sm" data-testid="withdraw-review">
              {t['content.composer.withdraw']}
            </button>
          </form>
        ) : null}

        {/*
          ITEM 9 (D-332 amended) — A POST THAT FAILED WITH NOTHING PUBLISHED.
          The late message the Publishing screen shows (when it was late), and
          the ways on: Reschedule (the calendar's dialog for this post) — or,
          where the brand requires approval, sending it for review again from
          the bar below — and "Make a new copy", which stays.
        */}
        {draft.status === 'FAILED' && failed ? (
          <div className="bsp-st-ep-more" role="note" data-testid="editor-failed-notice">
            <p className="bsp-st-ep-note">{failed.message}</p>
            <div className="bsp-st-ep-acts">
              {can.schedule && !review?.requiresApproval ? (
                <Link
                  className="bsp-btn bsp-sm"
                  href={`/${locale}/calendar?item=${draft.id}`}
                  data-testid="editor-reschedule"
                >
                  {t['editor.failed.reschedule']}
                </Link>
              ) : null}
              {review?.requiresApproval && can.submit ? (
                <span className="bsp-st-ep-note" data-testid="editor-failed-review-hint">
                  {t['editor.failed.reviewAgain']}
                </span>
              ) : null}
              {can.create && actions.duplicate ? (
                <form action={actions.duplicate}>
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="itemId" value={draft.id} />
                  <input type="hidden" name="token" value={duplicateToken} />
                  <button
                    type="submit"
                    className="bsp-btn bsp-sm bsp-sec"
                    data-testid="editor-failed-duplicate"
                  >
                    {t['content.action.duplicate']}
                  </button>
                </form>
              ) : null}
            </div>
          </div>
        ) : null}

        {/*
          D-288 — CHANGES REQUESTED, AS ONE FLOW: the reviewer's reason,
          then "I made the changes" — an optional answer on their thread,
          the thread resolved, and the post sent for review again.
        */}
        {draft.status === 'CHANGES_REQUESTED' ? (
          <div className="bsp-st-ep-more" data-testid="changes-requested-panel">
            <b className="bsp-st-ep-sub">
              {review?.changes?.reviewer
                ? fill(t['editor.changes.by'] ?? '{name}', { name: review.changes.reviewer })
                : t['editor.changes.title']}
            </b>
            {review?.changes?.note ? (
              <p className="bsp-st-ep-note" dir="auto" data-testid="changes-requested-note">
                {review.changes.note}
              </p>
            ) : null}
            {can.submit ? (
              <form
                action={actions.resubmit}
                className="bsp-st-resubmit"
                onSubmit={flushThenSubmit}
              >
                <input type="hidden" name="locale" value={locale} />
                <input type="hidden" name="itemId" value={draft.id} />
                {(review?.changes?.threadIds ?? []).map((threadId) => (
                  <input key={threadId} type="hidden" name="threadId" value={threadId} />
                ))}
                <label className="bsp-st-label" htmlFor={`${fieldId}-resubmit`}>
                  {t['editor.changes.reply']}
                </label>
                <textarea
                  id={`${fieldId}-resubmit`}
                  className="bsp-st-input"
                  name="reply"
                  dir="auto"
                  maxLength={2_000}
                  data-testid="resubmit-reply"
                />
                <div className="bsp-st-ep-acts">
                  {reviewerPicker('resubmit')}
                  <button
                    type="submit"
                    className="bsp-btn bsp-sm bsp-pur"
                    disabled={anyDirty && !autosaves}
                    title={anyDirty && !autosaves ? t['editor.saveBeforeReview'] : undefined}
                    data-testid="resubmit-submit"
                  >
                    {t['editor.changes.resubmit']}
                  </button>
                </div>
              </form>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* -------------------------------------------- the settings card --- */}
      <section className="bsp-card bsp-st-set">
        <div className="bsp-st-f bsp-st-f5">
          <span className="bsp-lbl">{t['studio.format']}</span>
          {/*
            THE PROTOTYPE'S SWITCH (review of #67). Round 5 (B, D-478): live
            while the post is a draft; once it is sent for review the format
            is fixed, the others are not offered, and the reason is said.
          */}
          <div
            className="bsp-seg bsp-st-seg-full"
            role="group"
            aria-label={t['studio.format']}
            data-testid="editor-format"
            data-value={shownFormat}
          >
            <SegmentPill selector='[aria-pressed="true"]' />
            {[
              ...EDITOR_FORMATS,
              ...(EDITOR_FORMATS.includes(shownFormat) ? [] : [shownFormat]),
            ].map((type) => {
              const locked = !shapeEditable && type !== shownFormat;
              const fit = fitFor(type);
              const dim = shapeEditable && type !== shownFormat && fit.state !== 'ok';
              return (
                <button
                  key={type}
                  type="button"
                  className="bsp-seg-item"
                  aria-pressed={type === shownFormat}
                  disabled={locked}
                  aria-disabled={dim || undefined}
                  data-locked={locked ? 'true' : undefined}
                  data-unavailable={dim ? 'true' : undefined}
                  title={
                    locked
                      ? t['studio.formatLocked']
                      : dim
                        ? fit.state === 'none'
                          ? fill(t['studio.fit.notSetUp'] ?? '{format}', {
                              format: formatLabel(type),
                            })
                          : fill(t['studio.fit.isFor'] ?? '{format}', {
                              format: formatLabel(type),
                              channels: names(fit.carriers),
                            })
                        : undefined
                  }
                  data-value={type}
                  onClick={
                    shapeEditable && type !== shownFormat ? () => chooseFormat(type) : undefined
                  }
                >
                  {formatLabel(type)}
                </button>
              );
            })}
          </div>
          {shapeEditable ? null : (
            /* Round 4 (3.4) — fixed once sent for review, and said so. */
            <span className="bsp-st-hint" data-testid="editor-format-locked">
              {t['studio.formatLocked']}
            </span>
          )}
          {shapeEditable
            ? (() => {
                const dimmed = EDITOR_FORMATS.filter(
                  (type) => type !== shownFormat && fitFor(type).state !== 'ok',
                );
                if (dimmed.length === 0) return null;
                const none = dimmed.filter((type) => fitFor(type).state === 'none');
                const parts = [
                  ...(none.length > 0
                    ? [
                        fill(t['studio.fit.notSetUpMany'] ?? '{formats}', {
                          formats: listOf(locale, none.map(formatLabel)),
                        }),
                      ]
                    : []),
                  ...dimmed
                    .filter((type) => fitFor(type).state === 'fix')
                    .map((type) =>
                      fill(t['studio.fit.cantGo'] ?? '{format}', {
                        format: formatLabel(type),
                        channels: names(fitFor(type).blockers),
                      }),
                    ),
                ];
                return (
                  <span className="bsp-st-hint" data-testid="editor-format-unavailable">
                    {parts.join(' ')}
                  </span>
                );
              })()
            : null}
          {fitAsk && shapeEditable ? (
            (() => {
              if (fitAsk.kind === 'format') {
                const fit = fitFor(fitAsk.type);
                if (fit.state === 'ok') return null;
                const kept = shownChannels.filter((key) => fit.carriers.includes(key));
                return (
                  <span
                    className="bsp-st-hint bsp-st-fit"
                    role="status"
                    data-testid="editor-shape-note"
                  >
                    {fit.state === 'none'
                      ? fill(t['studio.fit.notSetUp'] ?? '{format}', {
                          format: formatLabel(fitAsk.type),
                        })
                      : fill(t['studio.fit.isFor'] ?? '{format}', {
                          format: formatLabel(fitAsk.type),
                          channels: names(fit.carriers),
                        })}
                    {fit.state === 'fix' ? (
                      <button
                        type="button"
                        className="bsp-btn bsp-sm bsp-sec"
                        data-testid="editor-shape-fix"
                        onClick={() => reshape({ format: fitAsk.type, channels: fit.next })}
                      >
                        {kept.length > 0
                          ? fill(t['studio.fit.removeAndSwitch'] ?? '{channels}', {
                              channels: names(fit.blockers),
                              format: formatLabel(fitAsk.type),
                            })
                          : fill(t['studio.fit.replaceAndSwitch'] ?? '{channel}', {
                              channel: names(fit.next),
                              format: formatLabel(fitAsk.type),
                            })}
                      </button>
                    ) : null}
                  </span>
                );
              }
              const key = fitAsk.key;
              if (carriesFormat(shownFormat, key)) return null;
              const target = formatForChannels(EDITOR_FORMATS, carriersOf, [...shownChannels, key]);
              return (
                <span
                  className="bsp-st-hint bsp-st-fit"
                  role="status"
                  data-testid="editor-shape-note"
                >
                  {fill(t['studio.fit.chipCant'] ?? '{channel}', {
                    channel: channelLabel(key),
                    format: formatLabel(shownFormat),
                  })}
                  {target ? (
                    <button
                      type="button"
                      className="bsp-btn bsp-sm bsp-sec"
                      data-testid="editor-shape-fix"
                      onClick={() => reshape({ format: target, channels: [...shownChannels, key] })}
                    >
                      {fill(t['studio.fit.switchAndAdd'] ?? '{channel}', {
                        format: formatLabel(target),
                        channel: channelLabel(key),
                      })}
                    </button>
                  ) : null}
                </span>
              );
            })()
          ) : shapeNote ? (
            <span className="bsp-st-hint" role="status" data-testid="editor-shape-note">
              {shapeNote}
            </span>
          ) : null}
          {draft.arabicDialect ? (
            <span className="bsp-st-hint" data-testid="content-dialect">
              {t['content.composer.dialect']} ·{' '}
              {t[`content.dialect.${draft.arabicDialect}`] ?? draft.arabicDialect}
            </span>
          ) : null}
        </div>
        <div className="bsp-st-f bsp-st-f7">
          <span className="bsp-lbl" id={`${fieldId}-postto`}>
            {t['studio.postTo']}
          </span>
          {/*
            ALL THE CHANNELS, THE POST'S OWN HIGHLIGHTED (review of #67, round
            2), as the prototype's "Post to" row. The post's channels are its
            versions — the tabs that choose which one is edited. Round 5 (B):
            on a draft the others are pressed to add them, and each of the
            post's own has a "✕" to take it off.
          */}
          <div className="bsp-st-chips" data-testid="editor-post-to">
            {draft.variants.length > 0 ? (
              <div
                role="tablist"
                aria-labelledby={`${fieldId}-postto`}
                className="bsp-st-chips"
                data-testid="variant-tabs"
              >
                {draft.variants.map((variant, index) => {
                  if (!shownChannels.includes(variant.platformKey)) return null;
                  const selected = variant.id === activeVariant?.id;
                  const channel = channelOf(variant.platformKey);
                  const removable = shapeEditable && shownChannels.length > 1;
                  return (
                    <button
                      key={variant.id}
                      ref={(node) => {
                        tabRefs.current[variant.id] = node;
                      }}
                      type="button"
                      role="tab"
                      id={`${fieldId}-tab-${variant.id}`}
                      aria-controls={panelId(variant)}
                      aria-selected={selected}
                      tabIndex={selected ? 0 : -1}
                      className="bsp-chip"
                      data-chosen="true"
                      data-testid={`variant-tab-${variant.platformKey}`}
                      {...(removable ? { 'aria-keyshortcuts': 'Delete' } : {})}
                      onClick={() => setActive(variant.id)}
                      onKeyDown={(event) => {
                        if (removable && (event.key === 'Delete' || event.key === 'Backspace')) {
                          event.preventDefault();
                          toggleChannel(variant.platformKey);
                          return;
                        }
                        onTabKey(event, index);
                      }}
                    >
                      <ChannelMark channel={channel} size={14} label={false} />
                      <span className="bsp-ltr">{channel.name}</span>
                      {isDirty(variant) ? <span aria-hidden="true"> •</span> : null}
                      {removable ? (
                        /*
                          Round 5 (B) — take a channel off the draft: the tag
                          chip's own "✕" inside the tab, for a pointer; Delete
                          on the tab does the same from the keyboard (a tab
                          list holds tabs only, so it is not a second button).
                        */
                        <span
                          className="bsp-st-tag-x"
                          aria-hidden="true"
                          title={fill(t['studio.channelRemove'] ?? '{channel}', {
                            channel: channel.name,
                          })}
                          data-testid={`editor-channel-remove-${variant.platformKey}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            toggleChannel(variant.platformKey);
                          }}
                        >
                          ✕
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : null}
            {platforms
              .filter((platform) => !draft.variants.some((v) => v.platformKey === platform.key))
              .map((platform) => {
                const chosen = shownChannels.includes(platform.key);
                const able = shapeEditable && carriesFormat(shownFormat, platform.key);
                /*
                  Round 6 (D-481): on a draft a channel this format cannot carry
                  is dimmed, not mute — its press says why and offers the format
                  that takes it.
                */
                return shapeEditable ? (
                  <button
                    key={platform.key}
                    type="button"
                    className="bsp-chip"
                    aria-pressed={chosen}
                    aria-disabled={!able || undefined}
                    data-unavailable={able ? undefined : 'true'}
                    title={
                      able
                        ? undefined
                        : fill(t['studio.fit.chipCant'] ?? '{channel}', {
                            channel: platform.label,
                            format: formatLabel(shownFormat),
                          })
                    }
                    data-testid={`editor-channel-add-${platform.key}`}
                    onClick={() =>
                      able
                        ? toggleChannel(platform.key)
                        : setFitAsk({ kind: 'channel', key: platform.key })
                    }
                  >
                    <ChannelMark
                      channel={{ key: platform.key, name: platform.label }}
                      size={14}
                      label={false}
                    />
                    <span className="bsp-ltr">{platform.label}</span>
                  </button>
                ) : (
                  <span
                    key={platform.key}
                    className="bsp-chip bsp-st-off"
                    aria-disabled="true"
                    title={t['studio.channelOff']}
                    data-testid={`editor-channel-off-${platform.key}`}
                  >
                    <ChannelMark
                      channel={{ key: platform.key, name: platform.label }}
                      size={14}
                      label={false}
                    />
                    <span className="bsp-ltr">{platform.label}</span>
                  </span>
                );
              })}
          </div>
          <ChannelAccessLine
            access={channelAccess}
            brandId={draft.brandId}
            channels={shownChannels}
            labelOf={channelLabel}
            locale={locale}
            t={t}
          />
        </div>
        {/* Publish time and Campaign share the row until the Pillar exists (round 2). */}
        <div className="bsp-st-f bsp-st-f6">
          <span className="bsp-lbl">{t['studio.when']}</span>
          <span className="bsp-st-anchor">
            <button
              type="button"
              className="bsp-chip bsp-st-wide"
              aria-haspopup="dialog"
              aria-expanded={whenOpen}
              data-testid="editor-when"
              onClick={() => toggleWhen('card')}
            >
              <span className="bsp-st-when-label">
                <CalendarGlyph />
                <span>
                  {/* Round 4 (3.3) — the time itself, never "Scheduled". */}
                  {whenText ? (
                    <span className="bsp-ltr" data-testid="editor-when-label">
                      {whenText}
                    </span>
                  ) : (
                    t['studio.whenUnset']
                  )}
                </span>
              </span>
              {whenIsBest ? (
                <span className="bsp-xstatus bsp-ai" data-testid="editor-when-best">
                  {t['studio.when.best']}
                </span>
              ) : null}
            </button>
            {whenAt === 'card' ? whenPanel('card') : null}
          </span>
        </div>
        <div className="bsp-st-f bsp-st-f6">
          <span className="bsp-lbl">{t['campaigns.composerLabel']}</span>
          {/*
            Q21 — a post with no campaign may be filed by anyone who may create
            posts; moving or removing a campaign needs campaigns.manage.
          */}
          {can.manageCampaigns || (can.attachCampaign && draft.campaignId === null) ? (
            <form
              action={actions.setCampaign}
              className="bsp-st-inline"
              data-testid="content-campaign-form"
            >
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="itemId" value={draft.id} />
              <select
                id={`${fieldId}-campaign`}
                name="campaignId"
                defaultValue={draft.campaignId ?? ''}
                aria-label={t['campaigns.composerLabel']}
                className="bs-control bsp-chip bsp-st-select"
                data-testid="content-campaign"
                /*
                  THE CHOICE IS THE SAVE (review of #67, round 2): the prototype
                  files a post the moment a campaign is picked, so the second
                  "Save edit" beside it is gone. The same form, the same action.
                */
                onChange={(event) => event.currentTarget.form?.requestSubmit()}
              >
                <option value="">{t['campaigns.composerNone']}</option>
                {campaigns.map((campaign) => (
                  <option key={campaign.id} value={campaign.id}>
                    {campaign.name}
                  </option>
                ))}
              </select>
            </form>
          ) : (
            <span className="bsp-st-fixed">
              {campaigns.find((campaign) => campaign.id === draft.campaignId)?.name ??
                t['campaigns.composerNone']}
            </span>
          )}
        </div>
      </section>

      {draft.variants.length === 0 ? (
        <>
          <section className="bsp-card bsp-st-ed" aria-live="polite" data-testid="content-results">
            <p className="bsp-st-none">{t['content.composer.resultsEmpty']}</p>
          </section>
          {/* A draft with no versions yet still has its conversation. */}
          {notesCard}
        </>
      ) : (
        <div className="bsp-st-grid">
          {/* ------------------------------------------------ the editor --- */}
          <section className="bsp-card bsp-st-ed" aria-live="polite" data-testid="content-results">
            <div className="bsp-seg" role="group" aria-label={t['editor.variants.label']}>
              <SegmentPill selector='[aria-pressed="true"]' />
              <button
                type="button"
                className="bsp-seg-item"
                aria-pressed={tab === 'words'}
                data-testid="studio-tab-words"
                onClick={() => setTab('words')}
              >
                {t['studio.tabWords']}
                {activeValue && activeValue.body.trim() !== '' ? (
                  <span className="bsp-st-ok"> ✓</span>
                ) : null}
              </button>
              <button
                type="button"
                className="bsp-seg-item"
                aria-pressed={tab === 'visual'}
                data-testid="studio-tab-visual"
                onClick={() => setTab('visual')}
              >
                {t['studio.tabVisual']}
                {activeValue && activeValue.assetIds.length > 0 ? (
                  <span className="bsp-st-ok"> ✓</span>
                ) : null}
              </button>
            </div>

            {/*
              "WHAT IS THE POST ABOUT?" ON AN OPEN POST — the prototype's editing
              state keeps the topic, "Or start from:" and the AI button (review
              of #67, round 2). The topic is the post's own; starting from an
              idea or a past post opens a new one.
            */}
            {can.edit ? (
              <div className="bsp-st-field" hidden={tab !== 'words'} data-testid="editor-brief">
                <label className="bsp-st-label" htmlFor={`${fieldId}-brief`}>
                  {t['studio.briefLabel']}
                </label>
                <input
                  id={`${fieldId}-brief`}
                  className="bsp-st-brief"
                  value={draft.title}
                  readOnly
                  dir="auto"
                  aria-describedby={`${fieldId}-brief-hint`}
                  data-testid="editor-brief-input"
                />
                {startFrom ? (
                  <div className="bsp-st-start">
                    <span>{t['studio.orStart']}</span>
                    <Link
                      href={startFrom.idea}
                      className="bsp-chip bsp-st-sm"
                      data-testid="editor-start-idea"
                    >
                      {t['create.mode.idea']}
                    </Link>
                    <Link
                      href={startFrom.repurpose}
                      className="bsp-chip bsp-st-sm"
                      data-testid="editor-start-repurpose"
                    >
                      {t['create.mode.repurpose']}
                    </Link>
                  </div>
                ) : null}
                <span id={`${fieldId}-brief-hint`} className="bsp-st-hint bsp-st-start-hint">
                  {t['studio.rewriteSaved']}
                </span>
              </div>
            ) : null}

            {draft.variants.map((variant) => {
              const platform = platforms.find((p) => p.key === variant.platformKey);
              const value = live(variant);
              const selected = variant.id === activeVariant?.id;
              const hashtags = parseHashtags(value.hashtagText);
              const hashtagAction = actionsFor.find((action) => action.key === 'hashtags');
              const { characters, limit } = checkOf(variant);
              const dirty = isDirty(variant);
              // Review of 2a (3): a paid edit offered on its own (the hashtags)
              // states its cost on the button, as "Write caption with AI · N" does.
              const toolButton = (action: (typeof actionsFor)[number], withCost = false) => (
                <button
                  key={action.key}
                  type="button"
                  className="bsp-chip bsp-st-sm"
                  disabled={busy !== null || dirty}
                  data-testid="content-tool"
                  data-tool={action.tool}
                  data-action={action.key}
                  onClick={() =>
                    onTool(
                      variant.id,
                      action.tool,
                      action.tool === 'tone' ? (action.argument ?? toneArgument) : undefined,
                    )
                  }
                >
                  {busy === `${variant.id}:${action.tool}`
                    ? t['content.tool.running']
                    : action.key === 'translate'
                      ? fill(t['editor.ai.translateTo'] ?? '{language}', {
                          language:
                            t[`content.language.${variant.locale === 'AR' ? 'EN' : 'AR'}`] ?? '',
                        })
                      : t[`editor.ai.${action.key}`]}
                  {withCost && selected && !dirty && estimate !== undefined ? (
                    <span
                      className="bsp-st-aiw-cost bsp-ltr"
                      data-testid={`editor-tool-cost-${action.key}`}
                    >
                      {' '}
                      · {formatCredits(estimate)}
                    </span>
                  ) : null}
                </button>
              );
              return (
                <form
                  key={variant.id}
                  id={panelId(variant)}
                  role="tabpanel"
                  aria-labelledby={`${fieldId}-tab-${variant.id}`}
                  hidden={!selected}
                  // A post is answered with a redirect; only the autosave reads a result.
                  action={actions.save as (formData: FormData) => Promise<void>}
                  className="bsp-st-panel"
                  data-testid="content-variant"
                  data-platform={variant.platformKey}
                  onSubmit={() => {
                    dirtyRef.current = false;
                    submittedRef.current = true;
                  }}
                >
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="itemId" value={draft.id} />
                  <input type="hidden" name="variantId" value={variant.id} />

                  <div className="bsp-st-words" hidden={tab !== 'words'}>
                    <div className="bsp-st-field">
                      <div className="bsp-st-caphead">
                        <label className="bsp-st-label" htmlFor={`${fieldId}-${variant.id}`}>
                          {t['editor.caption']}
                        </label>
                        {can.edit && actionsFor.length > 0 ? (
                          <button
                            type="button"
                            className="bsp-btn bsp-pur bsp-sm bsp-st-aiw"
                            disabled
                            title={t['studio.rewriteSaved']}
                            data-testid={`editor-ai-write-${variant.platformKey}`}
                          >
                            <SparkGlyph />
                            {t['studio.aiWrite']}
                            {writeQuote !== null ? (
                              <span className="bsp-st-aiw-cost bsp-ltr">
                                · {formatCredits(writeQuote)}
                              </span>
                            ) : null}
                          </button>
                        ) : null}
                      </div>
                      <textarea
                        id={`${fieldId}-${variant.id}`}
                        className="bsp-st-caption"
                        name="body"
                        value={value.body}
                        dir="auto"
                        readOnly={!can.edit}
                        onChange={(event) => change(variant, { body: event.target.value })}
                        aria-describedby={`${fieldId}-${variant.id}-count`}
                      />
                      <span
                        id={`${fieldId}-${variant.id}-count`}
                        className="bsp-st-count"
                        data-over={limit > 0 && characters > limit ? 'true' : undefined}
                      >
                        <span className="bsp-ltr">
                          {characters} / {limit}
                        </span>{' '}
                        ·{' '}
                        <span data-testid="content-validation">
                          {dirty
                            ? t['editor.unsaved']
                            : t[`content.validation.${variant.validationState}`]}
                        </span>
                      </span>
                      {/* §20 — small changes where the text is; no Copilot needed. */}
                      {can.edit && actionsFor.length > 0 ? (
                        <div
                          className="bsp-st-tools"
                          role="group"
                          aria-label={t['editor.ai.label']}
                          data-testid={`editor-ai-${variant.platformKey}`}
                        >
                          {/*
                            THE PROTOTYPE'S FOUR EDITS under the caption; the
                            product's others (rewrite, more detail, hashtags)
                            are the same buttons under "⋯" (review of #67).
                          */}
                          {actionsFor
                            .filter((action) => MAIN_TOOLS.includes(action.key))
                            .map((action) => toolButton(action))}
                          {actionsFor.some(
                            (action) =>
                              !MAIN_TOOLS.includes(action.key) && action.key !== 'hashtags',
                          ) ? (
                            <MoreDisclosure
                              label={t['editor.ai.more'] ?? ''}
                              testId={`editor-ai-more-${variant.platformKey}`}
                            >
                              <div className="bsp-st-chips">
                                {actionsFor
                                  .filter(
                                    (action) =>
                                      !MAIN_TOOLS.includes(action.key) && action.key !== 'hashtags',
                                  )
                                  .map((action) => toolButton(action))}
                              </div>
                            </MoreDisclosure>
                          ) : null}
                          {!dirty && selected && estimate !== undefined ? (
                            <span
                              className="bsp-st-hint"
                              data-testid={`editor-estimate-${variant.platformKey}`}
                            >
                              {formatCredits(estimate) === '1'
                                ? t['editor.ai.estimateOne']
                                : fill(t['editor.ai.estimate'] ?? '{credits}', {
                                    credits: formatCredits(estimate),
                                  })}
                            </span>
                          ) : (
                            <span className="bsp-st-hint">
                              {dirty ? t['editor.ai.saveFirst'] : t['editor.ai.hint']}
                            </span>
                          )}
                        </div>
                      ) : null}
                    </div>

                    {/*
                      THE HASHTAG FIELD IS ALWAYS RENDERED (PHASE 2 correction):
                      it is the only hashtag input in the product. Round 3 — the
                      prototype's: the chips, one tag typed beside "Add", then
                      where suggestions come from (`Main.dc.html` lines 378–383).
                    */}
                    <div className="bsp-st-tags">
                      <div className="bsp-st-tags-head">
                        <label className="bsp-st-label" htmlFor={`${fieldId}-${variant.id}-tags`}>
                          {t['content.composer.hashtags']}
                        </label>
                        <span className="bsp-st-tags-count bsp-ltr">
                          {parseHashtags(tagTextOf(variant)).length} / {platform?.maxHashtags ?? 0}
                        </span>
                      </div>
                      <div className="bsp-st-tag-row">
                        {hashtags.map((tag) => (
                          <span key={tag} className="bsp-chip bsp-st-tag">
                            <bdi>#{tag}</bdi>
                            {can.edit ? (
                              <button
                                type="button"
                                className="bsp-st-tag-x"
                                aria-label={fill(t['studio.tagRemove'] ?? '{tag}', {
                                  tag: `#${tag}`,
                                })}
                                onClick={() =>
                                  change(variant, {
                                    hashtagText: hashtags
                                      .filter((other) => other !== tag)
                                      .map((other) => `#${other}`)
                                      .join(' '),
                                  })
                                }
                              >
                                ✕
                              </button>
                            ) : null}
                          </span>
                        ))}
                        {hashtags.length === 0 ? (
                          <span className="bsp-st-none">{t['studio.tagsNone']}</span>
                        ) : null}
                      </div>
                      <input type="hidden" name="hashtags" value={tagTextOf(variant)} />
                      {can.edit ? (
                        <div className="bsp-st-tag-add">
                          <input
                            id={`${fieldId}-${variant.id}-tags`}
                            className="bsp-st-tag-input"
                            dir="auto"
                            value={tagDrafts[variant.id] ?? ''}
                            placeholder={t['studio.tagPlaceholder']}
                            onChange={(event) =>
                              setTagDrafts((current) => ({
                                ...current,
                                [variant.id]: event.target.value,
                              }))
                            }
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault();
                                addTags(variant);
                              }
                            }}
                            data-testid={`content-hashtags-${variant.platformKey}`}
                          />
                          <button
                            type="button"
                            className="bsp-btn bsp-sm bsp-sec"
                            disabled={(tagDrafts[variant.id] ?? '').trim() === ''}
                            onClick={() => addTags(variant)}
                            data-testid={`content-hashtags-add-${variant.platformKey}`}
                          >
                            {t['studio.tagAdd']}
                          </button>
                        </div>
                      ) : null}
                      {/*
                        "From Brand Brain": the product's own hashtag edit, which
                        writes from the brand's approved facts (it was under the
                        caption tools' "⋯"). The prototype's "Trending near you"
                        has no source in the product and is left out.
                      */}
                      {can.edit && hashtagAction ? (
                        <div
                          className="bsp-st-tag-group"
                          data-testid={`content-tags-brain-${variant.platformKey}`}
                        >
                          <span className="bsp-st-tag-glabel">
                            {t['studio.tagsFromBrain']}
                            <span className="bsp-xstatus bsp-ai">AI</span>
                          </span>
                          <div className="bsp-st-chips">{toolButton(hashtagAction, true)}</div>
                        </div>
                      ) : null}
                      {/*
                        FIRST COMMENT, ONLY WHERE THE PLATFORM ALLOWS ONE. The
                        field is under the bar's "⋯" (review of #67, round 2);
                        its value travels with this version's form from here.
                      */}
                      {platform?.allowsFirstComment ? (
                        <input type="hidden" name="firstComment" value={value.firstComment} />
                      ) : null}
                    </div>
                  </div>

                  <div
                    className="bsp-st-visual"
                    id={`${fieldId}-${variant.id}-media`}
                    tabIndex={-1}
                    hidden={tab !== 'visual'}
                  >
                    <MediaSlides
                      locale={locale}
                      t={t}
                      options={mediaOptions}
                      value={value.assetIds}
                      maxItems={platform?.maxMediaItems ?? 0}
                      numbered={draft.contentType === 'CAROUSEL' || value.assetIds.length > 1}
                      coverable={draft.contentType === 'REEL' || draft.contentType === 'VIDEO'}
                      cover={value.cover}
                      disabled={!can.edit}
                      testId={`content-media-${variant.platformKey}`}
                      onChange={(assetIds) => change(variant, { assetIds })}
                      onCoverChange={(cover) => change(variant, { cover })}
                      onOpenDrawer={(replace) => setDrawer({ variantId: variant.id, replace })}
                      headlines={value.headlines}
                      onHeadlineChange={(assetId, headline) =>
                        change(variant, { headlines: { ...value.headlines, [assetId]: headline } })
                      }
                    />
                    {pending?.variantId === variant.id ? (
                      <p className="bsp-st-hint" role="status" data-testid="media-generating">
                        {pending.tries >= 40
                          ? t['editor.media.generateSlow']
                          : t['editor.media.generating']}
                      </p>
                    ) : null}
                  </div>
                </form>
              );
            })}

            {tab === 'words' ? (
              <>
                {/*
                  D10 (Phase 2C-3) — A FACT THIS CAPTION USED CHANGED, EXPIRED
                  OR WAS REMOVED: the prototype's `capFix`. Old → new, old →
                  replacement, or "no longer valid for writing"; Rewrite
                  (quoted, never automatic) or Keep as is. The post is never
                  unscheduled and never blocked from publishing by this.
                */}
                {activeVariant && flaggedFacts.length > 0 && can.edit ? (
                  <div
                    className="bsp-st-capfix"
                    role="status"
                    data-testid="fact-change-banner"
                    data-variant={activeVariant.id}
                  >
                    <b>⚠ {t['editor.facts.bannerTitle']}</b>
                    {flaggedFacts.map((entry) => (
                      <div
                        key={entry.knowledgeItemId}
                        className="bsp-st-capfix-row"
                        data-testid={`fact-change-${entry.knowledgeItemId}`}
                        data-kind={entry.state}
                      >
                        <span className="bsp-st-area">{entry.areaLabel}</span>
                        {entry.state === 'changed' || entry.state === 'replaced' ? (
                          <span>
                            <s dir="auto">{factTitle(entry, 'used')}</s> →{' '}
                            <b dir="auto">{factTitle(entry, 'new')}</b>
                          </span>
                        ) : (
                          <span>
                            <s dir="auto">{factTitle(entry, 'used')}</s> ·{' '}
                            {entry.state === 'expired'
                              ? t['editor.facts.expiredInvalid']
                              : t['editor.facts.removedInvalid']}
                          </span>
                        )}
                        {actions.keepFactChange && entry.signature ? (
                          <form action={actions.keepFactChange}>
                            <input type="hidden" name="locale" value={locale} />
                            <input type="hidden" name="itemId" value={draft.id} />
                            <input type="hidden" name="variantId" value={activeVariant.id} />
                            <input
                              type="hidden"
                              name="knowledgeItemId"
                              value={entry.knowledgeItemId}
                            />
                            <input type="hidden" name="signature" value={entry.signature} />
                            <button
                              type="submit"
                              className="bsp-btn bsp-sm bsp-ghost"
                              data-testid={`fact-keep-${entry.knowledgeItemId}`}
                            >
                              {t['editor.facts.keep']}
                            </button>
                          </form>
                        ) : null}
                      </div>
                    ))}
                    {can.rewriteFacts ? (
                      <div className="bsp-st-inline">
                        <button
                          type="button"
                          className="bsp-btn bsp-sm bsp-pur"
                          disabled={
                            busy !== null || isDirty(activeVariant) || refreshEstimate === undefined
                          }
                          data-testid="fact-rewrite"
                          data-with-new={rewriteWithNew ? 'true' : 'false'}
                          onClick={() => onTool(activeVariant.id, 'refresh_facts')}
                        >
                          {busy === `${activeVariant.id}:refresh_facts`
                            ? t['content.tool.running']
                            : fill(
                                (rewriteWithNew
                                  ? t['editor.facts.rewriteNew']
                                  : t['editor.facts.rewriteWithout']) ?? '{credits}',
                                {
                                  credits:
                                    refreshEstimate === undefined
                                      ? '…'
                                      : formatCredits(refreshEstimate),
                                },
                              )}
                        </button>
                      </div>
                    ) : null}
                    {isDirty(activeVariant) ? (
                      <span className="bsp-st-hint">{t['editor.ai.saveFirst']}</span>
                    ) : null}
                  </div>
                ) : null}

                {/*
                  D9 (Phase 2C-3) — "USED N BRAND BRAIN FACTS", for the
                  variant on screen: the prototype's `bbUse` line. Exactly what
                  its current AI version recorded (M5), at the version it used,
                  and what each is now. Never read from the words.
                */}
                {activeVariant &&
                ((activeVariant.knowledge?.length ?? 0) > 0 || draft.brandBrainOn === false) ? (
                  <section className="bsp-st-bb" data-testid="variant-facts">
                    <div className="bsp-st-bb-line">
                      <SparkGlyph />
                      <span data-testid="variant-facts-count">
                        {(activeVariant.knowledge?.length ?? 0) === 0
                          ? draft.brandBrainOn === false
                            ? t['editor.facts.off']
                            : t['editor.facts.none']
                          : (activeVariant.knowledge?.length ?? 0) === 1
                            ? t['editor.facts.usedOne']
                            : fill(t['editor.facts.used'] ?? '{count}', {
                                count: String(activeVariant.knowledge?.length ?? 0),
                              })}
                      </span>
                    </div>
                    {(activeVariant.knowledge?.length ?? 0) > 0 ? (
                      <div className="bsp-st-bb-list">
                        {(activeVariant.knowledge ?? []).map((entry) => (
                          <div
                            key={entry.knowledgeItemId}
                            className="bsp-st-bb-row"
                            data-testid={`variant-fact-${entry.knowledgeItemId}`}
                            data-state={entry.state}
                          >
                            <span className="bsp-st-area">{entry.areaLabel}</span>
                            <span dir="auto" className="bsp-st-grow">
                              <b>{factTitle(entry, 'now')}</b> · v{entry.usedVersion} ·{' '}
                              <span data-testid={`variant-fact-state-${entry.knowledgeItemId}`}>
                                {t[`editor.facts.state.${entry.state}`]}
                              </span>
                            </span>
                            {entry.fixHref ? (
                              <Link
                                className="bsp-st-link"
                                href={entry.fixHref}
                                data-testid={`variant-fact-fix-${entry.knowledgeItemId}`}
                              >
                                {t['editor.facts.fix']}
                              </Link>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </section>
                ) : null}

                {draft.insufficientKnowledge ? (
                  <div className="bsp-st-capfix" role="status" data-testid="content-insufficient">
                    <b>{t['content.insufficient']}</b>
                    <span className="bsp-st-capfix-row">{t['editor.insufficientBody']}</span>
                    {/* Q12 — only the doors this member may walk through. */}
                    {can.teachBrain || can.readBrain ? (
                      <div className="bsp-st-inline">
                        {can.teachBrain ? (
                          <Link
                            className="bsp-btn bsp-sm bsp-sec"
                            href={`/${locale}/onboarding?step=learn`}
                          >
                            {t['editor.insufficient.add']}
                          </Link>
                        ) : null}
                        {can.readBrain ? (
                          <Link className="bsp-btn bsp-sm bsp-ghost" href={brainHref}>
                            {t['editor.brain.open']}
                          </Link>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : null}
          </section>

          {/* ----------------------------------------------- the preview --- */}
          <section className="bsp-card bsp-st-prev" data-testid="draft-preview">
            <div className="bsp-st-prev-head">
              <span className="bsp-lbl">{t['studio.preview']}</span>
              {/*
                "Compare previews" — the product's, not the prototype's: under
                the one "⋯" at the end of the label row (review of #67).
              */}
              {draft.variants.length > 1 ? (
                <MoreDisclosure label={t['studio.moreOptions'] ?? ''} testId="preview-more">
                  <button
                    type="button"
                    className="bsp-chip bsp-st-sm"
                    aria-pressed={compare}
                    data-testid="preview-compare"
                    onClick={() => setCompare((value) => !value)}
                  >
                    {compare ? t['editor.preview.single'] : t['editor.preview.compare']}
                  </button>
                </MoreDisclosure>
              ) : null}
            </div>
            {/* The prototype's channel tabs, drawn for one channel too (round 2). */}
            {draft.variants.length > 0 && !compare ? (
              <div
                className="bsp-seg bsp-st-seg-full"
                role="group"
                aria-label={t['studio.preview']}
              >
                <SegmentPill selector='[aria-pressed="true"]' />
                {draft.variants.map((variant) => {
                  const channel = channelOf(variant.platformKey);
                  return (
                    <button
                      key={variant.id}
                      type="button"
                      aria-pressed={variant.id === activeVariant?.id}
                      title={channel.name}
                      className="bsp-ltr bsp-st-prev-tab"
                      data-testid={`preview-tab-${variant.platformKey}`}
                      onClick={() => setActive(variant.id)}
                    >
                      <ChannelMark channel={channel} size={13} label={false} />
                      <span>{channel.name}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}
            {!compare && activeVariant ? (
              <span className="bsp-st-size bsp-ltr">
                {previewGeometry(draft.contentType, activeVariant.platformKey)}
              </span>
            ) : null}
            {compare
              ? draft.variants.map((variant) => (
                  <div key={variant.id}>
                    {previewOf(variant, `content-preview-${variant.platformKey}`)}
                  </div>
                ))
              : activeVariant
                ? previewOf(activeVariant, `content-preview-${activeVariant.platformKey}`)
                : null}
            {notesCard}
          </section>
        </div>
      )}

      {/* ------------------------------------------------- the checks --- */}
      {draft.variants.length > 0 ? (
        <section className="bsp-card bsp-st-checks" data-testid="studio-checks">
          <div className="bsp-st-checks-head">
            <span className="bsp-lbl">{t['studio.checks']}</span>
            <span className="bsp-st-checks-sub">{t['studio.checksSub']}</span>
          </div>
          <div className="bsp-st-checks-grid">
            {draft.variants.map((variant) => {
              const check = checkOf(variant);
              const expired = expiredChannels[variant.platformKey];
              const bad = check.rows.some((row) => !row.ok);
              const channel = channelOf(variant.platformKey);
              return (
                <div
                  key={variant.id}
                  className="bsp-st-check"
                  data-testid={`studio-check-${variant.platformKey}`}
                >
                  <div className="bsp-st-check-head">
                    <span className="bsp-st-check-mark">
                      <ChannelMark channel={channel} size={14} label={false} />
                    </span>
                    <span className="bsp-ltr bsp-st-check-name">{channel.name}</span>
                    <span
                      className={`bsp-xstatus ${expired || bad ? 'bsp-warn' : ''} bsp-st-noshrink`}
                    >
                      {expired ? expired.label : bad ? t['studio.fix'] : t['studio.ready']}
                    </span>
                  </div>
                  {check.rows.map((row) => (
                    <div key={row.key} className="bsp-st-check-row" data-ok={row.ok}>
                      <span aria-hidden="true">{row.ok ? '✓' : '✕'}</span>
                      <span>{t[`studio.row.${row.key}`]}</span>
                      <span className="bsp-ltr" title={row.value}>
                        {row.value}
                      </span>
                    </div>
                  ))}
                  {/*
                    §21 — WHAT IS WRONG, IN WORDS, WITH THE FIX BESIDE IT. The
                    numbers are the platform's configured limits.
                  */}
                  {check.issues.length > 0 || expired ? (
                    <ul
                      className="bsp-st-issues"
                      data-testid={`editor-issues-${variant.platformKey}`}
                    >
                      {/*
                        Q9 (D-332) — THE ACCOUNT FOR THIS CHANNEL HAS EXPIRED. A
                        warning row in the list the Studio already has: the
                        short status, and what it means on its own line.
                      */}
                      {expiredChannels[variant.platformKey] ? (
                        <li
                          className="warning"
                          data-issue="channel.expired"
                          data-testid={`editor-channel-expired-${variant.platformKey}`}
                        >
                          <span>
                            <b>{expiredChannels[variant.platformKey]?.label}</b>
                            <span style={{ display: 'block' }}>
                              {expiredChannels[variant.platformKey]?.explanation}
                            </span>
                          </span>
                        </li>
                      ) : null}
                      {check.issues.map((issue) => (
                        <IssueRow
                          key={issue.key}
                          issue={issue}
                          t={t}
                          canFix={can.edit}
                          canShorten={tools.includes('shorten') && busy === null}
                          onShorten={() => onTool(variant.id, 'shorten')}
                          onMedia={() => focusMedia(variant)}
                        />
                      ))}
                    </ul>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {/*
        THE STICKY BAR — `Main.dc.html` lines 525–534 (review of #67, round 2):
        status · save state · hint · Reviewer · When · one purple primary · ⋯ ·
        the round Copilot button. "Save edit", the first comment, the tone,
        "Save as template" and Archive are the product's own, under "⋯"; the
        calendar's Schedule is in the When panel, where the time is set.
      */}
      <div className="bsp-st-bar" data-testid="editor-bar">
        <span
          className={`bsp-pill ${STATUS_PILL[draft.status] ?? 'bsp-p-neu'}`}
          data-testid="composer-status"
        >
          {statusLabel}
        </span>
        {activeVariant && can.edit ? (
          <span className="bsp-st-saved" data-testid={`editor-saved-${activeVariant.platformKey}`}>
            {/* Round 4 (3.1) — the prototype's line: "Saves as you type", then "Saved just now". */}
            {!autosaves
              ? activeDirty
                ? t['editor.unsaved']
                : fill(t['editor.saved'] ?? '{when}', {
                    when: relativeLabel(activeVariant.updatedAt, now, t),
                  })
              : autosave === 'failed'
                ? t['studio.saveFailed']
                : autosave === 'saving' || pendingAutosave
                  ? t['studio.saving']
                  : fill(t['editor.saved'] ?? '{when}', {
                      when: relativeLabel(activeVariant.updatedAt, now, t),
                    })}
          </span>
        ) : null}
        <span className="bsp-st-note">
          {draft.status === 'SCHEDULED' && can.edit && !draft.readOnly ? (
            /* Round 5 (4): what an edit does to a scheduled post (D-223), said. */
            <span data-testid="editor-scheduled-edits">
              {can.schedule
                ? t['studio.when.scheduledEdits']
                : t['studio.when.scheduledEditsUnschedule']}
            </span>
          ) : anyDirty &&
            !autosaves &&
            can.submit &&
            (draft.status === 'DRAFT' || draft.status === 'FAILED') ? (
            t['editor.saveBeforeReview']
          ) : null}
        </span>
        {/*
          D-288 — THE NEXT STEP FOLLOWS THE BRAND'S POLICY. Sending for review
          is the bar's one primary wherever it is open; an approved post's next
          step is the calendar, which the When panel opens.
        */}
        {mayReview ? (
          <form
            id={reviewFormId}
            action={actions.submitForReview}
            hidden
            onSubmit={flushThenSubmit}
          >
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="itemId" value={draft.id} />
          </form>
        ) : null}
        {mayScheduleHere && proposed && actions.scheduleFromStudio ? (
          /*
            Batch 7 PR C (B1.2) — SCHEDULING IS ITS OWN PRESS: the popover's
            Schedule (and the bar's, where review is not the next step) sends
            the time the post keeps to the calendar's unchanged `schedule()`
            (lead, horizon, the day's room, the channels), the words saved first.
          */
          <form
            id={`${fieldId}-schedule`}
            action={actions.scheduleFromStudio}
            hidden
            onSubmit={flushThenSubmit}
          >
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="contentItemId" value={draft.id} />
            <input type="hidden" name="date" value={proposed.slice(0, 10)} />
            <input type="hidden" name="time" value={proposed.slice(11, 16)} />
          </form>
        ) : null}
        {mayReview ? reviewerPicker('submit', reviewFormId) : null}
        {!draft.readOnly ? (
          <span className="bsp-st-anchor">
            <button
              type="button"
              className="bsp-chip"
              aria-haspopup="dialog"
              aria-expanded={whenOpen && whenAt === 'bar'}
              data-testid="editor-bar-when"
              onClick={() => toggleWhen('bar')}
            >
              <CalendarGlyph />
              <span>
                {whenText ? <span className="bsp-ltr">{whenText}</span> : t['studio.whenUnset']}
              </span>
            </button>
            {whenAt === 'bar' ? whenPanel('bar') : null}
          </span>
        ) : null}
        {mayReview ? (
          <button
            type="submit"
            form={reviewFormId}
            className="bsp-btn bsp-pur"
            disabled={anyDirty && !autosaves}
            title={anyDirty && !autosaves ? t['editor.saveBeforeReview'] : undefined}
            data-testid="submit-for-review"
          >
            {t['content.composer.submit']}
          </button>
        ) : mayScheduleHere && proposed && actions.scheduleFromStudio ? (
          /*
            Batch 7 PR C (B1.2) — SCHEDULING IS ITS OWN PRESS. The time the
            popover kept goes to the calendar's unchanged `schedule()` (lead,
            horizon, the day's room, the channels), the words saved first.
          */
          <button
            type="submit"
            form={`${fieldId}-schedule`}
            className="bsp-btn bsp-pur"
            disabled={anyDirty && !autosaves}
            data-testid="editor-bar-schedule"
          >
            {t['editor.next.schedule']}
          </button>
        ) : mayScheduleHere ? (
          <button
            type="button"
            className="bsp-btn bsp-pur"
            disabled={anyDirty && !autosaves}
            data-testid="editor-schedule-open"
            onClick={() => {
              setWhenAt('bar');
              setWhenOpen(true);
            }}
          >
            {t['editor.next.schedule']}
          </button>
        ) : null}
        {/* Always drawn: the Brand Brain's sources line lives here (round 3). */}
        {
          <MoreDisclosure
            label={t['studio.moreOptions'] ?? ''}
            testId="editor-bar-more"
            align="end"
            up
          >
            {activeVariant && can.edit ? (
              <button
                type="submit"
                form={panelId(activeVariant)}
                className={activeDirty ? 'bsp-btn bsp-sm bsp-pur' : 'bsp-btn bsp-sm bsp-sec'}
                data-testid={`editor-save-${activeVariant.platformKey}`}
              >
                {t['content.composer.saveEdit']}
              </button>
            ) : null}
            {activeVariant && activePlatform?.allowsFirstComment ? (
              <div className="bsp-fdis-field">
                <label
                  className="bsp-fdis-label"
                  htmlFor={`${fieldId}-${activeVariant.id}-comment`}
                >
                  {t['editor.firstComment']}
                </label>
                <input
                  id={`${fieldId}-${activeVariant.id}-comment`}
                  className="bsp-st-tag-input"
                  value={live(activeVariant).firstComment}
                  readOnly={!can.edit}
                  dir="auto"
                  onChange={(event) => change(activeVariant, { firstComment: event.target.value })}
                  data-testid={`content-first-comment-${activeVariant.platformKey}`}
                />
              </div>
            ) : null}
            {can.edit && tools.includes('tone') ? (
              <div className="bsp-fdis-field">
                <label className="bsp-st-label" htmlFor={`${fieldId}-tone`}>
                  {t['content.tool.toneArgument']}
                </label>
                <div className="bsp-st-inline">
                  <input
                    id={`${fieldId}-tone`}
                    className="bsp-st-tag-input"
                    value={toneArgument}
                    onChange={(event) => setToneArgument(event.target.value)}
                  />
                  {activeVariant ? (
                    <button
                      type="button"
                      className="bsp-btn bsp-sm bsp-sec"
                      disabled={
                        busy !== null || toneArgument.trim() === '' || isDirty(activeVariant)
                      }
                      data-testid="editor-custom-tone"
                      onClick={() => onTool(activeVariant.id, 'tone', toneArgument.trim())}
                    >
                      {t['content.tool.tone']}
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}

            {/* B-7 — restore is the other half of archive: `content.archive`. */}
            {can.archive && draft.status === 'ARCHIVED' ? (
              <form action={actions.transition}>
                <input type="hidden" name="locale" value={locale} />
                <input type="hidden" name="itemId" value={draft.id} />
                <input type="hidden" name="to" value="DRAFT" />
                <button type="submit" className="bsp-btn bsp-sm bsp-sec">
                  {t['content.composer.restore']}
                </button>
              </form>
            ) : null}
            {can.manageTemplates && actions.saveAsTemplate ? (
              /*
               * E4 — SAVE AS TEMPLATE, a disclosure like Archive beside it:
               * the name is the one thing a template needs that the post
               * does not already say.
               */
              <details data-testid="save-as-template">
                <summary className="bsp-btn bsp-sm bsp-ghost">{t['editor.template.save']}</summary>
                <form action={actions.saveAsTemplate} className="bsp-st-disclosed">
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="itemId" value={draft.id} />
                  <label className="bsp-st-label" htmlFor={`${fieldId}-template-name`}>
                    {t['editor.template.name']}
                  </label>
                  <input
                    id={`${fieldId}-template-name`}
                    className="bsp-st-tag-input"
                    name="name"
                    required
                    maxLength={80}
                    dir="auto"
                    data-testid="save-as-template-name"
                  />
                  <span className="bsp-st-hint">{t['editor.template.hint']}</span>
                  <button
                    type="submit"
                    className="bsp-btn bsp-sm bsp-pur bsp-st-end"
                    data-testid="save-as-template-submit"
                  >
                    {t['editor.template.confirm']}
                  </button>
                </form>
              </details>
            ) : null}
            {can.archive && draft.status !== 'ARCHIVED' ? (
              /*
               * B8 — ARCHIVE ASKS FIRST, the same two steps as the Posts
               * menu: the disclosure opens the question, the button inside
               * answers it with the `intent` the server requires.
               */
              <details data-testid="archive-disclosure">
                <summary className="bsp-btn bsp-sm bsp-ghost">
                  {t['content.composer.archive']}
                </summary>
                <form action={actions.transition} className="bsp-st-disclosed">
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="itemId" value={draft.id} />
                  <input type="hidden" name="to" value="ARCHIVED" />
                  <input type="hidden" name="intent" value="ARCHIVE" />
                  <span className="bsp-st-hint">{t['content.archive.confirmBody']}</span>
                  <button
                    type="submit"
                    className="bsp-btn bsp-sm bsp-st-end"
                    data-testid="archive-confirm"
                  >
                    {t['content.archive.confirm']}
                  </button>
                </form>
              </details>
            ) : null}
            {/*
              Round 3 — the prototype has no "Using … Brand Brain" line; the
              sources retrieval returned for this draft are kept here.
            */}
            {/*
              §20 — THE BRAND BRAIN IS AUTOMATIC, AND SAYS SO QUIETLY. The
              sources are what retrieval returned for this draft, never the
              model's claims.
            */}
            <details className="bsp-st-bb" data-testid="draft-brain">
              <summary className="bsp-st-bb-line bsp-st-summary">
                {fill(t['editor.brain.using'] ?? '{brand}', { brand: brandName })}
              </summary>
              {draft.citations.length > 0 ? (
                <div className="bsp-st-bb-list" data-testid="content-citations">
                  <span className="bsp-st-area">{t['editor.brain.basedOn']}</span>
                  {draft.citations.map((citation, index) => (
                    <span key={`${citation.label}-${index}`} className="bsp-st-bb-row" dir="auto">
                      {citation.label}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="bsp-st-hint">{t['editor.brain.noSources']}</p>
              )}
              {can.readBrain ? (
                <Link className="bsp-st-link" href={brainHref}>
                  {t['editor.brain.open']} →
                </Link>
              ) : null}
            </details>
          </MoreDisclosure>
        }
        <StudioCopilotButton label={t['topbar.copilot'] ?? ''} />
      </div>

      {drawerVariant ? (
        <MediaDrawer
          open
          onClose={() => setDrawer(null)}
          locale={locale}
          t={t}
          itemId={draft.id}
          brandId={draft.brandId}
          options={mediaOptions}
          attached={live(drawerVariant).assetIds}
          replacing={drawer?.replace !== null && drawer?.replace !== undefined}
          preferVertical={['REEL', 'STORY', 'VIDEO'].includes(draft.contentType)}
          canUpload={can.uploadMedia}
          canGenerate={canGenerateMedia && creativeFormats.length > 0}
          creativeFormats={creativeFormats}
          defaultPrompt={live(drawerVariant).body.slice(0, 1_000)}
          defaultFormat={
            ['REEL', 'STORY', 'VIDEO'].includes(draft.contentType) &&
            creativeFormats.some((format) => format.key === 'story')
              ? 'story'
              : (creativeFormats[0]?.key ?? '')
          }
          uploadAction={actions.uploadMedia}
          rules={mediaRules}
          uploadResult={uploadReason}
          onPick={(assetId) => {
            const current = live(drawerVariant).assetIds;
            const replace = drawer?.replace ?? null;
            const next =
              replace === null
                ? [...current, assetId]
                : current.map((id, index) => (index === replace ? assetId : id));
            change(drawerVariant, { assetIds: next });
            setDrawer(null);
          }}
          onGenerated={(assetId) => {
            setPending({ variantId: drawerVariant.id, assetId, tries: 0 });
            setDrawer(null);
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

const STATUS_PILL: Readonly<Record<string, string>> = {
  DRAFT: 'bsp-p-neu',
  IN_REVIEW: 'bsp-p-warn',
  CHANGES_REQUESTED: 'bsp-p-warn',
  APPROVED: 'bsp-p-ok',
  SCHEDULED: 'bsp-p-info',
  ARCHIVED: 'bsp-p-neu',
  FAILED: 'bsp-p-bad',
};

const XSTATUS: Readonly<Record<string, string>> = {
  DRAFT: 'bsp-neu',
  IN_REVIEW: 'bsp-warn',
  CHANGES_REQUESTED: 'bsp-warn',
  APPROVED: '',
  SCHEDULED: 'bsp-info',
  ARCHIVED: 'bsp-neu',
  FAILED: 'bsp-bad',
};

/** The prototype's banner background per state (`EPV.bg`). */
const EP_TONE: Readonly<Record<string, string>> = {
  IN_REVIEW: 'review',
  SCHEDULED: 'sched',
  FAILED: 'failed',
};

/** The prototype's four formats (`Main.dc.html` line 341). */
const EDITOR_FORMATS: readonly string[] = ['POST', 'CAROUSEL', 'REEL', 'STORY'];
/** The prototype's four AI edits under the caption; the rest sit under "⋯". */
const MAIN_TOOLS: readonly string[] = ['shorten', 'friendlier', 'professional', 'translate'];

export function CalendarGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3.25" y="5" width="17.5" height="16" rx="2" />
      <path d="M3.25 9.5h17.5M8 3v4M16 3v4" />
    </svg>
  );
}

export function SparkGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3.5 13.6 9l5.4 1.6-5.4 1.6L12 17.5l-1.6-5.3L5 10.6 10.4 9z" />
    </svg>
  );
}

function IssueRow({
  issue,
  t,
  canFix,
  canShorten,
  onShorten,
  onMedia,
}: {
  readonly issue: EditorIssue;
  readonly t: Record<string, string>;
  readonly canFix: boolean;
  readonly canShorten: boolean;
  readonly onShorten: () => void;
  readonly onMedia: () => void;
}) {
  return (
    <li className={issue.severity === 'error' ? 'error' : 'warning'} data-issue={issue.key}>
      <span>{fill(t[issue.key] ?? issue.key, issue.values)}</span>
      {canFix && issue.fix === 'shorten' && canShorten ? (
        <button type="button" className="bsp-st-link" onClick={onShorten}>
          {t['editor.fix.shorten']}
        </button>
      ) : null}
      {canFix && issue.fix === 'media' ? (
        <button type="button" className="bsp-st-link" onClick={onMedia}>
          {t['editor.fix.media']}
        </button>
      ) : null}
    </li>
  );
}

function approvalStateOf(
  status: ComposerDraft['status'],
): 'NOT_REQUIRED' | 'NEEDS_APPROVAL' | 'APPROVED' | 'CHANGES_REQUESTED' {
  switch (status) {
    case 'IN_REVIEW':
      return 'NEEDS_APPROVAL';
    case 'APPROVED':
      return 'APPROVED';
    case 'CHANGES_REQUESTED':
      return 'CHANGES_REQUESTED';
    default:
      return 'NOT_REQUIRED';
  }
}

/** "just now", "5 minutes ago", "3 hours ago", or the date. Server clock. */
function relativeLabel(iso: string, now: number, t: Record<string, string>): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return t['editor.when.now'] ?? '';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return fill(t['editor.when.minutes'] ?? '{n}', { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return fill(t['editor.when.hours'] ?? '{n}', { n: hours });
  return fill(t['editor.when.days'] ?? '{n}', { n: Math.round(hours / 24) });
}
