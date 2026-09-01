import { colorTokens } from '@brandspace/ui';

/**
 * Public website shell — apps/web (brandspace.cc).
 * Phase 1 scaffold only: no marketing content, no CMS. Page inventory is in
 * docs/PRODUCT.md §4 and is built in Phase 8.
 */
export default function HomePage() {
  return (
    <main style={{ padding: '2rem', maxWidth: '48rem', marginInline: 'auto' }}>
      <h1 style={{ color: colorTokens.brandBlue }}>BrandSpace</h1>
      <p>Public website shell. Phase 1 — foundations only.</p>
    </main>
  );
}
