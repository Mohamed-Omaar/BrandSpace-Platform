import Link from 'next/link';
import { headers } from 'next/headers';
import { BrandGlyph, LanguageSwitcher } from '@brandspace/ui';
import { translator } from '../i18n/messages';
import { switchLocalePath } from '../i18n/locale-path';
import {
  LEGAL_DOCUMENT_KEYS,
  LEGAL_VERSION,
  legalDocument,
  type LegalBlock,
  type LegalDocumentKey,
} from '../legal/documents';

/**
 * PR F, Q11 — THE THREE PUBLIC LEGAL PAGES: `/terms`, `/privacy`,
 * `/data-deletion`. No sign-in, both languages, and the address the owner
 * pastes into the Meta and TikTok developer apps.
 *
 * AN APPROVED DESIGN-SYSTEM EXTENSION (CLAUDE.md §4.2; UI-FIDELITY-CONTRACT
 * §6.3.65): the prototype draws no legal page, so this is the entry screens'
 * own language — the same wash, the brand row with the 44px language button,
 * the purple eyebrow, the 42px heading — on a wider card that the page itself
 * scrolls, because a document is read top to bottom. Nothing new: no colour,
 * font, shadow or control the entry screens do not already use.
 *
 * Every page says at the top that the text is a draft awaiting a lawyer's
 * review, and every `[PLACEHOLDER]` is drawn highlighted.
 */
export async function LegalPage({
  locale,
  document: key,
}: {
  readonly locale: string;
  readonly document: LegalDocumentKey;
}) {
  const t = translator(locale);
  const doc = legalDocument(key, locale);
  const other = locale === 'ar' ? 'en' : 'ar';
  const languageHref = switchLocalePath(
    (await headers()).get('x-brandspace-path'),
    other,
    `/${other}/${key}`,
  );

  return (
    <div className="bsp-legal">
      <main id="main" className="bsp-legal-stage">
        <article className="bsp-legal-card" data-testid="legal-document" data-document={key}>
          <div className="bsp-auth-brand">
            <span className="bsp-auth-logo">
              <BrandGlyph size="var(--bsp-px-46)" />
            </span>
            <span className="bsp-auth-word bsp-ltr" lang="en">
              Brandspace
            </span>
            <nav aria-label={t('legal.languageNav')} className="bsp-auth-lang">
              <LanguageSwitcher
                href={languageHref}
                targetLocale={other}
                targetLabel={other === 'ar' ? 'ع' : 'EN'}
                ariaLabel={t('legal.changeLanguage')}
              />
            </nav>
          </div>

          <nav aria-label={t('legal.documentsNav')} className="bsp-legal-tabs">
            {LEGAL_DOCUMENT_KEYS.map((other) => (
              <Link
                key={other}
                href={`/${locale}/${other}`}
                aria-current={other === key ? 'page' : undefined}
                data-testid={`legal-tab-${other}`}
              >
                {legalDocument(other, locale).title}
              </Link>
            ))}
          </nav>

          <span className="bsp-auth-eyebrow">
            <span aria-hidden="true" />
            {t('legal.eyebrow')}
          </span>
          <div className="bsp-auth-head">
            <h1 data-testid="heading">{doc.title}</h1>
            <p>{doc.summary}</p>
          </div>
          <p className="bsp-legal-version" data-testid="legal-version">
            {t('legal.version')} <span className="bsp-ltr">{LEGAL_VERSION}</span>
          </p>
          <p role="note" className="bsp-legal-draft" data-testid="legal-draft-notice">
            {t('legal.draftNotice')}
          </p>

          <nav aria-label={t('legal.contents')} className="bsp-legal-toc">
            <ol>
              {doc.sections.map((section) => (
                <li key={section.id}>
                  <a href={`#${section.id}`}>{section.heading}</a>
                </li>
              ))}
            </ol>
          </nav>

          {doc.sections.map((section) => (
            <section
              key={section.id}
              id={section.id}
              aria-labelledby={`${section.id}-heading`}
              className="bsp-legal-section"
            >
              <h2 id={`${section.id}-heading`}>{section.heading}</h2>
              {section.body.map((block, index) => (
                <Block key={index} block={block} />
              ))}
            </section>
          ))}

          <p className="bsp-legal-foot">
            <Link href={`/${locale}/sign-in`} className="bsp-lnk">
              {t('legal.signIn')}
            </Link>
          </p>
        </article>
      </main>
    </div>
  );
}

function Block({ block }: { readonly block: LegalBlock }) {
  if (typeof block === 'string') return <p>{withPlaceholders(block)}</p>;
  return (
    <ul>
      {block.list.map((item) => (
        <li key={item}>{withPlaceholders(item)}</li>
      ))}
    </ul>
  );
}

/** `[LEGAL ENTITY NAME]` and every other placeholder, drawn so it cannot pass for text. */
function withPlaceholders(text: string) {
  return text.split(/(\[[^\]]+\])/g).map((part, index) =>
    /^\[[^\]]+\]$/.test(part) ? (
      <mark key={index} className="bsp-legal-ph" data-testid="legal-placeholder">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}
