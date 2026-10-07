'use client';

import { useId, useState } from 'react';
import type { UploadRules } from '../../../components/upload-rules';
import {
  UploadFileInput,
  UploadForm,
  UploadRulesLine,
  UploadStatus,
  uploadTexts,
} from '../../../components/upload-field';
import { Button, CONTROL_CLASS, Dialog, colorTokens, visuallyHiddenStyle } from '@brandspace/ui';
import { translator, type MessageKey } from '../../../i18n/messages';
import {
  addBrandFontAction,
  chooseBrandLogoAction,
  removeBrandFontAction,
  renameBrandFontAction,
  replaceBrandFontAction,
  saveBrandColoursAction,
  saveBrandTypographyAction,
  uploadBrandLogoAction,
} from './look-actions';
import { useMessageLocale } from '../../../i18n/message-locale-context';
import { MoreDisclosure } from '../../../components/more-disclosure';

/**
 * LOOK & VOICE: COLOURS, LOGO AND FONTS — as the prototype draws them
 * (`Main.dc.html` lines 869–876; Gate 2b of round 4).
 *
 * The logo on its two tiles with "Replace"; the colours as 52px swatches, each
 * a colour picker with its hex under it, × to remove and a dashed "+" to add;
 * the fonts as one card of two columns, one per language, each slot a row of
 * chips drawn in their own font, a sample in the chosen pair, and the brand's
 * uploaded fonts for that language under it.
 *
 * Left out, as the owner decided: the brand templates card. What the product
 * has and the prototype does not draw sits behind an existing affordance: the
 * logo picked from the Asset Library is behind the logo card's "⋯", and the
 * hex under a swatch stays typeable.
 *
 * EVERY CONTROL IS REAL OR ABSENT. Editing needs `brand.manage` (the E3
 * deviation); uploading also needs `assets.upload`, which the asset service
 * checks again on the server. A reader without them sees the values only.
 *
 * A font preview is drawn in the font itself, under its scoped name, with
 * synthetic bold and italic off. An uploaded font the reader cannot load shows
 * in the language's default, and says so.
 */

type Language = 'en' | 'ar';
type Role = 'heading' | 'body';

export interface LookViewData {
  readonly palette: readonly string[];
  readonly logo: { readonly assetId: string; readonly url: string | null } | null;
  readonly logoOptions: readonly { readonly id: string; readonly name: string }[];
  readonly slots: Readonly<
    Record<
      Language,
      Readonly<
        Record<
          Role,
          {
            readonly value: string;
            readonly name: string;
            readonly cssFamily: string;
            readonly fellBack: boolean;
          }
        >
      >
    >
  >;
  readonly options: Readonly<
    Record<
      Language,
      readonly {
        readonly value: string;
        readonly label: string;
        readonly cssFamily: string;
        readonly uploaded: boolean;
      }[]
    >
  >;
  readonly fonts: readonly {
    readonly id: string;
    readonly language: Language;
    readonly displayName: string;
    readonly status: 'processing' | 'ready' | 'failed' | 'unavailable';
  }[];
  readonly maxPerLanguage: number;
  /** Batch 7 (A3): what a font or an image may be, from activated configuration. */
  readonly fontRules: UploadRules;
  readonly imageRules: UploadRules;
}

const LANGUAGES: readonly Language[] = ['en', 'ar'];
const ROLES: readonly Role[] = ['heading', 'body'];
const MAX_COLOURS = 12;

/** A native colour input takes only `#rrggbb`. */
function sixDigit(hex: string): string {
  const match = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex);
  if (match) return `#${match[1]}${match[1]}${match[2]}${match[2]}${match[3]}${match[3]}`;
  return /^#[0-9a-f]{6}$/i.test(hex) ? hex : colorTokens.brandPurple;
}

const fallbackStack: Record<Language, string> = {
  en: "system-ui, 'Segoe UI', Roboto, Arial, sans-serif",
  ar: "system-ui, 'Segoe UI', Tahoma, Arial, sans-serif",
};

function family(cssFamily: string, language: Language): React.CSSProperties {
  return { fontFamily: `'${cssFamily}', ${fallbackStack[language]}`, fontSynthesis: 'none' };
}

/** A font's state as the prototype's pill tones. */
const FONT_PILL: Readonly<Record<LookViewData['fonts'][number]['status'], string>> = {
  ready: 'bsp-p-ok',
  processing: 'bsp-p-info',
  failed: 'bsp-p-bad',
  unavailable: 'bsp-p-neu',
};

export function LookCard({
  locale,
  brandId,
  look,
  canManage,
  canUpload,
  uploadRefusal = null,
  children,
}: {
  locale: string;
  brandId: string;
  look: LookViewData;
  canManage: boolean;
  canUpload: boolean;
  /** Batch 7 (A3): why the last upload here was refused (`upload-logo`, `add-font`, `replace-font`). */
  uploadRefusal?: { readonly for: string; readonly message: string } | null;
  /** The Voice card, which the prototype sets between the colours and the fonts. */
  children?: React.ReactNode;
}) {
  const t = translator(useMessageLocale(locale));
  /*
   * THE PROTOTYPE'S LOOK & VOICE GRID (`Main.dc.html` lines 869–876): Logo and
   * Colours across the top (its third card, templates, is left out — the
   * product has no design templates), then Voice, then the fonts, full width.
   */
  return (
    <div
      className="bsp-bb-lookgrid"
      role="group"
      data-testid="look-card"
      aria-label={t('bb.look.title')}
    >
      <Logo
        locale={locale}
        brandId={brandId}
        logo={look.logo}
        options={look.logoOptions}
        rules={look.imageRules}
        refusal={uploadRefusal?.for === 'upload-logo' ? uploadRefusal.message : null}
        canManage={canManage}
        canUpload={canManage && canUpload}
      />
      <Colours locale={locale} brandId={brandId} palette={look.palette} canManage={canManage} />
      {children}
      <Fonts
        locale={locale}
        brandId={brandId}
        look={look}
        refusal={
          uploadRefusal && uploadRefusal.for !== 'upload-logo' ? uploadRefusal.message : null
        }
        canManage={canManage}
        canUpload={canManage && canUpload}
      />
    </div>
  );
}

function Hidden({ locale, brandId }: { locale: string; brandId: string }) {
  return (
    <>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="brandId" value={brandId} />
    </>
  );
}

/**
 * The prototype's file button: `label.btn.sm.sec` over a transparent file
 * input. Choosing a file shows what was chosen and the button that sends it —
 * nothing is uploaded on the pick alone.
 */
function FileButton({
  label,
  testId,
  ariaLabel,
  onPick,
}: {
  label: string;
  testId: string;
  ariaLabel: string;
  onPick: (name: string | null) => void;
}) {
  return (
    <label className="bsp-btn bsp-sm bsp-sec bsp-lk-file">
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
        <path d="M12 16V4M7 9l5-5 5 5M4 20h16" />
      </svg>
      {label}
      <UploadFileInput
        name="file"
        required
        aria-label={ariaLabel}
        data-testid={testId}
        onChosen={(file) => onPick(file?.name ?? null)}
      />
    </label>
  );
}

/* ------------------------------------------------------------------ colours */

function Colours({
  locale,
  brandId,
  palette,
  canManage,
}: {
  locale: string;
  brandId: string;
  palette: readonly string[];
  canManage: boolean;
}) {
  const t = translator(useMessageLocale(locale));
  const [colours, setColours] = useState<string[]>([...palette]);
  const headingId = useId();

  if (!canManage) {
    return (
      <section
        aria-labelledby={headingId}
        data-testid="look-colours"
        className="bsp-card bsp-bb-lc bsp-bb-lc-2"
      >
        <h5 id={headingId} className="bsp-lbl bsp-bb-lc-t">
          {t('bb.look.colours')}
        </h5>
        {palette.length === 0 ? (
          <p className="bsp-lk-muted">{t('bb.look.coloursEmpty')}</p>
        ) : (
          <ul className="bsp-lk-swatches">
            {palette.map((colour) => (
              <li key={colour} className="bsp-lk-sw" data-testid={`look-swatch-${colour}`}>
                <span
                  aria-hidden="true"
                  className="bsp-lk-sw-tile"
                  style={{ background: colour }}
                />
                <span className="bsp-ltr bsp-lk-hex-t">{colour}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }

  const set = (index: number, value: string) =>
    setColours((current) => current.map((colour, i) => (i === index ? value : colour)));

  return (
    <section
      aria-labelledby={headingId}
      data-testid="look-colours"
      className="bsp-card bsp-bb-lc bsp-bb-lc-2"
    >
      <h5 id={headingId} className="bsp-lbl bsp-bb-lc-t">
        {t('bb.look.colours')}
      </h5>
      <form action={saveBrandColoursAction} className="bsp-lk-form" data-testid="look-colours-form">
        <Hidden locale={locale} brandId={brandId} />
        {colours.length === 0 ? <p className="bsp-lk-muted">{t('bb.look.coloursEmpty')}</p> : null}
        {/*
          The swatches (`x.swatches`): a 52px tile that is the colour picker,
          the hex under it, and × at its corner; then the dashed "+".
        */}
        <ul className="bsp-lk-swatches">
          {colours.map((colour, index) => {
            const number = String(index + 1);
            return (
              <li key={index} className="bsp-lk-sw" data-testid={`look-colour-${index}`}>
                <label className="bsp-lk-sw-tile" style={{ background: sixDigit(colour) }}>
                  <input
                    type="color"
                    value={sixDigit(colour)}
                    onChange={(event) => set(index, event.target.value.toUpperCase())}
                    aria-label={t('bb.look.colourPicker').replace('{n}', number)}
                    data-testid={`look-colour-picker-${index}`}
                  />
                </label>
                <input
                  className="bs-control bsp-ltr bsp-lk-hex"
                  name="colorPalette"
                  value={colour}
                  onChange={(event) => set(index, event.target.value.trim())}
                  aria-label={t('bb.look.colourHex').replace('{n}', number)}
                  dir="ltr"
                  maxLength={7}
                  data-testid={`look-colour-hex-${index}`}
                />
                <button
                  type="button"
                  className="bsp-lk-sw-x"
                  onClick={() => setColours((current) => current.filter((_, i) => i !== index))}
                  aria-label={t('bb.look.colourRemove').replace('{n}', number)}
                  data-testid={`look-colour-remove-${index}`}
                >
                  ×
                </button>
              </li>
            );
          })}
          {colours.length < MAX_COLOURS ? (
            <li className="bsp-lk-sw">
              <button
                type="button"
                className="bsp-lk-sw-add"
                onClick={() => setColours((current) => [...current, colorTokens.brandPurple])}
                aria-label={t('bb.look.colourAdd')}
                data-testid="look-colour-add"
              >
                +
              </button>
            </li>
          ) : null}
        </ul>
        <button
          type="submit"
          className="bsp-btn bsp-sm bsp-pur bsp-lk-start"
          data-testid="look-colours-save"
        >
          {t('common.save')}
        </button>
      </form>
    </section>
  );
}

/* ------------------------------------------------------------------ logo */

function Logo({
  locale,
  brandId,
  logo,
  options,
  rules,
  refusal,
  canManage,
  canUpload,
}: {
  locale: string;
  brandId: string;
  logo: LookViewData['logo'];
  options: LookViewData['logoOptions'];
  rules: UploadRules;
  refusal: string | null;
  canManage: boolean;
  canUpload: boolean;
}) {
  const t = translator(useMessageLocale(locale));
  const headingId = useId();
  const pickId = useId();
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <section aria-labelledby={headingId} data-testid="look-logo" className="bsp-card bsp-bb-lc">
      <span className="bsp-lk-head">
        <h5 id={headingId} className="bsp-lbl bsp-bb-lc-t">
          {t('bb.look.logo')}
        </h5>
        {canManage && options.length > 0 ? (
          /* The logo from the Asset Library, behind the card's "⋯". */
          <MoreDisclosure label={t('bb.look.logoFromLibrary')} testId="look-logo-more" align="end">
            <form
              action={chooseBrandLogoAction}
              className="bsp-lk-form"
              data-testid="look-logo-choose"
            >
              <Hidden locale={locale} brandId={brandId} />
              <label htmlFor={pickId} className="bsp-lbl">
                {t('bb.look.logoFromLibrary')}
              </label>
              <select
                id={pickId}
                name="primaryLogoAssetId"
                className={CONTROL_CLASS}
                defaultValue={logo?.assetId ?? ''}
                data-testid="look-logo-select"
              >
                <option value="">{t('bb.look.logoNone')}</option>
                {options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                className="bsp-btn bsp-sm bsp-pur bsp-lk-start"
                data-testid="look-logo-choose-save"
              >
                {t('common.save')}
              </button>
            </form>
          </MoreDisclosure>
        ) : null}
      </span>
      {logo?.url ? (
        /* The mark on the prototype's two tiles: ink and cream. */
        <div className="bsp-lk-tiles">
          <span className="bsp-lk-tile bsp-lk-tile-d">
            <img src={logo.url} alt={t('bb.look.logoAlt')} data-testid="look-logo-image" />
          </span>
          <span className="bsp-lk-tile bsp-lk-tile-l" aria-hidden="true">
            <img src={logo.url} alt="" />
          </span>
        </div>
      ) : (
        <p className="bsp-lk-muted" data-testid="look-logo-empty">
          {t('bb.look.logoEmpty')}
        </p>
      )}
      {canUpload ? (
        <UploadForm
          action={uploadBrandLogoAction}
          rules={rules}
          locale={locale}
          texts={uploadTexts(t)}
          className="bsp-lk-form"
          data-testid="look-logo-form"
        >
          <Hidden locale={locale} brandId={brandId} />
          <FileButton
            label={t('bb.look.replace')}
            testId="look-logo-file"
            ariaLabel={t('bb.look.logoUpload')}
            onPick={setPicked}
          />
          {picked ? (
            <span className="bsp-lk-picked">
              <span className="bsp-ltr bsp-lk-meta">{picked}</span>
              <button
                type="submit"
                className="bsp-btn bsp-sm bsp-pur"
                data-testid="look-logo-submit"
              >
                {t('bb.look.logoReplace')}
              </button>
            </span>
          ) : null}
          <UploadRulesLine className="bsp-lk-meta" />
          <UploadStatus
            testId="look-logo-status"
            result={refusal ? { tone: 'error', message: refusal } : null}
          />
        </UploadForm>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ fonts */

function Fonts({
  locale,
  brandId,
  look,
  refusal,
  canManage,
  canUpload,
}: {
  locale: string;
  brandId: string;
  look: LookViewData;
  /** Batch 7 (A3): why the last font upload was refused. */
  refusal: string | null;
  canManage: boolean;
  canUpload: boolean;
}) {
  const t = translator(useMessageLocale(locale));
  const headingId = useId();
  const formId = useId();
  const [chosen, setChosen] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      LANGUAGES.flatMap((language) =>
        ROLES.map((role) => [`${language}-${role}`, look.slots[language][role].value]),
      ),
    ),
  );

  /** What a slot draws in: the stored face while unchanged (its fallback, if any). */
  const drawn = (language: Language, role: Role): string => {
    const key = `${language}-${role}`;
    const slot = look.slots[language][role];
    if (chosen[key] === slot.value) return slot.cssFamily;
    return (
      look.options[language].find((entry) => entry.value === chosen[key])?.cssFamily ??
      slot.cssFamily
    );
  };

  return (
    <section
      aria-labelledby={headingId}
      data-testid="look-fonts"
      className="bsp-card bsp-bb-lc bsp-bb-lc-full"
    >
      <h5 id={headingId} className="bsp-lbl bsp-bb-lc-t">
        {t('bb.look.fonts')}
      </h5>
      {refusal ? (
        <span
          role="alert"
          className="bsp-up-status"
          data-tone="error"
          data-testid="look-fonts-refusal"
        >
          {refusal}
        </span>
      ) : null}
      {canManage ? (
        /*
         * The slots' form is empty and its controls point at it (`form=`), so
         * each language's own upload forms can sit in its column, as the
         * prototype draws them, without nesting one form in another.
         */
        <form id={formId} action={saveBrandTypographyAction} data-testid="look-fonts-form" hidden>
          <Hidden locale={locale} brandId={brandId} />
        </form>
      ) : null}
      <div className="bsp-lk-langs">
        {LANGUAGES.map((language) => (
          <div key={language} className="bsp-lk-lang">
            <b className="bsp-lk-lang-t">{t(`bb.look.language.${language}` as MessageKey)}</b>
            {ROLES.map((role) => {
              const key = `${language}-${role}`;
              const slot = look.slots[language][role];
              const label = t(`bb.look.slot.${language}.${role}` as MessageKey);
              return (
                <div key={key} className="bsp-lk-slot" data-testid={`look-slot-${key}`}>
                  <span className="bsp-lk-slot-l" id={`${headingId}-${key}`}>
                    {label}
                  </span>
                  {canManage ? (
                    <div
                      className="bsp-lk-chips"
                      role="radiogroup"
                      aria-labelledby={`${headingId}-${key}`}
                      data-testid={`look-slot-select-${key}`}
                    >
                      {look.options[language].map((entry) => (
                        <label
                          key={entry.value}
                          className="bsp-chip bsp-lk-chip"
                          style={family(entry.cssFamily, language)}
                        >
                          <input
                            type="radio"
                            form={formId}
                            name={`font-${language}-${role}`}
                            value={entry.value}
                            checked={chosen[key] === entry.value}
                            onChange={() =>
                              setChosen((current) => ({ ...current, [key]: entry.value }))
                            }
                            aria-label={
                              entry.uploaded
                                ? t('bb.look.uploadedOption').replace('{name}', entry.label)
                                : entry.label
                            }
                          />
                          {entry.label}
                          {entry.uploaded ? (
                            <span aria-hidden="true" className="bsp-lk-up">
                              ↑
                            </span>
                          ) : null}
                        </label>
                      ))}
                    </div>
                  ) : (
                    <div className="bsp-lk-chips">
                      <span
                        className="bsp-chip bsp-lk-chip"
                        aria-pressed="true"
                        style={family(slot.cssFamily, language)}
                      >
                        {slot.name}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
            {/* The sample (`fr.sampleH` over `fr.sampleB`, `Main.dc.html` line 876). */}
            <div className="bsp-lk-sample" dir={language === 'ar' ? 'rtl' : 'ltr'} lang={language}>
              <span
                className="bsp-lk-sample-h"
                style={family(drawn(language, 'heading'), language)}
                data-testid={`look-slot-preview-${language}-heading`}
                data-font-family={drawn(language, 'heading')}
              >
                {translator(language)('bb.look.sample.heading')}
              </span>
              <span
                className="bsp-lk-sample-b"
                style={family(drawn(language, 'body'), language)}
                data-testid={`look-slot-preview-${language}-body`}
                data-font-family={drawn(language, 'body')}
              >
                {translator(language)('bb.look.sample.body')}
              </span>
            </div>
            {ROLES.map((role) => {
              const key = `${language}-${role}`;
              const slot = look.slots[language][role];
              return chosen[key] === slot.value && slot.fellBack ? (
                <span key={key} className="bsp-lk-meta" data-testid={`look-slot-fallback-${key}`}>
                  {t('bb.look.fallbackNote').replace('{font}', slot.name)}
                </span>
              ) : null;
            })}
            {canManage ? (
              <LanguageFonts
                locale={locale}
                brandId={brandId}
                language={language}
                look={look}
                canUpload={canUpload}
              />
            ) : null}
          </div>
        ))}
      </div>
      {canManage ? (
        <div className="bsp-lk-save">
          <button
            type="submit"
            form={formId}
            className="bsp-btn bsp-sm bsp-pur"
            data-testid="look-fonts-save"
          >
            {t('common.save')}
          </button>
          <span className="bsp-lk-note">{t('bb.look.fontsHint')}</span>
        </div>
      ) : (
        <span className="bsp-lk-note">{t('bb.look.fontsHint')}</span>
      )}
      {canManage ? (
        <span className="bsp-lk-note" data-testid="look-uploaded">
          {t('bb.look.uploadedHint').replace('{max}', String(look.maxPerLanguage))}
        </span>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ uploaded fonts */

function LanguageFonts({
  locale,
  brandId,
  language,
  look,
  canUpload,
}: {
  locale: string;
  brandId: string;
  language: Language;
  look: LookViewData;
  canUpload: boolean;
}) {
  const t = translator(useMessageLocale(locale));
  const nameId = useId();
  const [picked, setPicked] = useState<string | null>(null);
  const fonts = look.fonts.filter((font) => font.language === language);
  const full = fonts.length >= look.maxPerLanguage;
  const languageName = t(`bb.look.language.${language}` as MessageKey);
  return (
    <div className="bsp-lk-yours" data-testid={`look-uploaded-${language}`}>
      {canUpload ? (
        full ? (
          <span className="bsp-lk-meta" data-testid={`look-uploaded-full-${language}`}>
            {t('bb.look.uploadedFull').replace('{max}', String(look.maxPerLanguage))}
          </span>
        ) : (
          <UploadForm
            action={addBrandFontAction}
            rules={look.fontRules}
            locale={locale}
            texts={uploadTexts(t)}
            className="bsp-lk-form"
            data-testid={`look-font-add-${language}`}
          >
            <Hidden locale={locale} brandId={brandId} />
            <input type="hidden" name="language" value={language} />
            <FileButton
              label={t('bb.look.fontAdd')}
              testId={`look-font-file-${language}`}
              ariaLabel={`${t('bb.look.fontAdd')} · ${languageName}`}
              onPick={setPicked}
            />
            {picked ? (
              <span className="bsp-lk-picked">
                <label htmlFor={nameId} style={visuallyHiddenStyle()}>
                  {t('bb.look.fontName')}
                </label>
                <input
                  id={nameId}
                  className={`${CONTROL_CLASS} bsp-lk-name`}
                  name="displayName"
                  maxLength={80}
                  placeholder={picked}
                  data-testid={`look-font-name-${language}`}
                />
                <button
                  type="submit"
                  className="bsp-btn bsp-sm bsp-pur"
                  data-testid={`look-font-add-submit-${language}`}
                >
                  {t('bb.look.fontAdd')}
                </button>
              </span>
            ) : null}
            <UploadRulesLine className="bsp-lk-meta" />
            <UploadStatus testId={`look-font-status-${language}`} />
          </UploadForm>
        )
      ) : null}
      {fonts.length === 0 ? (
        <span className="bsp-lk-meta" data-testid={`look-uploaded-empty-${language}`}>
          {t('bb.look.uploadedEmpty')}
        </span>
      ) : (
        <>
          <span className="bsp-lk-slot-l">{t('bb.look.uploaded')}</span>
          <ul className="bsp-lk-fonts">
            {fonts.map((font) => (
              <FontRow
                key={font.id}
                locale={locale}
                brandId={brandId}
                font={font}
                rules={look.fontRules}
                canUpload={canUpload}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function FontRow({
  locale,
  brandId,
  font,
  rules,
  canUpload,
}: {
  locale: string;
  brandId: string;
  font: LookViewData['fonts'][number];
  rules: UploadRules;
  canUpload: boolean;
}) {
  const t = translator(useMessageLocale(locale));
  const [confirming, setConfirming] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const renameId = useId();
  const removeFormId = useId();
  return (
    /* An uploaded font (`fr.ups`, `Main.dc.html` line 876). */
    <li className="bsp-lk-font" data-testid={`look-font-${font.id}`} data-status={font.status}>
      <form action={renameBrandFontAction} className="bsp-lk-font-row">
        <Hidden locale={locale} brandId={brandId} />
        <input type="hidden" name="brandFontId" value={font.id} />
        <label htmlFor={renameId} style={visuallyHiddenStyle()}>
          {t('bb.look.fontName')}
        </label>
        <input
          // Keyed on the stored name: after a rename it re-mounts with it.
          key={font.displayName}
          id={renameId}
          className="bs-control bsp-lk-rename"
          name="displayName"
          dir="auto"
          defaultValue={font.displayName}
          maxLength={80}
          required
          data-testid={`look-font-rename-input-${font.id}`}
        />
        <button
          type="submit"
          className="bsp-btn bsp-sm bsp-ghost"
          data-testid={`look-font-rename-${font.id}`}
        >
          {t('bb.look.fontRename')}
        </button>
        <span
          className={`bsp-pill ${FONT_PILL[font.status]}`}
          data-testid={`look-font-status-${font.id}`}
        >
          {t(`bb.look.status.${font.status}` as MessageKey)}
        </span>
      </form>
      <div className="bsp-lk-font-acts">
        {canUpload ? (
          <UploadForm
            action={replaceBrandFontAction}
            rules={rules}
            locale={locale}
            texts={uploadTexts(t)}
            className="bsp-lk-font-row"
          >
            <Hidden locale={locale} brandId={brandId} />
            <input type="hidden" name="brandFontId" value={font.id} />
            <FileButton
              label={t('bb.look.fontReplace')}
              testId={`look-font-replace-file-${font.id}`}
              ariaLabel={`${t('bb.look.fontReplace')} · ${font.displayName}`}
              onPick={setPicked}
            />
            {picked ? (
              <>
                <span className="bsp-ltr bsp-lk-meta">{picked}</span>
                <button
                  type="submit"
                  className="bsp-btn bsp-sm bsp-pur"
                  data-testid={`look-font-replace-${font.id}`}
                >
                  {t('bb.look.fontReplaceSend')}
                </button>
              </>
            ) : null}
            <UploadStatus testId={`look-font-replace-status-${font.id}`} />
          </UploadForm>
        ) : null}
        <button
          type="button"
          className="bsp-btn bsp-sm bsp-ghost bsp-lk-remove"
          onClick={() => setConfirming(true)}
          data-testid={`look-font-remove-${font.id}`}
        >
          {t('bb.look.fontRemove')}
        </button>
      </div>
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={t('bb.look.fontRemoveTitle')}
        description={t('bb.look.fontRemoveBody').replace('{name}', font.displayName)}
        closeLabel={t('bb.detailClose')}
        testId={`look-font-remove-dialog-${font.id}`}
        footer={
          <>
            <Button variant="neutral" onClick={() => setConfirming(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="brand"
              type="submit"
              form={removeFormId}
              data-testid={`look-font-remove-confirm-${font.id}`}
            >
              {t('bb.look.fontRemove')}
            </Button>
          </>
        }
      >
        <form id={removeFormId} action={removeBrandFontAction}>
          <Hidden locale={locale} brandId={brandId} />
          <input type="hidden" name="brandFontId" value={font.id} />
        </form>
      </Dialog>
    </li>
  );
}
