/** The three interfaces under test, and the routes each exposes. */
export interface AppUnderTest {
  readonly name: 'web' | 'dashboard' | 'admin';
  readonly label: string;
  readonly baseUrl: string;
  /** Second route, used to assert navigation. */
  readonly secondPath: string;
}

export const APPS: readonly AppUnderTest[] = [
  { name: 'web', label: 'Public website', baseUrl: 'http://127.0.0.1:3100', secondPath: 'status' },
  {
    name: 'dashboard',
    label: 'Customer dashboard',
    baseUrl: 'http://127.0.0.1:3101',
    secondPath: 'overview',
  },
  {
    name: 'admin',
    label: 'Platform Admin',
    baseUrl: 'http://127.0.0.1:3102',
    secondPath: 'overview',
  },
];

export const LOCALES = [
  { code: 'ar', dir: 'rtl', lang: 'ar-SA' },
  { code: 'en', dir: 'ltr', lang: 'en' },
] as const;
