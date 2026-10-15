import { notFound } from 'next/navigation';
import { SimpleArea } from '../../../../../components/simple/area';
import { findArea } from '../../../../../server/simple-areas/registry';
import { requirePageActor } from '../../../../../server/platform-context';

export const dynamic = 'force-dynamic';

/**
 * /manage/<area> — one of the owner's card pages (Trial and credits,
 * Channels, Publishing, Sign-ups and security, Uploads, Email, Content, Legal
 * pages). Plans keeps its own route, `/plans`. Same page in both modes: it has
 * no Advanced twin, and Advanced's Configuration page edits the same documents
 * (D-307). The actions re-check their own permissions.
 */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; area: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, area: key } = await params;
  const actor = await requirePageActor(locale, 'platform.configuration.read');
  const area = findArea(key);
  if (!area || area.key === 'plans') notFound();
  return <SimpleArea locale={locale} actor={actor} area={area} query={await searchParams} />;
}
