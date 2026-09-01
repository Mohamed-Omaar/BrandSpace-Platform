import { colorTokens } from '@brandspace/ui';

/**
 * Platform Admin shell — apps/admin (admin.brandspace.cc).
 *
 * Separate application, separate hostname, separate session realm (D-04).
 * A customer session is not valid here: the platform realm uses a different
 * cookie name, signing key and audience (packages/auth realms).
 * D-27: 2FA is mandatory for every platform role once auth flows land.
 */
export default function AdminPage() {
  return (
    <main style={{ padding: '2rem' }}>
      <h1 style={{ color: colorTokens.brandBlue }}>Control Center</h1>
      <p>Internal platform administration shell. Phase 1 — foundations only.</p>
    </main>
  );
}
