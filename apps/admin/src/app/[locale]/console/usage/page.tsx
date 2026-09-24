import { SimpleUsage } from '../../../../components/simple/usage';
import { requirePageActor } from '../../../../server/platform-context';

export const dynamic = 'force-dynamic';

/**
 * /usage — Usage & Billing (contract §17).
 *
 * A Simple-mode screen with no Advanced twin: Advanced keeps AI usage and the
 * billing inbox on their own screens. Gated like the directory and the health
 * page it summarises; the AI figures additionally need `platform.ai.usage.read`
 * and say so when it is missing.
 */
export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const actor = await requirePageActor(locale, 'platform.workspace.read');
  return <SimpleUsage locale={locale} actor={actor} />;
}
