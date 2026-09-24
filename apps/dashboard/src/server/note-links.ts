/**
 * WHERE A CONVERSATION LIVES — the exact subject, with the thread highlighted
 * (D-277 §28, D-281).
 *
 * PURE, AND NOT `server-only`: the unit suite imports it. One helper for every
 * place that links to a conversation — the Notes inbox and Home — so they
 * cannot disagree about where a thread is. `?thread=` tells the page which
 * thread to draw highlighted; `#thread-…` scrolls to it.
 */
export interface NoteLinkTarget {
  readonly threadId: string;
  readonly brandId: string;
  readonly subjectType: 'CONTENT_ITEM' | 'CAMPAIGN' | 'BRAND' | 'ASSET';
  readonly contentItemId: string | null;
  readonly campaignId: string | null;
  readonly assetId: string | null;
}

export function noteThreadHref(locale: string, entry: NoteLinkTarget): string {
  const thread = encodeURIComponent(entry.threadId);
  const anchor = `#thread-${thread}`;
  if (entry.subjectType === 'CONTENT_ITEM' && entry.contentItemId) {
    return `/${locale}/content/compose?item=${entry.contentItemId}&thread=${thread}${anchor}`;
  }
  if (entry.subjectType === 'CAMPAIGN' && entry.campaignId) {
    return `/${locale}/campaigns/${entry.campaignId}?thread=${thread}${anchor}`;
  }
  if (entry.subjectType === 'ASSET' && entry.assetId) {
    return `/${locale}/assets?asset=${entry.assetId}&thread=${thread}${anchor}`;
  }
  return `/${locale}/brand-brain?brand=${entry.brandId}&thread=${thread}${anchor}`;
}
