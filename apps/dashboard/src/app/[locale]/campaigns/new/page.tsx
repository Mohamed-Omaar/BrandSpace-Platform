import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * D-496 (Shell 7) — THE CAMPAIGN FORM IS NOW THE PROTOTYPE'S DIALOG over
 * Campaigns (`/campaigns?new=1`). This address stays, so a link or bookmark to
 * it — or to Strategy's prefilled form (D-292) — still opens the form: every
 * value it carried goes along, and the list page reads them exactly as this
 * page did (the objective and the channels from closed sets only). The list's
 * own gate (`campaigns.read`) and the dialog's (`campaigns.manage`) decide who
 * sees it.
 */
export default async function NewCampaignPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const carried = new URLSearchParams({ new: '1' });
  for (const [key, value] of Object.entries(query)) {
    if (key === 'new') continue;
    for (const entry of Array.isArray(value) ? value : [value]) {
      if (typeof entry === 'string') carried.append(key, entry);
    }
  }
  redirect(`/${locale === 'ar' ? 'ar' : 'en'}/campaigns?${carried.toString()}`);
}
