'use client';

import { useId } from 'react';
import Link from 'next/link';
import { CONTROL_CLASS, buttonClass, colorTokens, typographyTokens } from '@brandspace/ui';
import { translator } from '../../../i18n/messages';
import type { AreaItemData, VoiceData } from './brand-brain-view';
import { archiveKnowledgeAction, createKnowledgeAction, updateKnowledgeAction } from './actions';
import { useMessageLocale } from '../../../i18n/message-locale-context';

/**
 * C4 + D1 (Phase 2C) — THE ONE VOICE CARD on the Look & voice tab.
 *
 * ONE SOURCE OF TRUTH FOR VOICE (decision 2.b): the TONE_OF_VOICE area. Voice
 * words are the fact `voice.words`; the other TONE_OF_VOICE facts are tone
 * facts; Do and Don't rules are DO_DONT facts keyed `do.*` and `dont.*`. An
 * older DO_DONT fact with neither prefix is shown on an "unsorted" line so a
 * person can re-file it. `Brand.voiceProfile` is not read and not written.
 *
 * Every change is an ordinary Brand Brain write — `brand_brain.edit`, a new
 * version, an audit event — through the same actions the area drawer uses. The
 * card is the route's own `.bb-source` card (white, 26 px radius, the soft
 * shadow) with the drawer's controls: an approved design-system extension, no
 * new visual language (UI-FIDELITY-CONTRACT §6.3.46).
 *
 * Colours, logo and fonts sit above it on the same tab (Phase 2C-2, the Look
 * card, `brand.manage` — the E3 deviation).
 */
export function VoiceCard({
  locale,
  brandId,
  voice,
  canEdit,
  profileHref,
}: {
  locale: string;
  brandId: string;
  voice: VoiceData;
  canEdit: boolean;
  profileHref: string | null;
}) {
  const messageLocale = useMessageLocale(locale);
  const t = translator(messageLocale);
  // The reader's language: its list of words is the one shown and changed here.
  const language: 'en' | 'ar' = messageLocale === 'ar' ? 'ar' : 'en';
  const own = voice.words
    ? language === 'ar'
      ? voice.words.edit.bodyAr
      : voice.words.edit.bodyEn
    : '';
  const words = wordsIn(own || (voice.words ? voice.words.body || voice.words.title : ''));
  const saveWords = (data: FormData, next: readonly string[]) => {
    const text = [...new Set(next)].join(language === 'ar' ? '، ' : ', ');
    const form = new FormData();
    for (const [key, value] of [
      ['locale', locale],
      ['brandId', brandId],
      ['area', 'TONE_OF_VOICE'],
      ['tab', 'look'],
      ['titleEn', translator('en')('bb.voice.words')],
      ['titleAr', translator('ar')('bb.voice.words')],
      ['bodyEn', language === 'en' ? text : (voice.words?.edit.bodyEn ?? '')],
      ['bodyAr', language === 'ar' ? text : (voice.words?.edit.bodyAr ?? '')],
    ] as const) {
      form.set(key, value);
    }
    if (voice.words) form.set('itemId', voice.words.id);
    else form.set('itemKey', 'voice.words');
    void data;
    return voice.words ? updateKnowledgeAction(form) : createKnowledgeAction(form);
  };
  return (
    <section className="bsp-card bsp-bb-lc bsp-bb-lc-full" data-testid="voice-card">
      {/* The prototype's Voice card (line 874): the label, what it is for, three columns. */}
      <span className="bsp-bb-lc-h">
        <span className="bsp-lbl">{t('bb.voice.title')}</span>
        <span>{t('bb.voice.sub')}</span>
      </span>
      <div className="bsp-bb-voice-grid">
        <section data-testid="voice-words" style={sectionStyle}>
          <h5 style={headingStyle}>{t('bb.voice.words')}</h5>
          {/*
            Round 5 (F3) — THE PROTOTYPE'S WORD CHIPS (`x.voiceChips`, line
            874): one chip per word, each with its own "×", and one "Add a
            word" field with Add. The words are still the one `voice.words`
            fact, in the reader's language; each press is an ordinary Brand
            Brain update (`brand_brain.edit`, a new version, audited) that
            writes that language's list and leaves the other as it was.
          */}
          {words.length > 0 ? (
            <div className="bsp-lk-chips" data-testid="voice-words-value">
              {words.map((word, index) => (
                <span key={`${word}-${index}`} className="bsp-chip bsp-vc-word" dir="auto">
                  {word}
                  {canEdit ? (
                    <form
                      action={(data) =>
                        saveWords(
                          data,
                          words.filter((_, i) => i !== index),
                        )
                      }
                    >
                      <button
                        type="submit"
                        className="bsp-vc-word-x"
                        aria-label={`${t('bb.voice.wordRemove')} ${word}`}
                        data-testid={`voice-words-remove-${index}`}
                      />
                    </form>
                  ) : null}
                </span>
              ))}
            </div>
          ) : (
            <p style={bodyStyle} data-testid="voice-words-value">
              {t('bb.voice.wordsEmpty')}
            </p>
          )}
          {canEdit ? (
            <form
              action={(data) =>
                saveWords(data, [...words, ...wordsIn(String(data.get('word') ?? ''))])
              }
              className="bsp-vc-row"
              data-testid="voice-words-form"
            >
              <input
                name="word"
                dir="auto"
                className={`${CONTROL_CLASS} bsp-vc-field`}
                placeholder={t('bb.voice.wordAdd')}
                aria-label={t('bb.voice.wordAdd')}
                data-testid={`voice-words-${language}`}
                required
              />
              <button
                type="submit"
                className="bsp-btn bsp-sm bsp-sec"
                data-testid="voice-words-save"
              >
                {t('studio.tagAdd')}
              </button>
            </form>
          ) : null}
        </section>

        <RuleList
          testId="voice-tone"
          title={t('bb.voice.tone')}
          empty={t('bb.voice.toneEmpty')}
          items={voice.tone}
          area="TONE_OF_VOICE"
          prefix="tone."
          addLabel={t('bb.voice.addTone')}
          locale={locale}
          brandId={brandId}
          canEdit={canEdit}
        />
        <div className="bsp-bb-voice-col">
          <RuleList
            testId="voice-do"
            title={t('bb.voice.do')}
            empty={t('bb.voice.doEmpty')}
            items={voice.dos}
            area="DO_DONT"
            prefix="do."
            addLabel={t('bb.voice.addDo')}
            locale={locale}
            brandId={brandId}
            canEdit={canEdit}
          />
          <RuleList
            testId="voice-dont"
            title={t('bb.voice.dont')}
            empty={t('bb.voice.dontEmpty')}
            items={voice.donts}
            area="DO_DONT"
            prefix="dont."
            addLabel={t('bb.voice.addDont')}
            locale={locale}
            brandId={brandId}
            canEdit={canEdit}
          />
        </div>
        {voice.unsorted.length > 0 ? (
          <RuleList
            testId="voice-unsorted"
            title={t('bb.voice.unsorted')}
            empty=""
            items={voice.unsorted}
            area="DO_DONT"
            prefix={null}
            addLabel=""
            locale={locale}
            brandId={brandId}
            canEdit={canEdit}
            note={t('bb.voice.unsortedNote')}
          />
        ) : null}
      </div>

      <p style={{ ...bodyStyle, color: colorTokens.textMuted }} data-testid="voice-look-note">
        {t('bb.voice.lookNote')}{' '}
        {profileHref ? (
          <Link href={profileHref} data-testid="voice-open-profile">
            {t('bb.openProfile')}
          </Link>
        ) : null}
      </p>
    </section>
  );
}

function RuleList({
  testId,
  title,
  empty,
  items,
  area,
  prefix,
  addLabel,
  locale,
  brandId,
  canEdit,
  note,
}: {
  testId: string;
  title: string;
  empty: string;
  items: readonly AreaItemData[];
  area: string;
  /** `tone.`, `do.` or `dont.` — the key prefix a new rule is filed under; null adds nothing. */
  prefix: 'tone.' | 'do.' | 'dont.' | null;
  addLabel: string;
  locale: string;
  brandId: string;
  canEdit: boolean;
  note?: string;
}) {
  const t = translator(useMessageLocale(locale));
  return (
    <section data-testid={testId} style={sectionStyle}>
      <h5 style={headingStyle}>{title}</h5>
      {note ? <p style={{ ...bodyStyle, color: colorTokens.textMuted }}>{note}</p> : null}
      {items.length === 0 ? (
        <p style={{ ...bodyStyle, color: colorTokens.textMuted }}>{empty}</p>
      ) : (
        <ul style={{ margin: 0, paddingInlineStart: 18, display: 'grid', gap: 6 }}>
          {items.map((item) => (
            <li key={item.id} data-testid={`voice-rule-${item.id}`} style={bodyStyle}>
              <span style={item.expired ? { color: colorTokens.textMuted } : undefined}>
                {item.body || item.title}
              </span>
              {item.expired ? (
                <small style={{ color: colorTokens.textMuted }}> · {t('bb.expired')}</small>
              ) : null}
              {canEdit ? (
                <form action={archiveKnowledgeAction} style={{ display: 'inline' }}>
                  <Hidden locale={locale} brandId={brandId} area={area} />
                  <input type="hidden" name="itemId" value={item.id} />{' '}
                  <button
                    type="submit"
                    className={buttonClass('ghost', 'sm')}

                    data-testid={`voice-remove-${item.id}`}
                    aria-label={`${t('bb.archive')}: ${item.body || item.title}`}
                  >
                    {t('bb.archive')}
                  </button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canEdit && prefix ? (
        <form
          action={createKnowledgeAction}
          className="bsp-vc-form"
          style={formStyle}
          data-testid={`${testId}-add`}
        >
          <Hidden locale={locale} brandId={brandId} area={area} />
          <input type="hidden" name="itemKeyPrefix" value={prefix} />
          <input type="hidden" name="titleFromBody" value="1" />
          <OneFieldRow
            locale={locale}
            testId={testId}
            values={{ en: '', ar: '' }}
            placeholders={{ en: t('bb.newItem.bodyEn'), ar: t('bb.newItem.bodyAr') }}
            labels={{
              en: `${addLabel} — ${t('bb.newItem.bodyEn')}`,
              ar: `${addLabel} — ${t('bb.newItem.bodyAr')}`,
            }}
            submit={addLabel}
            submitTestId={`${testId}-add-submit`}
            inputTestId={(language) => `${testId}-add-${language}`}
          />
        </form>
      ) : null}
    </section>
  );
}

/**
 * Gate 2b review (4a) — ONE FIELD PER COLUMN, as the prototype's Voice card
 * draws it (`Main.dc.html` line 874: a field and its "Add" in one row). The
 * field is in the reader's language; the other language's field is behind the
 * row's own chip, which shows it under the row. Both are posted either way, so
 * saving in one language never clears the other; an empty one is left out.
 */
function OneFieldRow({
  locale,
  testId,
  values,
  placeholders,
  labels,
  submit,
  submitTestId,
  inputTestId,
}: {
  locale: string;
  testId: string;
  values: { en: string; ar: string };
  placeholders: { en: string; ar: string };
  labels: { en: string; ar: string };
  submit: string;
  submitTestId: string;
  inputTestId: (language: 'en' | 'ar') => string;
}) {
  const t = translator(useMessageLocale(locale));
  const first: 'en' | 'ar' = locale === 'ar' ? 'ar' : 'en';
  const second: 'en' | 'ar' = first === 'ar' ? 'en' : 'ar';
  const otherId = useId();
  const field = (language: 'en' | 'ar', className: string) => (
    <input
      className={`${CONTROL_CLASS} ${className}`}
      name={language === 'en' ? 'bodyEn' : 'bodyAr'}
      dir={language === 'ar' ? 'rtl' : 'ltr'}
      defaultValue={values[language]}
      placeholder={placeholders[language]}
      aria-label={labels[language]}
      data-testid={inputTestId(language)}
      {...(className === 'bsp-vc-other' ? { id: otherId } : {})}
    />
  );
  return (
    <>
      <div className="bsp-vc-row">
        {field(first, 'bsp-vc-field')}
        <button type="submit" className={buttonClass('neutral', 'sm')} data-testid={submitTestId}>
          {submit}
        </button>
        <label className="bsp-chip bsp-vc-lang" data-testid={`${testId}-other-language`}>
          <input type="checkbox" className="bsp-vc-toggle" aria-controls={otherId} />
          {second === 'ar' ? t('brandProfile.localeAr') : t('brandProfile.localeEn')}
        </label>
      </div>
      {field(second, 'bsp-vc-other')}
    </>
  );
}

function Hidden({ locale, brandId, area }: { locale: string; brandId: string; area: string }) {
  return (
    <>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="brandId" value={brandId} />
      <input type="hidden" name="area" value={area} />
      <input type="hidden" name="tab" value="look" />
    </>
  );
}

/** The words of a `voice.words` text, split where a person separates them. */
function wordsIn(text: string): string[] {
  return text
    .split(/[,،]/)
    .map((word) => word.trim())
    .filter((word) => word !== '');
}

const sectionStyle: React.CSSProperties = { display: 'grid', gap: 8, alignContent: 'start' };
const headingStyle: React.CSSProperties = {
  margin: 0,
  fontSize: typographyTokens.label.fontSize,
  fontWeight: 800,
};
const bodyStyle: React.CSSProperties = {
  margin: 0,
  fontSize: typographyTokens.bodySm.fontSize,
  lineHeight: 1.6,
};
const formStyle: React.CSSProperties = { display: 'grid', gap: 8, alignContent: 'start' };
