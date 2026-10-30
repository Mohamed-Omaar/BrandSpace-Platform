import { Banner, Card, Stack, buttonClass } from '@brandspace/ui';
import '../../../../../components/look/look.css';
import { ActionOutcome, flash } from '../../../../../components/simple-ui';
import { lookCopy, type LookKey } from '../../../../../i18n/look';
import { requirePageActor } from '../../../../../server/platform-context';
import { recoverLookAction } from '../actions';

export const dynamic = 'force-dynamic';

/**
 * SAFE MODE: THE RECOVERY LINK (LF). A fixed address the platform owner can
 * open from any state of the product: one button puts the original look back
 * everywhere, and the Control Center back on it. The page answers 404, like a
 * page that does not exist, to anyone without the activate permission; the
 * action itself also requires the owner role and the second sign-in step.
 */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const actor = await requirePageActor(locale, 'platform.configuration.activate');
  const copy = lookCopy(locale);
  const t = (key: LookKey) => copy[key];
  const { ok, error, ref } = flash(await searchParams);
  const owner = actor.roleKey === 'platform_owner' && actor.mfaVerified;

  return (
    <Stack>
      <ActionOutcome
        locale={locale}
        ok={ok}
        error={error}
        reference={ref}
        okText={(code) => copy[`ok.${code}` as LookKey] ?? null}
        errorText={(code) => copy[`error.${code}` as LookKey] ?? null}
      />
      <Card title={t('recover.title')} testId="lf-recover-page">
        <div className="lf-grid">
          <p className="lf-hint">{t('recover.hint')}</p>
          {owner ? (
            <form action={recoverLookAction}>
              <input type="hidden" name="locale" value={locale} />
              <button
                type="submit"
                className={buttonClass('danger')}
                data-testid="lf-recover-submit"
              >
                {t('reset.submit')}
              </button>
            </form>
          ) : (
            <Banner tone="warning" testId="lf-recover-not-owner">
              {t('error.NOT_OWNER')}
            </Banner>
          )}
        </div>
      </Card>
    </Stack>
  );
}
