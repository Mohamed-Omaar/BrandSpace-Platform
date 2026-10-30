import { themeDocumentSchema } from '@brandspace/shared';
import { Card, Stack, buttonClass } from '@brandspace/ui';
import { LookEditor } from '../../../../components/look/editor';
import '../../../../components/look/look.css';
import { ActionOutcome, flash } from '../../../../components/simple-ui';
import { lookCopy, type LookKey } from '../../../../i18n/look';
import { previousThemeVersion } from '../../../../server/look';
import {
  currentEnvironment,
  getConfigService,
  requirePageActor,
} from '../../../../server/platform-context';
import {
  controlCenterLookAction,
  removeLogoAction,
  resetLookAction,
  undoLookAction,
  uploadLogoAction,
} from './actions';
import { LOGO_SLOTS } from '../../../../server/theme-logo';

export const dynamic = 'force-dynamic';

/**
 * CONTROL CENTER → SIMPLE → LOOK & FEEL (LF; «الشكل»). The owner changes how
 * the product looks for every customer, previews it, and activates it through
 * the configuration lifecycle — with undo, reset and a recovery link.
 */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const actor = await requirePageActor(locale, 'platform.configuration.read');
  const query = await searchParams;
  const copy = lookCopy(locale);
  const t = (key: LookKey) => copy[key];
  const mayChange =
    actor.permissionKeys.includes('platform.configuration.manage') &&
    actor.permissionKeys.includes('platform.configuration.activate');
  const active = themeDocumentSchema.parse(
    await getConfigService().get('theme', currentEnvironment()),
  );
  const previous = mayChange ? await previousThemeVersion(actor) : null;
  const { ok, error, ref } = flash(query);
  const confirm = <input type="hidden" name="confirm" value="yes" />;
  const localeField = <input type="hidden" name="locale" value={locale} />;

  return (
    <Stack>
      <p className="lf-hint" data-testid="lf-intro">
        {t('intro')}
      </p>
      <ActionOutcome
        locale={locale}
        ok={ok}
        error={error}
        reference={ref}
        okText={(code) => copy[`ok.${code}` as LookKey] ?? null}
        errorText={(code) => copy[`error.${code}` as LookKey] ?? null}
      />
      <LookEditor locale={locale} copy={copy} active={active} mayChange={mayChange} />

      <Card title={t('logo.title')} description={t('logo.rules')} testId="lf-logo">
        <div className="lf-grid">
          {LOGO_SLOTS.map((slot) => {
            const key = active.look.logo[slot];
            return (
              <div key={slot} className="lf-field" data-testid={`lf-logo-${slot}`}>
                <strong>{t(`logo.${slot}` as LookKey)}</strong>
                {key ? (
                  <img
                    className="lf-logo"
                    src={`/theme-assets/${slot}.img?v=${encodeURIComponent(key.slice(-16))}`}
                    alt={t(`logo.${slot}` as LookKey)}
                  />
                ) : (
                  <span className="lf-muted">{t('logo.none')}</span>
                )}
                {mayChange ? (
                  <div className="lf-row">
                    <form action={uploadLogoAction} className="lf-inline-form">
                      {localeField}
                      {confirm}
                      <input type="hidden" name="slot" value={slot} />
                      <input
                        type="file"
                        name="file"
                        accept="image/png,image/jpeg,image/webp"
                        required
                        aria-label={t(`logo.${slot}` as LookKey)}
                      />
                      <button type="submit" className={buttonClass('neutral', 'sm')}>
                        {t('logo.upload')}
                      </button>
                    </form>
                    {key ? (
                      <form action={removeLogoAction}>
                        {localeField}
                        {confirm}
                        <input type="hidden" name="slot" value={slot} />
                        <button type="submit" className={buttonClass('ghost', 'sm')}>
                          {t('logo.remove')}
                        </button>
                      </form>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </Card>

      <Card title={t('section.safety')} testId="lf-safety">
        <div className="lf-grid">
          {mayChange ? (
            <form action={controlCenterLookAction} className="lf-activate" data-testid="lf-cc">
              {localeField}
              {confirm}
              <label className="lf-check" htmlFor="lf-cc-keep">
                <input
                  id="lf-cc-keep"
                  type="checkbox"
                  name="keep"
                  value="yes"
                  defaultChecked={active.controlCenterOriginal}
                />
                {t('cc.label')}
              </label>
              <p className="lf-hint">{t('cc.hint')}</p>
              <div>
                <button type="submit" className={buttonClass('neutral', 'sm')}>
                  {t('cc.save')}
                </button>
              </div>
            </form>
          ) : null}
          <div className="lf-field" data-testid="lf-recover">
            <strong>{t('recover.title')}</strong>
            <p className="lf-hint">{t('recover.hint')}</p>
            <a href={`/${locale}/console/look/recover`} dir="ltr">
              {`/${locale}/console/look/recover`}
            </a>
          </div>
        </div>
      </Card>

      {mayChange ? (
        <Card title={t('section.history')} testId="lf-history">
          <div className="lf-grid">
            <form action={undoLookAction} className="lf-activate" data-testid="lf-undo">
              {localeField}
              {confirm}
              <strong>{t('undo.title')}</strong>
              {previous ? null : <p className="lf-muted">{t('undo.none')}</p>}
              <div>
                <button type="submit" className={buttonClass('neutral', 'sm')} disabled={!previous}>
                  {t('undo.submit')}
                </button>
              </div>
            </form>
            <form action={resetLookAction} className="lf-activate" data-testid="lf-reset">
              {localeField}
              {confirm}
              <strong>{t('reset.title')}</strong>
              <div>
                <button type="submit" className={buttonClass('danger', 'sm')}>
                  {t('reset.submit')}
                </button>
              </div>
            </form>
          </div>
        </Card>
      ) : null}
    </Stack>
  );
}
