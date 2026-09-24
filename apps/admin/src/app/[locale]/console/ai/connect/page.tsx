import { SimpleAiConnect } from '../../../../../components/simple/ai';
import { requirePageActor } from '../../../../../server/platform-context';

export const dynamic = 'force-dynamic';

/**
 * /ai/connect — connect or change the AI provider.
 *
 * A Simple-mode screen with no Advanced twin: it renders the same in both
 * modes, and Advanced keeps Providers, AI models and Routing for the detail.
 * Gated like every AI configuration screen; the actions it links to re-check
 * their own authorities (D-307).
 */
export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const actor = await requirePageActor(locale, 'platform.configuration.read');
  return <SimpleAiConnect locale={locale} actor={actor} />;
}
