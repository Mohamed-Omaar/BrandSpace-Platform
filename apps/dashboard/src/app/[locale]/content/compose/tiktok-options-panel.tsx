'use client';

import {
  offeredPrivacyLevels,
  tiktokOptionsProblems,
  type TikTokPostOptions,
  type TikTokPrivacyLevel,
} from '@brandspace/social-connectors/tiktok-options';

/**
 * CONNECTORS C — THE TIKTOK POST OPTIONS (D-505 O4), an APPROVED
 * DESIGN-SYSTEM EXTENSION (CLAUDE.md §4.2; UI-FIDELITY-CONTRACT §6). The
 * prototype draws no TikTok options, and TikTok's content-sharing guidelines
 * require them before a post can go out
 * (developers.tiktok.com/docs/en/content-sharing-guidelines):
 *
 *   - the creator's nickname, from TikTok, fresh on every render;
 *   - "Who can see this post", from the audiences the account offers now,
 *     with NO default;
 *   - Comment, Duet and Stitch off until turned on (Duet and Stitch only for
 *     video), locked off where the creator turned them off in TikTok;
 *   - disclosure off by default; when on, "Your brand", "Branded content" or
 *     both, with the label TikTok will put on the post; branded content is
 *     never "Only me";
 *   - the consent line before the post goes out;
 *   - while TikTok has not audited the app, a line saying every post is
 *     visible only to the creator, and only that audience offered.
 *
 * COMPOSED FROM WHAT THE STUDIO ALREADY DRAWS: the field and label of the
 * caption (`bsp-st-field`, `bsp-st-label`), the Studio's select
 * (`bsp-fdis-field` / `bs-control bsp-fdis-control`), the Settings switch row
 * (`bsp-tg-row` with the `.tgl` switch) and the hint line (`bsp-st-hint`).
 * Nothing new is styled. The switch row is written out rather than
 * `CheckboxRow`, because these switches are controlled and can be locked.
 *
 * Every value travels with the variant's own form (autosave included); the
 * server reads it with `tiktokOptionsFromForm` and the adapter enforces the
 * same rules before anything is sent.
 */

export interface TikTokPostingView {
  /** The app is unaudited: every post is "Only me". */
  readonly forcedPrivate: boolean;
  /** Every TikTok account this post will go to, with its TikTok nickname. */
  readonly accounts: readonly {
    readonly id: string;
    readonly name: string;
    readonly state: 'ready' | 'cannot_post' | 'unavailable';
  }[];
  /** The audiences every ready account offers now. */
  readonly privacyLevels: readonly TikTokPrivacyLevel[];
  readonly commentLocked: boolean;
  readonly duetLocked: boolean;
  readonly stitchLocked: boolean;
  readonly maxVideoSeconds: number | null;
}

/**
 * The Studio's hint line, held to the start edge: the pair the channel-access
 * line already uses (`bsp-st-hint bsp-st-connect`), because a bare
 * `bsp-st-hint` centres itself in a column and these lines sit under labels.
 */
const HINT = 'bsp-st-hint bsp-st-connect';

const fill = (text: string, values: Readonly<Record<string, string>>) =>
  text.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);

export function TikTokOptionsPanel({
  t,
  view,
  value,
  onChange,
  disabled,
  video,
  testId,
}: {
  readonly t: Readonly<Record<string, string>>;
  readonly view: TikTokPostingView;
  readonly value: TikTokPostOptions;
  readonly onChange: (next: TikTokPostOptions) => void;
  readonly disabled: boolean;
  /** Duet and Stitch exist only for video posts. */
  readonly video: boolean;
  readonly testId: string;
}) {
  const word = (key: string) => t[key] ?? '';
  const ready = view.accounts.filter((account) => account.state === 'ready');
  const creator =
    ready.length > 0
      ? {
          privacyLevels: view.privacyLevels,
          cannotPostReason: view.accounts.some((account) => account.state === 'cannot_post')
            ? 'cannot_post'
            : null,
        }
      : null;
  const offered = offeredPrivacyLevels(creator, view.forcedPrivate);
  const problems = tiktokOptionsProblems(value, creator, view.forcedPrivate);
  const brandedBlocked = view.forcedPrivate || value.privacyLevel === 'SELF_ONLY';
  const set = (patch: Partial<TikTokPostOptions>) => onChange({ ...value, ...patch });
  const setDisclosure = (patch: Partial<TikTokPostOptions['disclosure']>) =>
    onChange({ ...value, disclosure: { ...value.disclosure, ...patch } });
  const branded = value.disclosure.enabled && value.disclosure.brandedContent;

  const toggle = (input: {
    name: string;
    label: string;
    hint?: string | undefined;
    checked: boolean;
    locked: boolean;
    onToggle: (checked: boolean) => void;
    testKey: string;
  }) => (
    <label className="bsp-tg-row" data-locked={input.locked ? 'true' : undefined}>
      <span className="bsp-tg-text">
        <span className="bsp-tg-l">{input.label}</span>
        {input.hint ? <span className="bsp-tg-s">{input.hint}</span> : null}
      </span>
      <input
        type="checkbox"
        name={input.name}
        className="bsp-tgl-in"
        checked={input.checked && !input.locked}
        disabled={disabled || input.locked}
        onChange={(event) => input.onToggle(event.target.checked)}
        data-testid={`${testId}-${input.testKey}`}
      />
    </label>
  );

  const names = view.accounts.map((account) => account.name).join(t['studio.tiktok.and'] ?? ', ');

  return (
    <section className="bsp-st-field" aria-labelledby={`${testId}-title`} data-testid={testId}>
      <input type="hidden" name="tiktokOptionsPresent" value="1" />
      <span className="bsp-st-label" id={`${testId}-title`}>
        {word('studio.tiktok.title')}
      </span>

      {view.accounts.length === 0 ? (
        <p className={HINT} data-testid={`${testId}-no-account`}>
          {word('studio.tiktok.noAccount')}
        </p>
      ) : (
        <p className={HINT} data-testid={`${testId}-posting-as`}>
          {fill(word('studio.tiktok.postingAs'), { names })}
        </p>
      )}
      {view.accounts
        .filter((account) => account.state !== 'ready')
        .map((account) => (
          <p
            key={account.id}
            className={HINT}
            role="status"
            data-testid={`${testId}-${account.state === 'cannot_post' ? 'cannot-post' : 'unavailable'}`}
          >
            {fill(
              word(
                account.state === 'cannot_post'
                  ? 'studio.tiktok.cannotPost'
                  : 'studio.tiktok.unavailable',
              ),
              { name: account.name },
            )}
          </p>
        ))}
      {view.forcedPrivate ? (
        <p className={HINT} data-testid={`${testId}-forced-private`}>
          {word('studio.tiktok.forcedPrivate')}
        </p>
      ) : null}

      <label className="bsp-fdis-field">
        <span className="bsp-fdis-label">{word('studio.tiktok.privacy')}</span>
        <select
          className="bs-control bsp-fdis-control"
          name="tiktokPrivacyLevel"
          value={value.privacyLevel ?? ''}
          disabled={disabled || offered.length === 0}
          onChange={(event) =>
            set({
              privacyLevel: (event.target.value || null) as TikTokPrivacyLevel | null,
              // Branded content cannot be private: choosing "Only me" clears it.
              ...(event.target.value === 'SELF_ONLY'
                ? { disclosure: { ...value.disclosure, brandedContent: false } }
                : {}),
            })
          }
          data-testid={`${testId}-privacy`}
        >
          <option value="" disabled>
            {word('studio.tiktok.privacyChoose')}
          </option>
          {offered.map((level) => (
            <option key={level} value={level}>
              {word(`studio.tiktok.privacy.${level}`)}
            </option>
          ))}
        </select>
      </label>

      <span className="bsp-fdis-label">{word('studio.tiktok.allow')}</span>
      {toggle({
        name: 'tiktokAllowComment',
        label: word('studio.tiktok.comment'),
        hint: view.commentLocked ? word('studio.tiktok.lockedByCreator') : undefined,
        checked: value.allowComment,
        locked: view.commentLocked,
        onToggle: (checked) => set({ allowComment: checked }),
        testKey: 'comment',
      })}
      {video
        ? toggle({
            name: 'tiktokAllowDuet',
            label: word('studio.tiktok.duet'),
            hint: view.duetLocked ? word('studio.tiktok.lockedByCreator') : undefined,
            checked: value.allowDuet,
            locked: view.duetLocked,
            onToggle: (checked) => set({ allowDuet: checked }),
            testKey: 'duet',
          })
        : null}
      {video
        ? toggle({
            name: 'tiktokAllowStitch',
            label: word('studio.tiktok.stitch'),
            hint: view.stitchLocked ? word('studio.tiktok.lockedByCreator') : undefined,
            checked: value.allowStitch,
            locked: view.stitchLocked,
            onToggle: (checked) => set({ allowStitch: checked }),
            testKey: 'stitch',
          })
        : null}

      {toggle({
        name: 'tiktokDisclose',
        label: word('studio.tiktok.disclose'),
        hint: word('studio.tiktok.discloseHint'),
        checked: value.disclosure.enabled,
        locked: false,
        onToggle: (checked) =>
          setDisclosure(
            checked
              ? { enabled: true }
              : { enabled: false, yourBrand: false, brandedContent: false },
          ),
        testKey: 'disclose',
      })}
      {value.disclosure.enabled ? (
        <>
          {toggle({
            name: 'tiktokYourBrand',
            label: word('studio.tiktok.yourBrand'),
            hint: word('studio.tiktok.yourBrandHint'),
            checked: value.disclosure.yourBrand,
            locked: false,
            onToggle: (checked) => setDisclosure({ yourBrand: checked }),
            testKey: 'your-brand',
          })}
          {toggle({
            name: 'tiktokBrandedContent',
            label: word('studio.tiktok.branded'),
            hint: brandedBlocked
              ? word('studio.tiktok.brandedPrivate')
              : word('studio.tiktok.brandedHint'),
            checked: value.disclosure.brandedContent,
            locked: brandedBlocked,
            onToggle: (checked) => setDisclosure({ brandedContent: checked }),
            testKey: 'branded',
          })}
        </>
      ) : null}

      {view.maxVideoSeconds !== null && video ? (
        <p className={HINT} data-testid={`${testId}-max-video`}>
          {fill(word('studio.tiktok.maxVideo'), {
            minutes: String(Math.floor(view.maxVideoSeconds / 60)),
          })}
        </p>
      ) : null}

      {problems[0] ? (
        <p className={HINT} role="status" data-testid={`${testId}-problem`}>
          {word(`studio.tiktok.problem.${problems[0].replace('tiktok.', '')}`)}
        </p>
      ) : null}

      <p className={HINT} data-testid={`${testId}-consent`}>
        {word(branded ? 'studio.tiktok.consentBranded' : 'studio.tiktok.consent')}
      </p>
    </section>
  );
}
