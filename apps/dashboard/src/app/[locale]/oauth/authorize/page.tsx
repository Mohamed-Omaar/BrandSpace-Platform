import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Banner } from '@brandspace/ui';
import { getCustomer } from '../../../../server/customer-context';
import {
  authorizeParamsFrom,
  checkAuthorization,
  type AuthorizeParams,
} from '../../../../server/ai-apps';
import { translator, type MessageKey } from '../../../../i18n/messages';
import { AuthCard, authButtonStyle } from '../../../../components/auth-card';
import { decideConsentAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * THE CONSENT SCREEN — "Claude wants to use Brandspace as you" (D-566).
 *
 * The OAuth authorization endpoint the API's metadata names is
 * `{dashboard}/oauth/authorize`; the proxy gives it a locale, and it lands
 * here. It is on the dashboard because the customer's sign-in cookie lives on
 * this origin. Not signed in: to sign-in and back, including through two-step
 * sign-in. Signed in: the API checks the request (the app, its registered
 * return address, PKCE, the resource) and answers which of the person's
 * workspaces may connect AI apps, and their brands.
 *
 * What the person sees, every time (owner answer Q6): the app's name and where
 * it returns to, what it will be able to do and what it never can, a workspace
 * choice, a brand choice — "All brands" saying plainly that it includes brands
 * added later (owner addition) — and Allow or Cancel. An unknown app or an
 * unregistered return address is an error here and is NEVER redirected.
 *
 * DESIGN-SYSTEM EXTENSION (CLAUDE.md §4.2): the customer entry card
 * (`AuthCard` / `EntryCard`, the sign-in screens' own), its button and banner,
 * and plain radio and checkbox rows. No new component, colour or interaction.
 */
export default async function ConsentPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const t = translator(locale);
  const request = authorizeParamsFrom(query);
  const here = `/${locale}/oauth/authorize?${new URLSearchParams(request as Record<string, string>).toString()}`;

  const customer = await getCustomer().catch(() => null);
  if (!customer) redirect(`/${locale}/sign-in?${new URLSearchParams({ next: here }).toString()}`);

  const checked = await checkAuthorization(request);
  if (checked.status === 'redirect') redirect(checked.redirectTo);
  if (checked.status === 'error') {
    if (checked.code === 'SIGNED_OUT') {
      redirect(`/${locale}/sign-in?${new URLSearchParams({ next: here }).toString()}`);
    }
    return (
      <AuthCard locale={locale} eyebrow={t('consent.eyebrow')} heading={t('consent.errorTitle')}>
        <div role="alert" data-testid="consent-error">
          <Banner tone="error">{t(errorKey(checked.code))}</Banner>
        </div>
      </AuthCard>
    );
  }

  const available = checked.workspaces.filter((w) => w.available);
  const chosenId = typeof query['ws'] === 'string' ? query['ws'] : null;
  const chosen = available.find((w) => w.id === chosenId) ?? available[0] ?? null;
  const error = typeof query['error'] === 'string' ? query['error'] : null;
  const canWrite = checked.scopes.includes('brandspace.write');
  const fill = (key: MessageKey, values: Record<string, string>) =>
    Object.entries(values).reduce(
      (text, [name, value]) => text.replace(`{${name}}`, value),
      t(key),
    );

  return (
    <AuthCard
      locale={locale}
      eyebrow={t('consent.eyebrow')}
      heading={fill('consent.heading', { app: checked.client.name })}
      description={fill('consent.sub', { host: checked.client.redirectHost })}
    >
      {error ? (
        <div role="alert" data-testid="consent-decide-error">
          <Banner tone="error">{t(errorKey(error))}</Banner>
        </div>
      ) : null}
      <div className="bsp-consent" data-testid="consent">
        <p className="bsp-consent-h">{t('consent.can')}</p>
        <ul className="bsp-consent-list" data-testid="consent-can">
          <li>{t('consent.canRead')}</li>
          <li>{t('consent.canPosts')}</li>
          {canWrite ? <li>{t('consent.canWrite')}</li> : null}
        </ul>
        <p className="bsp-consent-h">{t('consent.never')}</p>
        <ul className="bsp-consent-list" data-testid="consent-never">
          <li>{t('consent.never1')}</li>
          <li>{t('consent.never2')}</li>
          <li>{t('consent.never3')}</li>
        </ul>

        {checked.workspaces.length > 1 ? (
          <fieldset className="bsp-consent-set" data-testid="consent-workspaces">
            <legend className="bsp-consent-h">{t('consent.workspace')}</legend>
            {checked.workspaces.map((workspace) =>
              workspace.available ? (
                <Link
                  key={workspace.id}
                  href={`${here}&ws=${encodeURIComponent(workspace.id)}`}
                  className="bsp-consent-ws"
                  aria-current={chosen?.id === workspace.id ? 'true' : undefined}
                  data-testid={`consent-ws-${workspace.id}`}
                >
                  {workspace.name}
                </Link>
              ) : (
                <span key={workspace.id} className="bsp-consent-ws" aria-disabled="true">
                  {workspace.name} —{' '}
                  {t(workspace.reason === 'off' ? 'consent.workspaceOff' : 'consent.workspacePlan')}
                </span>
              ),
            )}
          </fieldset>
        ) : null}

        {chosen ? (
          <form action={decideConsentAction} data-testid="consent-form">
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="workspaceId" value={chosen.id} />
            {hiddenParams(request)}
            {checked.workspaces.length === 1 ? (
              <p className="bsp-consent-h" data-testid="consent-workspace-name">
                {t('consent.workspace')}: {chosen.name}
              </p>
            ) : null}
            <fieldset className="bsp-consent-set" data-testid="consent-brands">
              <legend className="bsp-consent-h">{t('consent.brandsLabel')}</legend>
              <label className="bsp-consent-row">
                <input
                  type="radio"
                  name="brandMode"
                  value="all"
                  defaultChecked
                  data-testid="consent-all-brands"
                />
                <span>
                  {t('consent.allBrands')}
                  <span className="bsp-consent-note" data-testid="consent-all-brands-note">
                    {t('consent.allBrandsNote')}
                  </span>
                </span>
              </label>
              <label className="bsp-consent-row">
                <input
                  type="radio"
                  name="brandMode"
                  value="some"
                  data-testid="consent-some-brands"
                />
                <span>{t('consent.someBrands')}</span>
              </label>
              <div className="bsp-consent-brands">
                {chosen.brands.map((brand) => (
                  <label key={brand.id} className="bsp-consent-row">
                    <input
                      type="checkbox"
                      name="brandIds"
                      value={brand.id}
                      data-testid={`consent-brand-${brand.id}`}
                    />
                    <span>{brand.name}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <p className="bsp-consent-note">{t('consent.asYou')}</p>
            <div className="bsp-consent-actions">
              <button
                type="submit"
                name="decision"
                value="allow"
                style={authButtonStyle()}
                data-testid="consent-allow"
              >
                {t('consent.allow')}
              </button>
              <button
                type="submit"
                name="decision"
                value="cancel"
                className="bsp-btn bsp-ghost bsp-consent-cancel"
                data-testid="consent-cancel"
              >
                {t('consent.cancel')}
              </button>
            </div>
          </form>
        ) : (
          <form action={decideConsentAction} data-testid="consent-none">
            <input type="hidden" name="locale" value={locale} />
            {hiddenParams(request)}
            <Banner tone="warning">{t('consent.noWorkspace')}</Banner>
            <button
              type="submit"
              name="decision"
              value="cancel"
              className="bsp-btn bsp-ghost bsp-consent-cancel"
              data-testid="consent-cancel"
            >
              {t('consent.cancel')}
            </button>
          </form>
        )}
      </div>
    </AuthCard>
  );
}

function hiddenParams(request: AuthorizeParams) {
  return Object.entries(request).map(([name, value]) =>
    typeof value === 'string' ? <input key={name} type="hidden" name={name} value={value} /> : null,
  );
}

function errorKey(code: string): MessageKey {
  const known = ['INVALID_CLIENT', 'INVALID_REDIRECT', 'BRANDS', 'WORKSPACE'];
  return `consent.error.${known.includes(code) ? code : 'UNAVAILABLE'}` as MessageKey;
}
