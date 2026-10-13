import type { Metadata } from 'next';
import { LegalPage } from '../../../../components/legal-page';
import { legalDocument } from '../../../../legal/documents';

/** PR F, Q11 — public, no sign-in: the address goes into the Meta and TikTok apps. */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  return { title: `${legalDocument('privacy', locale).title} · Brandspace` };
}

export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  return <LegalPage locale={locale} document="privacy" />;
}
