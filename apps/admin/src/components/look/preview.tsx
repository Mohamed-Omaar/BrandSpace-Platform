'use client';

import { useMemo, useState } from 'react';
import type { ThemeLook } from '@brandspace/shared/theme';
import {
  Cell,
  DataTable,
  FIELD_CLASS,
  Row,
  StateMessage,
  StatusBadge,
  TEXTAREA_CLASS,
  buttonClass,
  themeFontFaces,
  themeStylesheet,
} from '@brandspace/ui';
import type { LookCopy, LookKey } from '../../i18n/look';

/**
 * THE LIVE PREVIEW (LF). The look being edited is written as a stylesheet
 * SCOPED to this box (`.bs-theme-preview`), so the Control Center around it
 * keeps its own look, and the light / dark switch only sets the box's
 * `data-color-scheme`. The screens are the design system's own components in
 * the customer look (`.bsp-frame`), with sample words, never customer data.
 */
const SCOPE = '.bs-theme-preview';

export function LookPreview({ look, copy }: { readonly look: ThemeLook; readonly copy: LookCopy }) {
  const t = (key: LookKey) => copy[key];
  const [scheme, setScheme] = useState<'light' | 'dark'>('light');
  const css = useMemo(
    () => `${themeFontFaces(look)}\n${themeStylesheet(look, { scope: SCOPE, app: 'admin' })}`,
    [look],
  );

  return (
    <div className="lf-preview-wrap">
      <style data-testid="lf-preview-style">{css}</style>
      <div className="lf-presets" role="group" aria-label={t('section.preview')}>
        {(['light', 'dark'] as const).map((s) => (
          <button
            key={s}
            type="button"
            className={buttonClass(scheme === s ? 'brand' : 'neutral', 'sm')}
            aria-pressed={scheme === s}
            onClick={() => setScheme(s)}
            data-testid={`lf-preview-${s}`}
          >
            {t(`preview.${s}` as LookKey)}
          </button>
        ))}
      </div>
      <div
        className="bs-theme-preview bsp-frame lf-preview"
        data-color-scheme={scheme}
        data-testid="lf-preview"
      >
        <section className="lf-pane" aria-label={t('preview.home')}>
          <h3 className="lf-pane-title">{t('preview.home')}</h3>
          <p className="lf-pane-lead">{t('sample.greeting')}</p>
          <div className="lf-tiles">
            <div className="lf-tile">
              <span className="lf-tile-label">{t('sample.posts')}</span>
              <strong className="lf-tile-value">12</strong>
            </div>
            <div className="lf-tile">
              <span className="lf-tile-label">{t('sample.reach')}</span>
              <strong className="lf-tile-value">4,820</strong>
            </div>
          </div>
        </section>

        <section className="lf-pane" aria-label={t('preview.studio')}>
          <h3 className="lf-pane-title">{t('preview.studio')}</h3>
          <label htmlFor="lf-p-caption">{t('sample.caption')}</label>
          <textarea
            id="lf-p-caption"
            className={TEXTAREA_CLASS}
            defaultValue={t('sample.captionText')}
          />
          <div className="lf-row">
            <button type="button" className={buttonClass('brand')}>
              {t('sample.schedule')}
            </button>
            <StatusBadge label={t('sample.ready')} tone="success" />
          </div>
        </section>

        <section className="lf-pane" aria-label={t('preview.form')}>
          <h3 className="lf-pane-title">{t('preview.form')}</h3>
          <label htmlFor="lf-p-name">{t('sample.name')}</label>
          <input id="lf-p-name" className={FIELD_CLASS} defaultValue="Reema" />
          <label htmlFor="lf-p-email">{t('sample.email')}</label>
          <input id="lf-p-email" type="email" className={FIELD_CLASS} data-tone="error" />
          <label htmlFor="lf-p-plan">{t('sample.plan')}</label>
          <select id="lf-p-plan" className={FIELD_CLASS} defaultValue="w">
            <option value="w">{t('sample.choice')}</option>
          </select>
          <label htmlFor="lf-p-date">{t('sample.schedule')}</label>
          <input id="lf-p-date" type="date" className={FIELD_CLASS} />
          <label htmlFor="lf-p-notes">{t('sample.notes')}</label>
          <textarea id="lf-p-notes" className={TEXTAREA_CLASS} />
          <label className="lf-check">
            <input type="checkbox" defaultChecked /> {t('sample.agree')}
          </label>
          <label className="lf-check">
            <input type="radio" name="lf-p-radio" defaultChecked /> {t('sample.choice')}
          </label>
        </section>

        <section className="lf-pane" aria-label={t('preview.buttons')}>
          <h3 className="lf-pane-title">{t('preview.buttons')}</h3>
          <div className="lf-row">
            <button type="button" className={buttonClass('primary')}>
              {t('sample.primary')}
            </button>
            <button type="button" className={buttonClass('brand')}>
              {t('sample.brand')}
            </button>
            <button type="button" className={buttonClass('neutral')}>
              {t('sample.secondary')}
            </button>
            <button type="button" className={buttonClass('ghost')}>
              {t('sample.ghost')}
            </button>
            <button type="button" className={buttonClass('danger')}>
              {t('sample.danger')}
            </button>
            <button type="button" className={buttonClass('brand')} disabled>
              {t('sample.disabled')}
            </button>
          </div>
          <div className="lf-row">
            <button type="button" className={buttonClass('brand', 'sm')}>
              {t('size.small')}
            </button>
            <button type="button" className={buttonClass('brand', 'lg')}>
              {t('size.large')}
            </button>
          </div>
        </section>

        <section className="lf-pane" aria-label={t('preview.table')}>
          <h3 className="lf-pane-title">{t('preview.table')}</h3>
          <DataTable headers={[t('sample.name'), t('sample.status')]} minWidth="var(--bsp-rem-16)">
            <Row>
              <Cell>{t('sample.captionText')}</Cell>
              <Cell>
                <StatusBadge label={t('sample.ready')} tone="success" />
              </Cell>
            </Row>
            <Row selected>
              <Cell>{t('sample.greeting')}</Cell>
              <Cell>
                <StatusBadge label={t('sample.waiting')} tone="warning" />
              </Cell>
            </Row>
          </DataTable>
        </section>

        <section className="lf-pane" aria-label={t('preview.empty')}>
          <h3 className="lf-pane-title">{t('preview.empty')}</h3>
          <StateMessage title={t('sample.emptyTitle')} description={t('sample.emptyText')} />
        </section>

        <section className="lf-pane bsp-auth lf-signin" aria-label={t('preview.signin')}>
          <h3 className="lf-pane-title">{t('sample.signinTitle')}</h3>
          <label htmlFor="lf-p-in-email">{t('sample.email')}</label>
          <input id="lf-p-in-email" type="email" className={FIELD_CLASS} />
          <label htmlFor="lf-p-in-pass">{t('sample.password')}</label>
          <input id="lf-p-in-pass" type="password" className={FIELD_CLASS} />
          <button type="button" className={buttonClass('primary')}>
            {t('sample.continue')}
          </button>
        </section>
      </div>
    </div>
  );
}
