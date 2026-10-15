import type { AreaSpec, CollectionSpec, FieldSpec, ItemView } from '../types';
import { arrayOf, bool, num, rec } from '../json';

/**
 * SIGN-UPS AND SECURITY — open or invitation-only, the shortest password,
 * and the customer second factor. The abuse ceilings and verification timings
 * are shown, never hidden, and changed by the developer.
 */

/** The beta's readiness floor (`owner-readiness.ts`); a shorter one is allowed but said. */
const RECOMMENDED_MIN_PASSWORD = 12;

const fields: readonly FieldSpec[] = [
  { id: 'open', kind: 'switch', label: 'su.f.open', help: 'su.h.open', impact: 'su.i.open' },
  {
    id: 'minPasswordLength',
    kind: 'number',
    label: 'su.f.password',
    help: 'su.h.password',
    impact: 'su.i.password',
    unit: 'u.characters',
    min: 8,
    max: 128,
  },
  {
    id: 'mfaOffered',
    kind: 'switch',
    label: 'su.f.mfaOffered',
    help: 'su.h.mfaOffered',
    impact: 'su.i.mfa',
  },
  {
    id: 'mfaRequired',
    kind: 'switch',
    label: 'su.f.mfaRequired',
    help: 'su.h.mfaRequired',
    impact: 'su.i.mfa',
  },
];

const collection: CollectionSpec = {
  id: 'signups',
  title: 'su.title',
  domains: ['onboarding'],
  fields: () => fields,
  keyOf: () => 'signups',
  items: (docs, ctx): readonly ItemView[] => {
    const signup = rec(docs.onboarding?.['signup']);
    const mfa = rec(docs.onboarding?.['mfa']);
    const open = signup['open'] !== false;
    return [
      {
        key: 'signups',
        title: ctx.t('su.cardTitle'),
        status: open
          ? { label: ctx.t('su.s.open'), tone: 'success' }
          : { label: ctx.t('su.s.closed'), tone: 'warning' },
        facts: [
          {
            label: ctx.t('su.f.password'),
            value: `${num(signup['minPasswordLength']) ?? 8} ${ctx.t('u.characters')}`,
          },
          {
            label: ctx.t('su.f.mfaOffered'),
            value: ctx.t(mfa['customerEnrolmentEnabled'] === false ? 'w.no' : 'w.yes'),
          },
          {
            label: ctx.t('su.f.mfaRequired'),
            value: ctx.t(bool(mfa['requiredForCustomers']) ? 'w.yes' : 'w.no'),
          },
        ],
        values: {
          open,
          minPasswordLength: num(signup['minPasswordLength']) ?? 8,
          mfaOffered: mfa['customerEnrolmentEnabled'] !== false,
          mfaRequired: bool(mfa['requiredForCustomers']),
        },
      },
    ];
  },
  apply: (docs, _ctx, { values }) => ({
    onboarding: {
      ...docs.onboarding,
      signup: {
        ...rec(docs.onboarding?.['signup']),
        open: values['open'],
        minPasswordLength: values['minPasswordLength'],
      },
      mfa: {
        ...rec(docs.onboarding?.['mfa']),
        customerEnrolmentEnabled: values['mfaOffered'],
        requiredForCustomers: values['mfaRequired'],
      },
    },
  }),
  check: (_before, after, ctx) => {
    const mfa = rec(after.onboarding?.['mfa']);
    return bool(mfa['requiredForCustomers']) && mfa['customerEnrolmentEnabled'] === false
      ? [ctx.t('su.r.mfa')]
      : [];
  },
  impact: (before, after, ctx) => {
    const out: string[] = [];
    const was = rec(before.onboarding?.['signup']);
    const now = rec(after.onboarding?.['signup']);
    if (was['open'] !== false && now['open'] === false) out.push(ctx.t('su.p.closed'));
    if (was['open'] === false && now['open'] !== false) out.push(ctx.t('su.p.opened'));
    if (num(was['minPasswordLength']) !== num(now['minPasswordLength'])) {
      out.push(ctx.t('su.i.password'));
      if ((num(now['minPasswordLength']) ?? 8) < RECOMMENDED_MIN_PASSWORD)
        out.push(ctx.t('su.p.short', { min: RECOMMENDED_MIN_PASSWORD }));
    }
    if (JSON.stringify(before.onboarding?.['mfa']) !== JSON.stringify(after.onboarding?.['mfa']))
      out.push(ctx.t('su.i.mfa'));
    return out.length > 0 ? out : [ctx.t('w.noCustomerChange')];
  },
  slices: () => [
    {
      domain: 'onboarding',
      read: (doc) => ({
        open: rec(doc['signup'])['open'],
        minPasswordLength: rec(doc['signup'])['minPasswordLength'],
        customerEnrolmentEnabled: rec(doc['mfa'])['customerEnrolmentEnabled'],
        requiredForCustomers: rec(doc['mfa'])['requiredForCustomers'],
      }),
      write: (doc, value) => {
        const v = rec(value);
        return {
          ...doc,
          signup: {
            ...rec(doc['signup']),
            open: v['open'],
            minPasswordLength: v['minPasswordLength'],
          },
          mfa: {
            ...rec(doc['mfa']),
            customerEnrolmentEnabled: v['customerEnrolmentEnabled'],
            requiredForCustomers: v['requiredForCustomers'],
          },
        };
      },
    },
  ],
};

export const signupsArea: AreaSpec = {
  key: 'signups',
  title: 'su.title',
  intro: 'su.intro',
  href: (locale) => `/${locale}/console/manage/signups`,
  collections: [collection],
  developer: [
    {
      label: 'su.d.abuse',
      value: (docs) => {
        const a = rec(docs.onboarding?.['abuse']);
        return `${num(a['signInPerAccount']) ?? '—'} / ${num(a['windowSeconds']) ?? '—'} s`;
      },
    },
    {
      label: 'su.d.verification',
      value: (docs) =>
        `${num(rec(docs.onboarding?.['signup'])['verificationTtlMinutes']) ?? '—'} min`,
    },
    {
      label: 'su.d.recoveryCodes',
      value: (docs) => String(num(rec(docs.onboarding?.['mfa'])['recoveryCodeCount']) ?? '—'),
    },
    {
      label: 'su.d.deletion',
      value: (docs) => `${num(rec(docs.onboarding?.['workspaceDeletion'])['graceDays']) ?? '—'} d`,
    },
    { label: 'su.d.steps', value: (docs) => String(arrayOf(docs.onboarding?.['steps']).length) },
  ],
};
