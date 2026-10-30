'use client';

import { useMemo, useState, type ReactNode } from 'react';
import {
  ORIGINAL_ROLES,
  THEME_FONTS,
  THEME_PRESET_KEYS,
  contrastIssues,
  presetLook,
  themeLookSchema,
  type ThemeDocument,
  type ThemeLook,
} from '@brandspace/shared/theme';
import { Banner, Card, FIELD_CLASS, TEXTAREA_CLASS, buttonClass } from '@brandspace/ui';
import type { LookCopy, LookKey } from '../../i18n/look';
import {
  activateLookAction,
  removePresetAction,
  savePresetAction,
} from '../../app/[locale]/console/look/actions';
import { LookPreview } from './preview';

/**
 * THE LOOK & FEEL EDITOR (LF) — an approved design-system extension
 * (CLAUDE.md §4.2): every control is the design system's own field, select,
 * checkbox and button. The look being edited lives here; the preview redraws
 * as it changes, and nothing reaches a customer until "Activate".
 */
type Path = readonly [keyof ThemeLook, string];

const FONT_LABEL: Record<(typeof THEME_FONTS)[number], string | null> = {
  original: null,
  cairo: 'Cairo',
  inter: 'Inter',
  'ibm-plex-sans-arabic': 'IBM Plex Sans Arabic',
  tajawal: 'Tajawal',
};

export function LookEditor({
  locale,
  copy,
  active,
  mayChange,
}: {
  readonly locale: string;
  readonly copy: LookCopy;
  readonly active: ThemeDocument;
  readonly mayChange: boolean;
}) {
  const t = (key: LookKey) => copy[key];
  const [look, setLook] = useState<ThemeLook>(active.look);
  const [preset, setPreset] = useState<string>(active.preset);
  const issues = useMemo(() => contrastIssues(look), [look]);
  const unchanged = JSON.stringify(look) === JSON.stringify(active.look);

  const set = (path: Path, value: unknown) => {
    setPreset('custom');
    setLook((current) =>
      themeLookSchema.parse({
        ...current,
        [path[0]]: { ...(current[path[0]] as object), [path[1]]: value },
      }),
    );
  };
  const pick = (key: string, next: ThemeLook) => {
    setPreset(key);
    setLook(next);
  };

  const choice = (path: Path, label: string, options: ReadonlyArray<[string, string]>) => {
    const id = `lf-${path.join('-')}`;
    const value = String((look[path[0]] as Record<string, unknown>)[path[1]]);
    return (
      <div className="lf-field">
        <label htmlFor={id}>{label}</label>
        <select
          id={id}
          className={FIELD_CLASS}
          value={value}
          onChange={(event) => set(path, event.target.value)}
          data-testid={id}
        >
          {options.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </div>
    );
  };

  const toggle = (path: Path, label: string) => {
    const id = `lf-${path.join('-')}`;
    const checked = (look[path[0]] as Record<string, unknown>)[path[1]] === true;
    return (
      <label className="lf-check" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(event) => set(path, event.target.checked)}
          data-testid={id}
        />
        {label}
      </label>
    );
  };

  const colour = (path: Path, label: string, original: string, hint?: string) => {
    const id = `lf-${path.join('-')}`;
    const value = (look[path[0]] as Record<string, unknown>)[path[1]] as string | null;
    return (
      <div className="lf-field">
        <label htmlFor={id}>{label}</label>
        <div className="lf-colour">
          <input
            id={id}
            type="color"
            className="lf-colour-input"
            value={value ?? original}
            onChange={(event) => set(path, event.target.value.toLowerCase())}
            data-testid={id}
          />
          <span className="lf-colour-value" dir="ltr">
            {value ?? original}
          </span>
          {value ? (
            <button
              type="button"
              className={buttonClass('ghost', 'sm')}
              onClick={() => set(path, null)}
            >
              {t('colour.useOriginal')}
            </button>
          ) : (
            <span className="lf-muted">{t('colour.original')}</span>
          )}
        </div>
        {hint ? <p className="lf-hint">{hint}</p> : null}
      </div>
    );
  };

  const section = (key: LookKey, children: ReactNode, testId: string) => (
    <Card title={t(key)} testId={testId}>
      <div className="lf-grid">{children}</div>
    </Card>
  );

  return (
    <div className="lf-editor">
      <div className="lf-controls">
        <Card title={t('section.start')} testId="lf-start">
          <div className="lf-presets" role="group" aria-label={t('section.start')}>
            {THEME_PRESET_KEYS.map((key) => (
              <button
                key={key}
                type="button"
                className={buttonClass(preset === key ? 'brand' : 'neutral', 'sm')}
                aria-pressed={preset === key}
                onClick={() => pick(key, presetLook(key))}
                data-testid={`lf-preset-${key}`}
                title={key === 'light' ? t('preset.lightHint') : undefined}
              >
                {t(`preset.${key}` as LookKey)}
              </button>
            ))}
          </div>
          <h3 className="lf-subhead">{t('preset.saved')}</h3>
          {active.savedPresets.length === 0 ? (
            <p className="lf-muted">{t('preset.none')}</p>
          ) : (
            <ul className="lf-saved">
              {active.savedPresets.map((saved) => (
                <li key={saved.id}>
                  <button
                    type="button"
                    className={buttonClass('neutral', 'sm')}
                    onClick={() => pick('saved', saved.look)}
                    data-testid={`lf-saved-${saved.id}`}
                  >
                    {saved.name}
                  </button>
                  {mayChange ? (
                    <form action={removePresetAction}>
                      <input type="hidden" name="locale" value={locale} />
                      <input type="hidden" name="id" value={saved.id} />
                      <input type="hidden" name="confirm" value="yes" />
                      <button type="submit" className={buttonClass('ghost', 'sm')}>
                        {t('preset.delete')}
                      </button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {mayChange ? (
            <form action={savePresetAction} className="lf-inline-form" data-testid="lf-save-preset">
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="look" value={JSON.stringify(look)} />
              <input type="hidden" name="confirm" value="yes" />
              <label htmlFor="lf-preset-name">{t('preset.name')}</label>
              <input
                id="lf-preset-name"
                name="name"
                className={FIELD_CLASS}
                maxLength={60}
                required
              />
              <button
                type="submit"
                className={buttonClass('neutral', 'sm')}
                disabled={issues.length > 0}
              >
                {t('preset.saveAs')}
              </button>
            </form>
          ) : null}
        </Card>

        {section(
          'section.colours',
          <>
            {colour(
              ['colours', 'primary'],
              t('colour.primary'),
              ORIGINAL_ROLES.primary,
              t('colour.primaryHint'),
            )}
            {colour(['colours', 'secondary'], t('colour.secondary'), ORIGINAL_ROLES.secondary)}
            {colour(['colours', 'background'], t('colour.background'), ORIGINAL_ROLES.background)}
            {toggle(['colours', 'backgroundGradient'], t('colour.backgroundGradient'))}
            {colour(['colours', 'surface'], t('colour.surface'), ORIGINAL_ROLES.surface)}
            {colour(['colours', 'text'], t('colour.text'), ORIGINAL_ROLES.text)}
            {colour(['colours', 'success'], t('colour.success'), ORIGINAL_ROLES.success)}
            {colour(['colours', 'warning'], t('colour.warning'), ORIGINAL_ROLES.warning)}
            {colour(['colours', 'danger'], t('colour.danger'), ORIGINAL_ROLES.danger)}
            {colour(['colours', 'info'], t('colour.info'), ORIGINAL_ROLES.info)}
          </>,
          'lf-colours',
        )}

        {section(
          'section.dark',
          <>
            {choice(['dark', 'mode'], t('dark.mode'), [
              ['light', t('dark.light')],
              ['dark', t('dark.dark')],
              ['system', t('dark.system')],
            ])}
            <p className="lf-hint">{t('dark.hint')}</p>
            {colour(['dark', 'primary'], t('dark.primary'), ORIGINAL_ROLES.primary)}
            {colour(['dark', 'background'], t('dark.background'), ORIGINAL_ROLES.background)}
            {colour(['dark', 'surface'], t('dark.surface'), ORIGINAL_ROLES.surface)}
            {colour(['dark', 'text'], t('dark.text'), ORIGINAL_ROLES.text)}
          </>,
          'lf-dark',
        )}

        {section(
          'section.shape',
          <>
            {choice(['shape', 'radius'], t('shape.radius'), [
              ['sharp', t('shape.sharp')],
              ['medium', t('shape.medium')],
              ['round', t('shape.round')],
            ])}
            {choice(['shape', 'shadows'], t('shape.shadows'), [
              ['none', t('shape.none')],
              ['soft', t('shape.soft')],
              ['medium', t('shape.mediumShadow')],
            ])}
            {choice(['shape', 'density'], t('shape.density'), [
              ['comfortable', t('shape.comfortable')],
              ['compact', t('shape.compact')],
            ])}
            {choice(['buttons', 'style'], t('buttons.style'), [
              ['filled', t('buttons.filled')],
              ['soft', t('buttons.soft')],
              ['outline', t('buttons.outline')],
            ])}
            {choice(['buttons', 'size'], t('buttons.size'), [
              ['small', t('size.small')],
              ['medium', t('size.medium')],
              ['large', t('size.large')],
            ])}
            {choice(['fields', 'style'], t('fields.style'), [
              ['filled', t('fields.filled')],
              ['outlined', t('fields.outlined')],
            ])}
            {choice(['fields', 'border'], t('fields.border'), [
              ['1', '1 px'],
              ['1.5', '1.5 px'],
              ['2', '2 px'],
            ])}
          </>,
          'lf-shape',
        )}

        {section(
          'section.text',
          <>
            {choice(
              ['text', 'font'],
              t('text.font'),
              THEME_FONTS.map(
                (key) => [key, FONT_LABEL[key] ?? t('text.fontOriginal')] as [string, string],
              ),
            )}
            {choice(['text', 'size'], t('text.size'), [
              ['small', t('size.small')],
              ['normal', t('text.normal')],
              ['large', t('size.large')],
            ])}
            {choice(['text', 'lineHeight'], t('text.lineHeight'), [
              ['normal', t('text.normal')],
              ['relaxed', t('text.relaxed')],
            ])}
            <p className="lf-hint">{t('text.arabicNote')}</p>
          </>,
          'lf-text',
        )}

        {section(
          'section.motion',
          <>
            {choice(['motion', 'level'], t('motion.level'), [
              ['full', t('motion.full')],
              ['reduced', t('motion.reduced')],
              ['off', t('motion.off')],
            ])}
            {choice(['motion', 'speed'], t('motion.speed'), [
              ['calm', t('motion.calm')],
              ['normal', t('motion.normal')],
              ['quick', t('motion.quick')],
            ])}
            <p className="lf-hint">{t('motion.note')}</p>
            {toggle(['effects', 'overlayBlur'], t('effects.overlayBlur'))}
            {toggle(['effects', 'gradients'], t('effects.gradients'))}
            {toggle(['effects', 'glass'], t('effects.glass'))}
          </>,
          'lf-motion',
        )}

        {section(
          'section.layout',
          <>
            {choice(['layout', 'sidebarWidth'], t('layout.sidebarWidth'), [
              ['compact', t('layout.compact')],
              ['default', t('layout.default')],
              ['wide', t('layout.wide')],
            ])}
            {choice(['layout', 'sidebarDefault'], t('layout.sidebarDefault'), [
              ['expanded', t('layout.expanded')],
              ['collapsed', t('layout.collapsed')],
            ])}
            {choice(['layout', 'contentWidth'], t('layout.contentWidth'), [
              ['standard', t('layout.standard')],
              ['wide', t('layout.wide')],
            ])}
          </>,
          'lf-layout',
        )}
      </div>

      <div className="lf-side">
        <Card title={t('section.preview')} testId="lf-preview-card">
          <LookPreview look={look} copy={copy} />
        </Card>

        {issues.length > 0 ? (
          <Banner tone="error" testId="lf-issues">
            <strong>{t('issues.title')}</strong>
            <ul className="lf-issues">
              {issues.map((issue) => (
                <li key={`${issue.scheme}-${issue.check}`}>
                  {locale === 'ar' ? issue.ar : issue.en}
                </li>
              ))}
            </ul>
          </Banner>
        ) : (
          <Banner tone="success" testId="lf-no-issues">
            {t('issues.none')}
          </Banner>
        )}

        {mayChange ? (
          <Card title={t('save.title')} testId="lf-activate">
            <form action={activateLookAction} className="lf-activate">
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="look" value={JSON.stringify(look)} />
              <input type="hidden" name="preset" value={preset} />
              <label htmlFor="lf-note">{t('save.reason')}</label>
              <textarea id="lf-note" name="note" className={TEXTAREA_CLASS} maxLength={300} />
              <label className="lf-check" htmlFor="lf-confirm">
                <input id="lf-confirm" type="checkbox" name="confirm" value="yes" required />
                {t('save.confirm')}
              </label>
              {unchanged ? <p className="lf-muted">{t('save.unchanged')}</p> : null}
              <button
                type="submit"
                className={buttonClass('brand')}
                disabled={unchanged || issues.length > 0}
                data-testid="lf-activate-submit"
              >
                {t('save.submit')}
              </button>
            </form>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
