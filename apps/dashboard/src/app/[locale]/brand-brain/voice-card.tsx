'use client';

import Link from 'next/link';
import {
  CONTROL_CLASS,
  buttonClass,
  buttonStyle,
  colorTokens,
  typographyTokens,
} from '@brandspace/ui';
import { translator } from '../../../i18n/messages';
import type { AreaItemData, VoiceData } from './brand-brain-view';
import { archiveKnowledgeAction, createKnowledgeAction, updateKnowledgeAction } from './actions';

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
 * Logo, colours and fonts join this tab in Phase 2C-2; until then the brand
 * profile holds them (`brand.manage`, the E3 deviation).
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
  const t = translator(locale);
  return (
    <div className="bb-source" data-testid="voice-card" style={{ display: 'grid', gap: 16 }}>
      <div className="bb-source-head">
        <h4>{t('bb.voice.title')}</h4>
      </div>

      <section data-testid="voice-words" style={sectionStyle}>
        <h5 style={headingStyle}>{t('bb.voice.words')}</h5>
        <p style={bodyStyle} data-testid="voice-words-value">
          {voice.words ? voice.words.body || voice.words.title : t('bb.voice.wordsEmpty')}
        </p>
        {canEdit ? (
          <form
            action={voice.words ? updateKnowledgeAction : createKnowledgeAction}
            style={formStyle}
            data-testid="voice-words-form"
          >
            <Hidden locale={locale} brandId={brandId} area="TONE_OF_VOICE" />
            {voice.words ? (
              <input type="hidden" name="itemId" value={voice.words.id} />
            ) : (
              <input type="hidden" name="itemKey" value="voice.words" />
            )}
            {/* The fact's own title, in both catalogues' words — never typed here. */}
            <input type="hidden" name="titleEn" value={translator('en')('bb.voice.words')} />
            <input type="hidden" name="titleAr" value={translator('ar')('bb.voice.words')} />
            <input
              className={CONTROL_CLASS}
              name="bodyEn"
              dir="ltr"
              defaultValue={voice.words?.edit.bodyEn ?? ''}
              placeholder={t('bb.voice.wordsPlaceholderEn')}
              aria-label={t('bb.newItem.bodyEn')}
              data-testid="voice-words-en"
              style={inputStyle}
            />
            <input
              className={CONTROL_CLASS}
              name="bodyAr"
              dir="rtl"
              defaultValue={voice.words?.edit.bodyAr ?? ''}
              placeholder={t('bb.voice.wordsPlaceholderAr')}
              aria-label={t('bb.newItem.bodyAr')}
              data-testid="voice-words-ar"
              style={inputStyle}
            />
            <button
              type="submit"
              className={buttonClass('neutral')}
              style={{ ...buttonStyle('neutral', 'sm'), justifySelf: 'start' }}
              data-testid="voice-words-save"
            >
              {t('common.save')}
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

      <p style={{ ...bodyStyle, color: colorTokens.textMuted }} data-testid="voice-look-note">
        {t('bb.voice.lookNote')}{' '}
        {profileHref ? (
          <Link href={profileHref} data-testid="voice-open-profile">
            {t('bb.openProfile')}
          </Link>
        ) : null}
      </p>
    </div>
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
  const t = translator(locale);
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
                    className={buttonClass('ghost')}
                    style={buttonStyle('ghost', 'sm')}
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
        <form action={createKnowledgeAction} style={formStyle} data-testid={`${testId}-add`}>
          <Hidden locale={locale} brandId={brandId} area={area} />
          <input type="hidden" name="itemKeyPrefix" value={prefix} />
          <input type="hidden" name="titleFromBody" value="1" />
          <input
            className={CONTROL_CLASS}
            name="bodyEn"
            dir="ltr"
            placeholder={t('bb.newItem.bodyEn')}
            aria-label={`${addLabel} — ${t('bb.newItem.bodyEn')}`}
            data-testid={`${testId}-add-en`}
            style={inputStyle}
          />
          <input
            className={CONTROL_CLASS}
            name="bodyAr"
            dir="rtl"
            placeholder={t('bb.newItem.bodyAr')}
            aria-label={`${addLabel} — ${t('bb.newItem.bodyAr')}`}
            data-testid={`${testId}-add-ar`}
            style={inputStyle}
          />
          <button
            type="submit"
            className={buttonClass('neutral')}
            style={{ ...buttonStyle('neutral', 'sm'), justifySelf: 'start' }}
            data-testid={`${testId}-add-submit`}
          >
            {addLabel}
          </button>
        </form>
      ) : null}
    </section>
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

const sectionStyle: React.CSSProperties = { display: 'grid', gap: 8 };
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
const formStyle: React.CSSProperties = { display: 'grid', gap: 8 };
const inputStyle: React.CSSProperties = {
  padding: '8px 10px',
  borderRadius: 10,
  border: '1px solid rgba(17,17,20,.14)',
  font: 'inherit',
  fontSize: typographyTokens.bodySm.fontSize,
  minWidth: 0,
};
