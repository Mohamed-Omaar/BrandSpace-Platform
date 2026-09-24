import { SimpleAiOverview } from '../../../../components/simple/ai';
import { requirePageActor } from '../../../../server/platform-context';

export const dynamic = 'force-dynamic';

/**
 * /ai — the owner's AI overview.
 *
 * A Simple-mode screen with no Advanced twin: it renders the same in both
 * modes, and Advanced keeps Providers, AI models and Routing for the detail.
 * Gated like every AI configuration screen; the actions it links to re-check
 * their own authorities (D-307).
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
  return <SimpleAiOverview locale={locale} actor={actor} query={await searchParams} />;
}
