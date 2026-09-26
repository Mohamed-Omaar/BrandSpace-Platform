import Link from 'next/link';
import { StateMessage, buttonClass, buttonStyle } from '@brandspace/ui';
import { translator } from '../i18n/messages';
import { brandContextFor } from '../server/brand-context';
import { memberDisplayName, workspaceOwnerName, type PageAccess } from '../server/customer-context';
import { denialText } from '../server/denial';
import { WorkspaceShell } from './workspace-shell';

/**
 * "NO ACCESS TO THIS PAGE" (E2, Q5) — for a page on the known navigation list
 * that this member's role does not open.
 *
 * Inside the normal shell, so the member keeps their navigation, and answered
 * 200: the route is one every member can see listed, so saying it is closed
 * leaks nothing. The body is the E6 denial — who lacks which permission and
 * who can change the role. Composed from the shell and the existing
 * `StateMessage` `forbidden` state (CLAUDE.md §4.2); no new visual treatment.
 *
 * A record, an unknown URL or anything off the list never comes here: those
 * keep the one not-found screen (CLAUDE.md §2.1).
 */
export async function NoAccessPage({
  locale,
  access,
}: {
  readonly locale: string;
  readonly access: Extract<PageAccess, { allowed: false }>;
}) {
  const t = translator(locale);
  const { customer, workspace } = access.session;
  const brandContext = await brandContextFor(workspace, access.route);
  const text = denialText(locale, {
    permissionKey: access.permissionKey,
    memberName: memberDisplayName(customer),
    ownerName: await workspaceOwnerName(workspace.workspaceId),
  });

  return (
    <WorkspaceShell
      brandContext={brandContext}
      locale={locale}
      heading={t('errors.noAccess.title')}
      activePath={access.route}
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={customer.email}
      permissionKeys={workspace.permissionKeys}
    >
      <StateMessage
        kind="forbidden"
        testId="route-no-access"
        title={t('errors.noAccess.title')}
        description={text.body}
        action={
          <Link
            href={`/${locale}/overview`}
            className={buttonClass('brand')}
            style={buttonStyle('brand', 'sm')}
            data-testid="route-no-access-home"
          >
            {t('errors.route.home')}
          </Link>
        }
      />
    </WorkspaceShell>
  );
}
