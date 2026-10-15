import { ManageGrid } from '../../../../components/simple/manage';
import { requirePageActor } from '../../../../server/platform-context';

export const dynamic = 'force-dynamic';

/** /manage — every card page of the owner's control panel, in one grid. */
export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const actor = await requirePageActor(locale, 'platform.configuration.read');
  return <ManageGrid locale={locale} actor={actor} />;
}
