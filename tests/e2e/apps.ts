/** The interfaces under test, and the routes each exposes. */
export interface AppUnderTest {
  readonly name: 'web' | 'dashboard' | 'admin';
  readonly label: string;
  readonly baseUrl: string;
  /** Second route, used to assert navigation. */
  readonly secondPath: string;
}

/**
 * The two PUBLIC-FACING scaffolds. These are statically rendered, need no
 * database and expose the same shell, so one set of generic specs covers both.
 *
 * The Control Center is deliberately NOT in this list. From Phase 2A it is a
 * real, session-gated, database-backed application: its root redirects to the
 * sign-in page, it has no shared scaffold markup, and asserting the scaffold's
 * shape against it would test nothing that exists. It has its own suite in
 * admin-console.spec.ts, which covers strictly more: authentication, MFA, the
 * configuration lifecycle, secret handling, RTL/LTR, keyboard navigation,
 * accessibility and overflow.
 */
export const APPS: readonly AppUnderTest[] = [
  { name: 'web', label: 'Public website', baseUrl: 'http://127.0.0.1:3100', secondPath: 'status' },
  {
    name: 'dashboard',
    label: 'Customer dashboard',
    baseUrl: 'http://127.0.0.1:3101',
    secondPath: 'overview',
  },
];

export const ADMIN_BASE_URL = 'http://127.0.0.1:3102';

export const LOCALES = [
  { code: 'ar', dir: 'rtl', lang: 'ar-SA' },
  { code: 'en', dir: 'ltr', lang: 'en' },
] as const;
