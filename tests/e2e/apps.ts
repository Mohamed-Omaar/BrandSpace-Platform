/** The interfaces under test, and the routes each exposes. */
export interface AppUnderTest {
  readonly name: 'web' | 'dashboard' | 'admin';
  readonly label: string;
  readonly baseUrl: string;
  /** Second route, used to assert navigation. */
  readonly secondPath: string;
}

/**
 * The PUBLIC-FACING scaffold. Statically rendered, needs no database, and
 * exposes the shared shell the generic specs assert against.
 *
 * Neither authenticated application is in this list, for the same reason in
 * both cases: they are real, session-gated, database-backed products whose
 * roots redirect to a sign-in page, so asserting the scaffold's shape against
 * them would test markup that no longer exists.
 *
 *   - The Control Center left in Phase 2A -> admin-console.spec.ts
 *   - The customer dashboard leaves in Phase 2B -> customer-app.spec.ts
 *
 * Each replacement suite covers strictly MORE than the generic one did:
 * authentication, session realm separation, RBAC, RTL/LTR, keyboard operation,
 * accessibility and overflow, against pages that hold real data.
 */
export const APPS: readonly AppUnderTest[] = [
  { name: 'web', label: 'Public website', baseUrl: 'http://127.0.0.1:3100', secondPath: 'status' },
];

export const DASHBOARD_BASE_URL = 'http://127.0.0.1:3101';
export const ADMIN_BASE_URL = 'http://127.0.0.1:3102';

export const LOCALES = [
  { code: 'ar', dir: 'rtl', lang: 'ar-SA' },
  { code: 'en', dir: 'ltr', lang: 'en' },
] as const;
