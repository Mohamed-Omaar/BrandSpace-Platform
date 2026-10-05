'use client';

import { useId, useState } from 'react';
import {
  Button,
  CONTROL_CLASS,
  Dialog,
  buttonClass,
  buttonStyle,
  colorTokens,
  typographyTokens,
  visuallyHiddenStyle,
} from '@brandspace/ui';
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

/**
 * PHASE 2C-2 (item 3) — LOOK & VOICE: COLOURS, LOGO AND FONTS.
 *
 * An APPROVED DESIGN-SYSTEM EXTENSION (UI-FIDELITY-CONTRACT §6.3.47): the
 * route's own `.bb-source` card, the drawer's controls, native inputs for every
 * value (a colour input beside its hex text, native selects for the font
 * slots, native file inputs), the shared `Dialog` to confirm a removal. No new
 * colour family, font for the interface, shadow or interaction model; nothing
 * here animates.
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
  readonly acceptFonts: string;
  readonly acceptImages: string;
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

function previewStyle(cssFamily: string, language: Language, role: Role): React.CSSProperties {
  return {
    margin: 0,
    fontFamily: `'${cssFamily}', ${fallbackStack[language]}`,
    fontWeight: role === 'heading' ? 700 : 400,
    fontSynthesis: 'none',
    fontSize: role === 'heading' ? typographyTokens.h3.fontSize : typographyTokens.bodySm.fontSize,
    lineHeight: 1.4,
  };
}

export function LookCard({
  locale,
  brandId,
  look,
  canManage,
  canUpload,
  children,
}: {
  locale: string;
  brandId: string;
  look: LookViewData;
  canManage: boolean;
  canUpload: boolean;
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
        accept={look.acceptImages}
        canManage={canManage}
        canUpload={canManage && canUpload}
      />
      <Colours locale={locale} brandId={brandId} palette={look.palette} canManage={canManage} />
      {children}
      <Slots locale={locale} brandId={brandId} look={look} canManage={canManage} />
      <FontManager
        locale={locale}
        brandId={brandId}
        look={look}
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
          <p style={mutedStyle}>{t('bb.look.coloursEmpty')}</p>
        ) : (
          <ul style={swatchListStyle}>
            {palette.map((colour) => (
              <li key={colour} style={swatchItemStyle} data-testid={`look-swatch-${colour}`}>
                <span aria-hidden="true" style={{ ...swatchStyle, background: colour }} />
                <span style={bodyStyle}>{colour}</span>
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
      <form action={saveBrandColoursAction} style={formStyle} data-testid="look-colours-form">
        <Hidden locale={locale} brandId={brandId} />
        {colours.length === 0 ? <p style={mutedStyle}>{t('bb.look.coloursEmpty')}</p> : null}
        <ul style={{ ...swatchListStyle, flexDirection: 'column', alignItems: 'stretch' }}>
          {colours.map((colour, index) => {
            const number = String(index + 1);
            return (
              <li key={index} style={swatchItemStyle} data-testid={`look-colour-${index}`}>
                <input
                  type="color"
                  value={sixDigit(colour)}
                  onChange={(event) => set(index, event.target.value.toUpperCase())}
                  aria-label={t('bb.look.colourPicker').replace('{n}', number)}
                  data-testid={`look-colour-picker-${index}`}
                  style={{ inlineSize: 40, blockSize: 32, padding: 0, border: 0 }}
                />
                <input
                  className={CONTROL_CLASS}
                  name="colorPalette"
                  value={colour}
                  onChange={(event) => set(index, event.target.value.trim())}
                  aria-label={t('bb.look.colourHex').replace('{n}', number)}
                  dir="ltr"
                  maxLength={7}
                  data-testid={`look-colour-hex-${index}`}
                  style={{ ...inputStyle, maxInlineSize: 120 }}
                />
                <button
                  type="button"
                  className={buttonClass('ghost')}
                  style={buttonStyle('ghost', 'sm')}
                  onClick={() => setColours((current) => current.filter((_, i) => i !== index))}
                  aria-label={t('bb.look.colourRemove').replace('{n}', number)}
                  data-testid={`look-colour-remove-${index}`}
                >
                  {t('bb.archive')}
                </button>
              </li>
            );
          })}
        </ul>
        <div style={rowStyle}>
          <button
            type="button"
            className={buttonClass('neutral')}
            style={buttonStyle('neutral', 'sm')}
            disabled={colours.length >= MAX_COLOURS}
            onClick={() => setColours((current) => [...current, colorTokens.brandPurple])}
            data-testid="look-colour-add"
          >
            {t('bb.look.colourAdd')}
          </button>
          <button
            type="submit"
            className={buttonClass('brand')}
            style={buttonStyle('brand', 'sm')}
            data-testid="look-colours-save"
          >
            {t('common.save')}
          </button>
        </div>
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
  accept,
  canManage,
  canUpload,
}: {
  locale: string;
  brandId: string;
  logo: LookViewData['logo'];
  options: LookViewData['logoOptions'];
  accept: string;
  canManage: boolean;
  canUpload: boolean;
}) {
  const t = translator(useMessageLocale(locale));
  const headingId = useId();
  const fileId = useId();
  const pickId = useId();
  return (
    <section aria-labelledby={headingId} data-testid="look-logo" className="bsp-card bsp-bb-lc">
      <h5 id={headingId} className="bsp-lbl bsp-bb-lc-t">
        {t('bb.look.logo')}
      </h5>
      {logo?.url ? (
        <img
          src={logo.url}
          alt={t('bb.look.logoAlt')}
          data-testid="look-logo-image"
          style={{ maxInlineSize: 160, maxBlockSize: 80, objectFit: 'contain' }}
        />
      ) : (
        <p style={mutedStyle} data-testid="look-logo-empty">
          {t('bb.look.logoEmpty')}
        </p>
      )}
      {canManage && options.length > 0 ? (
        <form action={chooseBrandLogoAction} style={formStyle} data-testid="look-logo-choose">
          <Hidden locale={locale} brandId={brandId} />
          <label htmlFor={pickId} style={labelStyle}>
            {t('bb.look.logoChoose')}
          </label>
          <select
            id={pickId}
            name="primaryLogoAssetId"
            className={CONTROL_CLASS}
            defaultValue={logo?.assetId ?? ''}
            data-testid="look-logo-select"
            style={inputStyle}
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
            className={buttonClass('neutral')}
            style={{ ...buttonStyle('neutral', 'sm'), justifySelf: 'start' }}
            data-testid="look-logo-choose-save"
          >
            {t('common.save')}
          </button>
        </form>
      ) : null}
      {canUpload ? (
        <form action={uploadBrandLogoAction} style={formStyle} data-testid="look-logo-form">
          <Hidden locale={locale} brandId={brandId} />
          <label htmlFor={fileId} style={labelStyle}>
            {t('bb.look.logoUpload')}
          </label>
          <input
            id={fileId}
            type="file"
            name="file"
            accept={accept}
            required
            data-testid="look-logo-file"
          />
          <button
            type="submit"
            className={buttonClass('neutral')}
            style={{ ...buttonStyle('neutral', 'sm'), justifySelf: 'start' }}
            data-testid="look-logo-submit"
          >
            {t('bb.look.logoReplace')}
          </button>
        </form>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ slots */

function Slots({
  locale,
  brandId,
  look,
  canManage,
}: {
  locale: string;
  brandId: string;
  look: LookViewData;
  canManage: boolean;
}) {
  const t = translator(useMessageLocale(locale));
  const headingId = useId();
  const [chosen, setChosen] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      LANGUAGES.flatMap((language) =>
        ROLES.map((role) => [`${language}-${role}`, look.slots[language][role].value]),
      ),
    ),
  );

  const body = LANGUAGES.map((language) =>
    ROLES.map((role) => {
      const key = `${language}-${role}`;
      const slot = look.slots[language][role];
      const option = look.options[language].find((entry) => entry.value === chosen[key]);
      // Unchanged: draw what the reader actually gets (the fallback, if any).
      const unchanged = chosen[key] === slot.value;
      const cssFamily = unchanged ? slot.cssFamily : (option?.cssFamily ?? slot.cssFamily);
      const selectId = `${headingId}-${key}`;
      return (
        <div key={key} style={{ display: 'grid', gap: 6 }} data-testid={`look-slot-${key}`}>
          <label htmlFor={selectId} style={labelStyle}>
            {t(`bb.look.slot.${language}.${role}` as MessageKey)}
          </label>
          {canManage ? (
            <select
              id={selectId}
              name={`font-${language}-${role}`}
              className={CONTROL_CLASS}
              value={chosen[key]}
              onChange={(event) =>
                setChosen((current) => ({ ...current, [key]: event.target.value }))
              }
              data-testid={`look-slot-select-${key}`}
              style={inputStyle}
            >
              {look.options[language].map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.uploaded
                    ? t('bb.look.uploadedOption').replace('{name}', entry.label)
                    : entry.label}
                </option>
              ))}
            </select>
          ) : (
            <p style={bodyStyle} id={selectId}>
              {slot.name}
            </p>
          )}
          <p
            dir={language === 'ar' ? 'rtl' : 'ltr'}
            lang={language}
            style={previewStyle(cssFamily, language, role)}
            data-testid={`look-slot-preview-${key}`}
            data-font-family={cssFamily}
          >
            {translator(language)(`bb.look.sample.${role}` as MessageKey)}
          </p>
          {unchanged && slot.fellBack ? (
            <p style={mutedStyle} data-testid={`look-slot-fallback-${key}`}>
              {t('bb.look.fallbackNote').replace('{font}', slot.name)}
            </p>
          ) : null}
        </div>
      );
    }),
  ).flat();

  return (
    <section
      aria-labelledby={headingId}
      data-testid="look-fonts"
      className="bsp-card bsp-bb-lc bsp-bb-lc-full"
    >
      <h5 id={headingId} className="bsp-lbl bsp-bb-lc-t">
        {t('bb.look.fonts')}
      </h5>
      <p style={mutedStyle}>{t('bb.look.fontsHint')}</p>
      {canManage ? (
        <form action={saveBrandTypographyAction} style={formStyle} data-testid="look-fonts-form">
          <Hidden locale={locale} brandId={brandId} />
          <div style={slotGridStyle}>{body}</div>
          <button
            type="submit"
            className={buttonClass('brand')}
            style={{ ...buttonStyle('brand', 'sm'), justifySelf: 'start' }}
            data-testid="look-fonts-save"
          >
            {t('common.save')}
          </button>
        </form>
      ) : (
        <div style={slotGridStyle}>{body}</div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ uploaded fonts */

function FontManager({
  locale,
  brandId,
  look,
  canManage,
  canUpload,
}: {
  locale: string;
  brandId: string;
  look: LookViewData;
  canManage: boolean;
  canUpload: boolean;
}) {
  const t = translator(useMessageLocale(locale));
  const headingId = useId();
  if (!canManage) return null;
  return (
    <section
      aria-labelledby={headingId}
      data-testid="look-uploaded"
      className="bsp-card bsp-bb-lc bsp-bb-lc-full"
    >
      <h5 id={headingId} className="bsp-lbl bsp-bb-lc-t">
        {t('bb.look.uploaded')}
      </h5>
      <p style={mutedStyle}>
        {t('bb.look.uploadedHint').replace('{max}', String(look.maxPerLanguage))}
      </p>
      {LANGUAGES.map((language) => (
        <LanguageFonts
          key={language}
          locale={locale}
          brandId={brandId}
          language={language}
          look={look}
          canUpload={canUpload}
        />
      ))}
    </section>
  );
}

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
  const fileId = useId();
  const nameId = useId();
  const fonts = look.fonts.filter((font) => font.language === language);
  const full = fonts.length >= look.maxPerLanguage;
  return (
    <div style={{ display: 'grid', gap: 8 }} data-testid={`look-uploaded-${language}`}>
      <h6 style={{ ...headingStyle, fontSize: typographyTokens.bodySm.fontSize }}>
        {t(`bb.look.language.${language}` as MessageKey)}
      </h6>
      {fonts.length === 0 ? (
        <p style={mutedStyle} data-testid={`look-uploaded-empty-${language}`}>
          {t('bb.look.uploadedEmpty')}
        </p>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 10 }}>
          {fonts.map((font) => (
            <FontRow
              key={font.id}
              locale={locale}
              brandId={brandId}
              font={font}
              accept={look.acceptFonts}
              canUpload={canUpload}
            />
          ))}
        </ul>
      )}
      {canUpload ? (
        full ? (
          <p style={mutedStyle} data-testid={`look-uploaded-full-${language}`}>
            {t('bb.look.uploadedFull').replace('{max}', String(look.maxPerLanguage))}
          </p>
        ) : (
          <form
            action={addBrandFontAction}
            style={formStyle}
            data-testid={`look-font-add-${language}`}
          >
            <Hidden locale={locale} brandId={brandId} />
            <input type="hidden" name="language" value={language} />
            <label htmlFor={fileId} style={labelStyle}>
              {t('bb.look.fontFile')}
            </label>
            <input
              id={fileId}
              type="file"
              name="file"
              accept={look.acceptFonts}
              required
              data-testid={`look-font-file-${language}`}
            />
            <label htmlFor={nameId} style={labelStyle}>
              {t('bb.look.fontName')}
            </label>
            <input
              id={nameId}
              className={CONTROL_CLASS}
              name="displayName"
              maxLength={80}
              data-testid={`look-font-name-${language}`}
              style={inputStyle}
            />
            <button
              type="submit"
              className={buttonClass('neutral')}
              style={{ ...buttonStyle('neutral', 'sm'), justifySelf: 'start' }}
              data-testid={`look-font-add-submit-${language}`}
            >
              {t('bb.look.fontAdd')}
            </button>
          </form>
        )
      ) : null}
    </div>
  );
}

function FontRow({
  locale,
  brandId,
  font,
  accept,
  canUpload,
}: {
  locale: string;
  brandId: string;
  font: LookViewData['fonts'][number];
  accept: string;
  canUpload: boolean;
}) {
  const t = translator(useMessageLocale(locale));
  const [confirming, setConfirming] = useState(false);
  const renameId = useId();
  const replaceId = useId();
  const removeFormId = useId();
  return (
    <li
      data-testid={`look-font-${font.id}`}
      data-status={font.status}
      style={{
        display: 'grid',
        gap: 8,
        padding: 12,
        borderRadius: 14,
        background: colorTokens.surfaceSoft,
      }}
    >
      <div style={{ ...rowStyle, justifyContent: 'space-between' }}>
        <b style={bodyStyle}>{font.displayName}</b>
        <span className="bb-badge" data-testid={`look-font-status-${font.id}`}>
          {t(`bb.look.status.${font.status}` as MessageKey)}
        </span>
      </div>
      <form action={renameBrandFontAction} style={rowStyle}>
        <Hidden locale={locale} brandId={brandId} />
        <input type="hidden" name="brandFontId" value={font.id} />
        <label htmlFor={renameId} style={visuallyHiddenStyle()}>
          {t('bb.look.fontName')}
        </label>
        <input
          id={renameId}
          className={CONTROL_CLASS}
          name="displayName"
          defaultValue={font.displayName}
          maxLength={80}
          required
          data-testid={`look-font-rename-input-${font.id}`}
          style={{ ...inputStyle, flex: '1 1 10rem' }}
        />
        <button
          type="submit"
          className={buttonClass('ghost')}
          style={buttonStyle('ghost', 'sm')}
          data-testid={`look-font-rename-${font.id}`}
        >
          {t('bb.look.fontRename')}
        </button>
      </form>
      {canUpload ? (
        <form action={replaceBrandFontAction} style={rowStyle}>
          <Hidden locale={locale} brandId={brandId} />
          <input type="hidden" name="brandFontId" value={font.id} />
          <label htmlFor={replaceId} style={labelStyle}>
            {t('bb.look.fontReplaceFile')}
          </label>
          <input
            id={replaceId}
            type="file"
            name="file"
            accept={accept}
            required
            data-testid={`look-font-replace-file-${font.id}`}
          />
          <button
            type="submit"
            className={buttonClass('ghost')}
            style={buttonStyle('ghost', 'sm')}
            data-testid={`look-font-replace-${font.id}`}
          >
            {t('bb.look.fontReplace')}
          </button>
        </form>
      ) : null}
      <div>
        <button
          type="button"
          className={buttonClass('ghost')}
          style={buttonStyle('ghost', 'sm')}
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

/* ------------------------------------------------------------------ styles */

const headingStyle: React.CSSProperties = {
  margin: 0,
  fontSize: typographyTokens.label.fontSize,
  fontWeight: 800,
};
const labelStyle: React.CSSProperties = {
  fontSize: typographyTokens.caption.fontSize,
  fontWeight: 800,
  color: colorTokens.textSecondary,
};
const bodyStyle: React.CSSProperties = {
  margin: 0,
  fontSize: typographyTokens.bodySm.fontSize,
  lineHeight: 1.6,
};
const mutedStyle: React.CSSProperties = { ...bodyStyle, color: colorTokens.textMuted };
const formStyle: React.CSSProperties = { display: 'grid', gap: 8 };
const rowStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 8,
};
const slotGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 14rem), 1fr))',
  gap: 14,
};
const inputStyle: React.CSSProperties = {
  padding: '8px 10px',
  borderRadius: 10,
  border: '1px solid rgba(17,17,20,.14)',
  font: 'inherit',
  fontSize: typographyTokens.bodySm.fontSize,
  minWidth: 0,
};
const swatchListStyle: React.CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: 'none',
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
};
const swatchItemStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 };
const swatchStyle: React.CSSProperties = {
  inlineSize: 24,
  blockSize: 24,
  borderRadius: 8,
  border: '1px solid rgba(17,17,20,.14)',
};
