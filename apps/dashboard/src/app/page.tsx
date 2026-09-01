import { colorTokens } from '@brandspace/ui';

/**
 * Customer dashboard shell — apps/dashboard (app.brandspace.cc).
 * Customer session realm only. Phase 1 scaffold: no product modules.
 */
export default function DashboardPage() {
  return (
    <main style={{ padding: '2rem' }}>
      <h1 style={{ color: colorTokens.brandBlue }}>Dashboard</h1>
      <p>Customer application shell. Phase 1 — foundations only.</p>
    </main>
  );
}
