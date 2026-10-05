/**
 * THE PARITY FIXTURE — the comparison workspace for the D-468 side-by-side pairs.
 *
 * The pairs compare DESIGN. Pointed at the functional suites' workspace they
 * compared fixtures instead: long generated titles, text posts with no picture,
 * no plan, no channels. So this provisions a workspace of its own shaped like
 * the prototype's café (`Main.dc.html` — Reema Café, Reem, Sara and Omar, the
 * Autumn menu and Weekends campaigns, short titles, posts with picture covers,
 * Instagram, Facebook and TikTok connected) and every pair is taken there —
 * twice: an English workspace for the English pair, and an Arabic one (the
 * prototype's Arabic titles, captions and names) for the Arabic pair. Both are
 * in Egypt, as the prototype's café is.
 *
 * TEST FIXTURES ONLY. It runs against the local throwaway database, refuses
 * production and any non-local database, and is not part of `e2e:seed`: no
 * functional test reads it, and no customer workspace ever receives it.
 *
 * A NEW WORKSPACE EVERY RUN (its slug and owner carry a random suffix), so a
 * second run never photographs what the first one left behind. The password is
 * generated, never printed, and written to a git-ignored file.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { WorkspaceAdminService, hashPassword } from '@brandspace/auth';
import {
  CreditLedgerService,
  gigabytesFor,
  measureStorageBreakdown,
} from '@brandspace/entitlements';
import { ConfigurationService } from '@brandspace/config';
import { withWorkspace } from '@brandspace/database';
import { createObjectStore } from '@brandspace/storage';
import { E2E_PARITY_FILE, loadE2eEnv, type E2eParityFixture, type E2eParityWorkspace } from './env';
import { gradientPng, type GradientStop } from './parity-png';

loadE2eEnv();

const DAY = 86_400_000;

/** The prototype's pictures (`Main.dc.html` lines 2288 and the `art*` constants). */
const ART: Readonly<Record<string, readonly GradientStop[]>> = {
  photo0: [
    { at: 0, hex: '#6b4128' },
    { at: 0.45, hex: '#b8794a' },
    { at: 1, hex: '#e9c79a' },
  ],
  photo1: [
    { at: 0, hex: '#2c1d17' },
    { at: 0.6, hex: '#7a4b2f' },
    { at: 1, hex: '#d9a066' },
  ],
  photo3: [
    { at: 0, hex: '#3a2a4f' },
    { at: 0.7, hex: '#7935fe' },
    { at: 1, hex: '#c6a8ff' },
  ],
  photo4: [
    { at: 0, hex: '#1f3a2c' },
    { at: 0.6, hex: '#4d7a5b' },
    { at: 1, hex: '#cfe3c1' },
  ],
  art2: [
    { at: 0, hex: '#f4e3c8' },
    { at: 0.6, hex: '#d9a066' },
    { at: 1, hex: '#8a5534' },
  ],
  artSky: [
    { at: 0, hex: '#cfe9ff' },
    { at: 0.6, hex: '#7ab8ff' },
    { at: 1, hex: '#1f4f99' },
  ],
};

type Status = 'DRAFT' | 'IN_REVIEW' | 'SCHEDULED' | 'PUBLISHED' | 'FAILED';

/**
 * The prototype's posts (`Main.dc.html` lines 2501–2513), in the order its
 * library shows them (failed, in review, drafts, scheduled, then published,
 * newest first). The library lists the most recently changed first, so each
 * is stamped a second older than the one before it.
 */
const POSTS: ReadonlyArray<{
  key: string;
  en: string;
  ar: string;
  caption: string;
  captionAr: string;
  type: 'POST' | 'REEL' | 'CAROUSEL';
  channels: readonly ('instagram' | 'facebook' | 'tiktok')[];
  /** Days from the seed, and the local time — or null for a post with no date. */
  day: number | null;
  time: string;
  status: Status;
  campaign: 'autumn' | 'weekends' | 'summer' | null;
  author: 'reem' | 'sara' | 'omar';
  art: keyof typeof ART;
}> = [
  {
    key: 'teaser',
    en: 'Autumn offer',
    ar: 'عرض الخريف',
    caption: 'The autumn menu lands next week 🍂 Guess the first drink.',
    captionAr: 'قائمة الخريف جاية الأسبوع الجاي 🍂 خمّن أول مشروب.',
    type: 'POST',
    channels: ['instagram'],
    day: 0,
    time: '18:00',
    status: 'FAILED',
    campaign: 'autumn',
    author: 'reem',
    art: 'photo3',
  },
  {
    key: 'brunch',
    en: 'Weekend brunch',
    ar: 'برانش الويكند',
    caption:
      'Brunch is back every Friday and Saturday, 10 to 2 🥐 Book a table from the link in bio.',
    captionAr: 'البرانش رجع كل جمعة وسبت من 10 لـ 2 🥐 احجز ترابيزتك من اللينك في البايو.',
    type: 'POST',
    channels: ['instagram', 'facebook'],
    day: 3,
    time: '10:00',
    status: 'IN_REVIEW',
    campaign: 'weekends',
    author: 'omar',
    art: 'art2',
  },
  {
    key: 'menuboard',
    en: 'The new menu board',
    ar: 'لوحة المنيو الجديدة',
    caption: 'The autumn menu board is up. Which one are you ordering first?',
    captionAr: 'لوحة منيو الخريف اتعلقت. هتطلب إيه الأول؟',
    type: 'POST',
    channels: ['instagram'],
    day: 4,
    time: '12:00',
    status: 'IN_REVIEW',
    campaign: 'autumn',
    author: 'omar',
    art: 'photo3',
  },
  {
    key: 'roast',
    en: 'The roastery story',
    ar: 'قصة المحمصة',
    caption: 'From bean to cup: a tour of our roastery.',
    captionAr: 'من الحبة للفنجان: جولة في المحمصة.',
    type: 'CAROUSEL',
    channels: ['instagram'],
    day: 3,
    time: '09:00',
    status: 'DRAFT',
    campaign: 'autumn',
    author: 'reem',
    art: 'photo1',
  },
  {
    key: 'beans',
    en: 'Ethiopian beans',
    ar: 'حبوب إثيوبيا',
    caption: 'New Ethiopian beans just landed: berry and chocolate notes. Try them as a V60.',
    captionAr: 'حبوب إثيوبيا الجديدة وصلت: ريحة توت وشوكولاتة. جرّبها في V60.',
    type: 'POST',
    channels: ['facebook'],
    day: null,
    time: '09:00',
    status: 'DRAFT',
    campaign: null,
    author: 'omar',
    art: 'photo4',
  },
  {
    key: 'latte15',
    en: 'Cinnamon latte in 15 seconds',
    ar: 'لاتيه القرفة في 15 ثانية',
    caption: 'The cinnamon latte, start to finish, in 15 seconds. Coming to try it?',
    captionAr: 'لاتيه القرفة من الأول للآخر في 15 ثانية. تيجي تجربه؟',
    type: 'REEL',
    channels: ['instagram', 'tiktok'],
    day: 2,
    time: '08:30',
    status: 'SCHEDULED',
    campaign: 'autumn',
    author: 'reem',
    art: 'photo0',
  },
  {
    key: 'brunch0',
    en: 'Weekend brunch',
    ar: 'برانش الويكند',
    caption: 'The first brunch Friday of the season. Thank you for coming ☕',
    captionAr: 'أول جمعة برانش في الموسم. شكرًا إنكم جيتوا ☕',
    type: 'POST',
    channels: ['instagram', 'facebook'],
    day: -18,
    time: '10:00',
    status: 'PUBLISHED',
    campaign: 'weekends',
    author: 'omar',
    art: 'art2',
  },
  {
    key: 'founder',
    en: 'Founder story',
    ar: 'قصة المؤسسة',
    caption:
      'Reema opened the first café in 2019 with one machine and a big dream. This is our story.',
    captionAr: 'ريما فتحت أول فرع سنة 2019 بماكينة واحدة وحلم كبير. دي حكايتنا.',
    type: 'POST',
    channels: ['instagram'],
    day: -19,
    time: '09:00',
    status: 'PUBLISHED',
    campaign: null,
    author: 'reem',
    art: 'photo1',
  },
  {
    key: 'summer',
    en: 'Summer iced latte',
    ar: 'آيس لاتيه الصيف',
    caption: 'Last days of summer, cold brew in hand.',
    captionAr: 'آخر أيام الصيف مع الكولد برو.',
    type: 'REEL',
    channels: ['tiktok'],
    day: -54,
    time: '17:00',
    status: 'PUBLISHED',
    campaign: 'summer',
    author: 'reem',
    art: 'artSky',
  },
  {
    key: 'cold',
    en: 'Cold brew Fridays',
    ar: 'كولد برو الجمعة',
    caption: 'Every Friday: cold brew at a special price.',
    captionAr: 'كل جمعة: كولد برو بسعر خاص.',
    type: 'POST',
    channels: ['instagram'],
    day: -60,
    time: '12:00',
    status: 'PUBLISHED',
    campaign: 'summer',
    author: 'reem',
    art: 'photo4',
  },
  {
    key: 'iced',
    en: 'Iced latte at home',
    ar: 'آيس لاتيه في البيت',
    caption: 'Iced latte at home in 3 steps.',
    captionAr: 'آيس لاتيه في البيت بـ 3 خطوات.',
    type: 'REEL',
    channels: ['instagram', 'tiktok'],
    day: -84,
    time: '17:00',
    status: 'PUBLISHED',
    campaign: 'summer',
    author: 'reem',
    art: 'photo3',
  },
];

/**
 * ROUND 3 (D) — the published posts' strategy pillars, from the café's own
 * "Content pillars" fact (morning coffee, behind the bar, weekend brunch).
 */
const PILLAR: Readonly<Record<string, readonly [string, string]>> = {
  brunch0: ['Weekend brunch', 'برانش الويكند'],
  founder: ['Behind the bar', 'ورا البار'],
  summer: ['Morning coffee', 'قهوة الصبح'],
  cold: ['Morning coffee', 'قهوة الصبح'],
  iced: ['Behind the bar', 'ورا البار'],
};

/**
 * ROUND 3 (D) — each channel's daily account reach, its engagement rate (%)
 * and its new followers a day: the prototype's figures (`PCH`), so the
 * Performance screen compares like for like. Marked as sample data.
 */
const CHANNEL_FIGURES: Readonly<Record<string, readonly [number, number, number]>> = {
  INSTAGRAM: [820, 4.6, 14],
  TIKTOK: [540, 3.9, 9],
  FACEBOOK: [260, 3.1, 3],
};

/** A unique observation identity for a fixture row (the same fields ingestion keys on). */
function fixtureObservationKey(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

/**
 * A post's calendar slot: a draft or a review with a date is PLANNED (the
 * prototype's drafts and reviews carry their day), the rest as they went.
 */
const SLOT_STATUS: Readonly<Record<Status, string>> = {
  DRAFT: 'PLANNED',
  IN_REVIEW: 'PLANNED',
  SCHEDULED: 'SCHEDULED',
  PUBLISHED: 'PUBLISHED',
  FAILED: 'FAILED',
};

/** The words that differ between the English and the Arabic workspace. */
const WORDS = {
  en: {
    business: 'Reema Café',
    people: { reem: 'Reem Essam', sara: 'Sara Nabil', omar: 'Omar Khaled' },
    campaigns: {
      autumn: 'Autumn menu',
      weekends: 'Weekends',
      ramadan: 'Ramadan 2027',
      summer: 'Summer iced latte',
    },
    // Round 3 (D) — the rules' names: each rule's own sentence, as the prototype names them.
    rules: {
      slot: 'Approved posts → next free slot',
      pause: 'Engagement drops → pause the campaign',
      remind: 'Waiting 24 hours → remind the reviewer',
      ideas: 'Empty calendar → draft 3 ideas',
    },
    thread: [
      ['sara', 'Can we change the photo? The one from the window is warmer.'],
      ['reem', 'Good idea — I’ll swap it before it goes out.'],
    ] as ReadonlyArray<readonly ['reem' | 'sara' | 'omar', string]>,
  },
  ar: {
    business: 'ريما كافيه',
    people: { reem: 'ريم عصام', sara: 'سارة نبيل', omar: 'عمر خالد' },
    campaigns: {
      autumn: 'قائمة الخريف',
      weekends: 'الويكند',
      ramadan: 'رمضان 2027',
      summer: 'آيس لاتيه الصيف',
    },
    rules: {
      slot: 'منشور اتوافق عليه ← أقرب مكان فاضي',
      pause: 'التفاعل يقل ← وقّف الحملة',
      remind: 'مستني 24 ساعة ← فكّر المراجِع',
      ideas: 'التقويم فاضي ← اكتب 3 أفكار',
    },
    thread: [
      ['sara', 'ممكن نغيّر الصورة؟ اللي من الشباك أدفى.'],
      ['reem', 'فكرة حلوة — هغيّرها قبل ما ينزل.'],
    ] as ReadonlyArray<readonly ['reem' | 'sara' | 'omar', string]>,
  },
} as const;

function refuseUnsafe(): void {
  if (process.env['APP_ENV'] === 'production' || process.env['NODE_ENV'] === 'production') {
    throw new Error('Refusing to seed the parity fixture in a production environment.');
  }
  const url = process.env['DATABASE_PLATFORM_URL'] ?? '';
  if (!/localhost|127\.0\.0\.1/.test(url)) {
    throw new Error('Refusing to seed the parity fixture into a non-local database.');
  }
}

function client(variable: 'DATABASE_PLATFORM_URL' | 'DATABASE_URL'): PrismaClient {
  const connectionString = process.env[variable];
  if (!connectionString) throw new Error(`${variable} is required.`);
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

/** `YYYY-MM-DD` and the UTC instant of a Cairo-local day and time. */
function cairo(day: number, time: string): { date: string; utc: Date } {
  const base = new Date(Date.now() + day * DAY);
  const date = base.toISOString().slice(0, 10);
  // Cairo is UTC+3 in the fixture's season; the fixture only needs a stable offset.
  const utc = new Date(`${date}T${time}:00+03:00`);
  return { date, utc };
}

async function build(
  platform: PrismaClient,
  tenant: PrismaClient,
  lang: 'en' | 'ar',
  run: string,
): Promise<E2eParityWorkspace> {
  const words = WORDS[lang];
  const slug = `e2e-parity-${lang}-${run}`;
  /*
   * Gate 2b review (4i) — initials are Latin in both languages: an Arabic name
   * has none, so they come from the address, which carries the person's Latin
   * name as a real address would ("RE", "SN", "OK", as the prototype draws).
   */
  const LATIN = { reem: 'reem.essam', sara: 'sara.nabil', omar: 'omar.khaled' } as const;
  const ownerEmail = `${LATIN.reem}.${lang}-${run}@parity.brandspace.test`;

  const platformOwner = await platform.platformUser.findFirstOrThrow({
    where: { deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true, roleId: true },
  });
  const grants = await platform.rolePermission.findMany({
    where: { roleId: platformOwner.roleId },
    include: { permission: true },
  });
  await new WorkspaceAdminService({ prisma: platform }).create(
    {
      platformUserId: platformOwner.id,
      roleKey: 'platform_owner',
      mfaVerified: true,
      permissionKeys: grants.map((grant) => grant.permission.key),
    },
    {
      name: words.business,
      slug,
      ownerEmail,
      ownerName: words.people.reem,
      defaultLocale: lang === 'ar' ? 'AR' : 'EN',
      country: 'EG',
      timezone: 'Africa/Cairo',
      currency: 'EGP',
    },
  );
  /*
   * ROUND 3 (D) — the week starts on Saturday, as an Egyptian business's does
   * and as the prototype's calendar draws it.
   */
  const workspace = await platform.workspace.update({
    where: { slug },
    data: { weekStartsOn: 6 },
  });

  const password = `e2e-${randomBytes(18).toString('base64url')}`;
  const owner = await platform.user.update({
    where: { email: ownerEmail },
    data: {
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      passwordHash: await hashPassword(password),
    },
  });

  /* Reem owns it; Sara reviews, Omar writes — the prototype's team. */
  const roles = await platform.role.findMany({
    where: {
      workspaceId: null,
      key: { in: ['workspace_owner', 'approver', 'content_creator'] },
    },
    select: { id: true, key: true },
  });
  const roleId = (key: string): string => {
    const found = roles.find((role) => role.key === key);
    if (!found) throw new Error(`The system role ${key} is missing.`);
    return found.id;
  };
  await platform.membership.upsert({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId: owner.id } },
    create: {
      workspaceId: workspace.id,
      userId: owner.id,
      roleId: roleId('workspace_owner'),
      status: 'ACTIVE',
      acceptedAt: new Date(),
      brandScope: [],
    },
    update: { status: 'ACTIVE', roleId: roleId('workspace_owner'), acceptedAt: new Date() },
  });
  // Settings → General, as the prototype fills it: Cairo, for an Egyptian café.
  await platform.workspace.update({ where: { id: workspace.id }, data: { city: 'EG-C' } });
  const people: Record<'reem' | 'sara' | 'omar', string> = { reem: owner.id, sara: '', omar: '' };
  for (const [key, role] of [
    ['sara', 'approver'],
    ['omar', 'content_creator'],
  ] as const) {
    const user = await platform.user.create({
      data: {
        email: `${LATIN[key]}.${lang}-${run}@parity.brandspace.test`,
        name: words.people[key],
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
        timezone: 'Africa/Cairo',
        locale: lang === 'ar' ? 'AR' : 'EN',
      },
    });
    await platform.membership.create({
      data: {
        workspaceId: workspace.id,
        userId: user.id,
        roleId: roleId(role),
        status: 'ACTIVE',
        acceptedAt: new Date(),
        brandScope: [],
      },
    });
    people[key] = user.id;
  }

  /*
   * The pictures, as real files in the store the suite's servers read — the
   * directory `playwright.config.ts` pins for every process.
   */
  const store = createObjectStore({
    appEnv: process.env['APP_ENV'] ?? 'development',
    directory:
      process.env['BRANDSPACE_OBJECT_STORE_DIR'] ?? path.join(tmpdir(), 'brandspace-e2e-objects'),
  });

  const brandId = await withWorkspace(
    workspace.id,
    async (db) => {
      const brand = await db.brand.create({
        data: {
          workspaceId: workspace.id,
          name: words.business,
          slug: `reema-${lang}-${run}`,
          status: 'ACTIVE',
          // Free text: the industry catalogue is empty until an operator fills it.
          // Round 3 (D) — filed under the configured café industry, so its
          // observances reach the calendar.
          industry: PARITY_INDUSTRY,
          websiteUrl: 'https://reema.coffee',
          // The prototype café posts in both languages, Arabic first (round 3).
          defaultLocale: lang === 'ar' ? 'AR' : 'EN',
          supportedLocales: ['AR', 'EN'],
          colorPalette: ['#111114', '#FFD60A', '#F3E9D7'],
          // Gate 2b review — the prototype's publishing defaults (`pc.chans:
          // ['instagram', 'facebook'], time: '09:00'`), so the pair shows chosen
          // chips the way the prototype does.
          defaultPlatformKeys: ['instagram', 'facebook'],
          defaultPostTime: '09:00',
        },
      });

      const connectionIds: Record<string, string> = {};
      for (const [provider, name] of [
        ['INSTAGRAM', '@reema.cafe'],
        ['FACEBOOK', 'Reema Café'],
        ['TIKTOK', '@reemacafe'],
      ] as const) {
        const connection = await db.socialConnection.create({
          data: {
            workspaceId: workspace.id,
            brandId: brand.id,
            provider,
            externalAccountId: `parity-${lang}-${run}-${provider.toLowerCase()}`,
            displayName: name,
            targetKind: 'MOCK',
            status: 'ACTIVE',
            connectedByUserId: owner.id,
            connectedAt: new Date(Date.now() - 60 * DAY),
            // ROUND 3 (D) — each channel's last sync, as the sources row says it.
            lastSyncedAt: new Date(Date.now() - (provider === 'TIKTOK' ? 95 : 18) * 60_000),
          },
        });
        connectionIds[provider] = connection.id;
        // ROUND 3 (D) — the account readings' sync, which the freshness pill reads.
        const synced = new Date(Date.now() - (provider === 'TIKTOK' ? 95 : 18) * 60_000);
        for (const subjectType of ['ACCOUNT', 'POST'] as const) {
          for (const granularity of ['DAY', 'WEEK', 'MONTH'] as const) {
            await db.analyticsIngestionCursor.create({
              data: {
                workspaceId: workspace.id,
                brandId: brand.id,
                socialConnectionId: connection.id,
                provider,
                subjectType,
                granularity,
                lastCoveredPeriodEnd: new Date(
                  `${new Date().toISOString().slice(0, 10)}T00:00:00Z`,
                ),
                lastSucceededAt: synced,
                lastAttemptedAt: synced,
                freshness: 'FRESH',
              },
            });
          }
        }

        /*
         * ROUND 3 (D) — THE LAST 28 DAYS OF ACCOUNT READINGS for this channel:
         * reach and impressions with a gentle weekly rhythm, engagements at
         * the channel's rate, and new followers a day. Relative to the seed's
         * own day, so the Performance screen's default period is always full.
         *
         * ROUND 4 (4.5) — 56 DAYS, so the previous 28 are complete and Home's
         * change compares two whole periods. The last 28 days are the same
         * figures as before (the same formula over the same days). This file
         * only — the parity fixture, never a customer workspace.
         */
        const [base, rate, followers] = CHANNEL_FIGURES[provider] ?? [300, 3, 2];
        const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
        for (let back = 56; back >= 1; back -= 1) {
          const periodStart = new Date(today.getTime() - back * DAY);
          const periodEnd = new Date(periodStart.getTime() + DAY);
          const step = 28 - back;
          const wave = 1 + 0.18 * Math.sin(step / 2.2) + step * 0.006;
          const reach = Math.round(base * wave);
          const readings: ReadonlyArray<readonly [string, number]> = [
            ['reach', reach],
            ['impressions', Math.round(reach * 1.4)],
            ['engagements', Math.round((reach * rate) / 100)],
            ['follower_change', followers + (((step % 4) + 4) % 4)],
          ];
          for (const [metricKey, value] of readings) {
            await db.metricObservation.create({
              data: {
                workspaceId: workspace.id,
                brandId: brand.id,
                socialConnectionId: connection.id,
                provider,
                subjectType: 'ACCOUNT',
                subjectExternalId: connection.externalAccountId,
                metricKey,
                granularity: 'DAY',
                periodStart,
                periodEnd,
                value: BigInt(value),
                unit: 'COUNT',
                observedAt: periodEnd,
                sourceKind: 'MOCK',
                sourceVersion: 'e2e-parity-1',
                observationKey: fixtureObservationKey([
                  workspace.id,
                  connection.id,
                  'ACCOUNT',
                  connection.externalAccountId,
                  metricKey,
                  periodStart.toISOString(),
                ]),
              },
            });
          }
        }
      }

      const campaignDate = (days: number): Date =>
        new Date(`${new Date(Date.now() + days * DAY).toISOString().slice(0, 10)}T00:00:00Z`);
      const campaigns: Record<string, string> = {};
      for (const [key, objective, status, start, end, channels] of [
        ['autumn', 'TRAFFIC', 'ACTIVE', -8, 19, ['instagram', 'facebook', 'tiktok']],
        ['weekends', 'RETENTION', 'ACTIVE', -30, 60, ['instagram']],
        ['ramadan', 'AWARENESS', 'PLANNED', 120, 150, ['instagram', 'tiktok']],
        ['summer', 'ENGAGEMENT', 'COMPLETED', -95, -34, ['instagram', 'tiktok']],
      ] as const) {
        const row = await db.campaign.create({
          data: {
            workspaceId: workspace.id,
            brandId: brand.id,
            name: words.campaigns[key],
            objective,
            status,
            startDate: campaignDate(start),
            endDate: campaignDate(end),
            channels: [...channels],
            ownerUserId: owner.id,
            createdByUserId: owner.id,
          },
        });
        campaigns[key] = row.id;
      }

      const pictures: Record<string, string> = {};
      for (const [key, stops] of Object.entries(ART)) {
        const bytes = gradientPng(720, 720, 160, stops);
        const storageKey = `parity/${workspace.id}/${key}.png`;
        await store.put(storageKey, bytes, 'image/png');
        const asset = await db.asset.create({
          data: {
            workspaceId: workspace.id,
            brandId: brand.id,
            name: `${key}.png`,
            kind: 'IMAGE',
            mimeType: 'image/png',
            sizeBytes: bytes.length,
            width: 720,
            height: 720,
            storageKey,
            checksumSha256: createHash('sha256').update(bytes).digest('hex'),
            status: 'READY',
            scanStatus: 'CLEAN',
            scannedAt: new Date(),
            uploadedByUserId: owner.id,
          },
        });
        // The version row every upload writes: the storage meter counts the
        // object through it (B-1), so a picture without one stores nothing.
        await db.assetVersion.create({
          data: {
            workspaceId: workspace.id,
            brandId: brand.id,
            assetId: asset.id,
            versionNumber: 1,
            storageKey,
            checksumSha256: createHash('sha256').update(bytes).digest('hex'),
            mimeType: 'image/png',
            sizeBytes: bytes.length,
            width: 720,
            height: 720,
            scanStatus: 'CLEAN',
            createdByUserId: owner.id,
          },
        });
        pictures[key] = asset.id;
      }

      /*
       * Gate 2b review (4a) — THE BRAND'S LOGO, so Look & voice can be judged:
       * the prototype's mark (a yellow "R" on ink, `Main.dc.html` line 871) as
       * one real image, stored the way an upload is and set as the brand's
       * primary logo (D-193).
       */
      {
        const bytes = readFileSync(new URL('./parity-logo.png', import.meta.url));
        const storageKey = `parity/${workspace.id}/logo.png`;
        const checksum = createHash('sha256').update(bytes).digest('hex');
        await store.put(storageKey, bytes, 'image/png');
        const logo = await db.asset.create({
          data: {
            workspaceId: workspace.id,
            brandId: brand.id,
            name: 'reema-logo.png',
            kind: 'IMAGE',
            mimeType: 'image/png',
            sizeBytes: bytes.length,
            width: 256,
            height: 256,
            storageKey,
            checksumSha256: checksum,
            status: 'READY',
            scanStatus: 'CLEAN',
            scannedAt: new Date(),
            uploadedByUserId: owner.id,
          },
        });
        await db.assetVersion.create({
          data: {
            workspaceId: workspace.id,
            brandId: brand.id,
            assetId: logo.id,
            versionNumber: 1,
            storageKey,
            checksumSha256: checksum,
            mimeType: 'image/png',
            sizeBytes: bytes.length,
            width: 256,
            height: 256,
            scanStatus: 'CLEAN',
            createdByUserId: owner.id,
          },
        });
        await db.brand.update({
          where: { id: brand.id },
          data: { primaryLogoAssetId: logo.id },
        });
      }

      const postIds: Record<string, string> = {};
      for (const [index, post] of [...POSTS].entries()) {
        // The first post is the most recently changed, a second apart.
        const changedAt = new Date(Date.now() - index * 1_000);
        const when = post.day === null ? null : cairo(post.day, post.time);
        const caption = lang === 'ar' ? post.captionAr : post.caption;
        const locale = lang === 'ar' ? 'AR' : 'EN';
        const item = await db.contentItem.create({
          data: {
            workspaceId: workspace.id,
            brandId: brand.id,
            title: lang === 'ar' ? post.ar : post.en,
            contentType: post.type,
            primaryLocale: locale,
            status: post.status,
            campaignId: post.campaign ? (campaigns[post.campaign] ?? null) : null,
            pillar: PILLAR[post.key] ? PILLAR[post.key]![lang === 'ar' ? 1 : 0] : null,
            createdByUserId: people[post.author],
            createdAt: changedAt,
            updatedAt: changedAt,
          },
        });
        postIds[post.key] = item.id;
        const picture = pictures[post.art];
        // Gate 2b — the prototype's cover headlines (`c.overlay`), on the first slide.
        const overlay = OVERLAY[post.key]?.[lang === 'ar' ? 1 : 0];
        const variantIds: Record<string, string> = {};
        for (const platformKey of post.channels) {
          const variant = await db.contentVariant.create({
            data: {
              workspaceId: workspace.id,
              brandId: brand.id,
              contentItemId: item.id,
              platformKey,
              locale,
              body: caption,
              characterCount: caption.length,
              validationState: 'VALID',
              // A carousel carries three slides, as the prototype's (its 1/3 counter).
              assetIds: !picture
                ? []
                : post.type === 'CAROUSEL'
                  ? [
                      picture,
                      ...Object.values(pictures)
                        .filter((id) => id !== picture)
                        .slice(0, 2),
                    ]
                  : [picture],
              ...(picture && overlay ? { slides: [{ assetId: picture, headline: overlay }] } : {}),
            },
          });
          variantIds[platformKey] = variant.id;
        }
        if (when) {
          const slot = await db.calendarSlot.create({
            data: {
              workspaceId: workspace.id,
              brandId: brand.id,
              contentItemId: item.id,
              scheduledAtUtc: when.utc,
              scheduledLocalTime: `${when.date}T${post.time}`,
              timezone: 'Africa/Cairo',
              status: SLOT_STATUS[post.status] as never,
              platformKeys: [...post.channels],
              createdByUserId: people[post.author],
            },
          });
          /*
           * ROUND 3 (D) — A PUBLISHED POST WENT OUT ON EACH OF ITS CHANNELS:
           * one published job per channel, and the post's own readings (reach,
           * engagements, saves, clicks) a day after it went out — what the
           * Performance screen's posts table, pillars and best time read.
           */
          /*
           * Gate 2b review (4h) — THE PUBLISHING LOG READS JOBS. A scheduled
           * post waits as a pending job per channel and a failed post holds the
           * failed job the worker recorded, as the product writes them, so the
           * log's Queue and Failed tabs count what the rail's badge counts.
           */
          if (post.status === 'SCHEDULED' || post.status === 'FAILED') {
            for (const platformKey of post.channels) {
              const provider = platformKey.toUpperCase() as 'INSTAGRAM' | 'FACEBOOK' | 'TIKTOK';
              const connection = connectionIds[provider];
              const variantId = variantIds[platformKey];
              if (!connection || !variantId) continue;
              const failed = post.status === 'FAILED';
              await db.publishJob.create({
                data: {
                  workspaceId: workspace.id,
                  brandId: brand.id,
                  calendarSlotId: slot.id,
                  contentItemId: item.id,
                  contentVariantId: variantId,
                  socialConnectionId: connection,
                  provider,
                  status: failed ? 'FAILED' : 'PENDING',
                  idempotencyKey: `parity-${lang}-${run}-${post.key}-${platformKey}`,
                  scheduledAtUtc: when.utc,
                  maxAttempts: 3,
                  attemptCount: failed ? 3 : 0,
                  ...(failed
                    ? {
                        completedAt: when.utc,
                        failureClass: 'MEDIA_INVALID' as const,
                        failureCode: 'media_invalid',
                      }
                    : {}),
                  createdByUserId: people[post.author],
                },
              });
            }
          }
          if (post.status === 'PUBLISHED') {
            for (const platformKey of post.channels) {
              const provider = platformKey.toUpperCase() as 'INSTAGRAM' | 'FACEBOOK' | 'TIKTOK';
              const connection = connectionIds[provider];
              const variantId = variantIds[platformKey];
              if (!connection || !variantId) continue;
              await db.publishJob.create({
                data: {
                  workspaceId: workspace.id,
                  brandId: brand.id,
                  calendarSlotId: slot.id,
                  contentItemId: item.id,
                  contentVariantId: variantId,
                  socialConnectionId: connection,
                  provider,
                  status: 'PUBLISHED',
                  idempotencyKey: `parity-${lang}-${run}-${post.key}-${platformKey}`,
                  scheduledAtUtc: when.utc,
                  maxAttempts: 3,
                  attemptCount: 1,
                  completedAt: when.utc,
                  publishedAt: when.utc,
                  externalPostId: `parity-${lang}-${run}-${post.key}-${platformKey}`,
                  createdByUserId: people[post.author],
                },
              });
              const [base, rate] = CHANNEL_FIGURES[provider] ?? [300, 3, 2];
              const reach = Math.round(base * (2.2 + (post.key.length % 4) * 0.35));
              const engagements = Math.round((reach * rate) / 100);
              const figures: ReadonlyArray<readonly [string, number]> = [
                ['reach', reach],
                ['impressions', Math.round(reach * 1.4)],
                ['engagements', engagements],
                ['saves', Math.round(engagements * 0.18)],
                ['clicks', Math.round(engagements * 0.12)],
              ];
              const periodStart = new Date(`${when.date}T00:00:00Z`);
              const periodEnd = new Date(periodStart.getTime() + DAY);
              for (const [metricKey, value] of figures) {
                const subject = `parity-post-${post.key}-${platformKey}`;
                await db.metricObservation.create({
                  data: {
                    workspaceId: workspace.id,
                    brandId: brand.id,
                    socialConnectionId: connection,
                    provider,
                    subjectType: 'POST',
                    subjectExternalId: subject,
                    contentItemId: item.id,
                    metricKey,
                    granularity: 'DAY',
                    periodStart,
                    periodEnd,
                    value: BigInt(value),
                    unit: 'COUNT',
                    observedAt: periodEnd,
                    sourceKind: 'MOCK',
                    sourceVersion: 'e2e-parity-1',
                    observationKey: fixtureObservationKey([
                      workspace.id,
                      connection,
                      'POST',
                      subject,
                      metricKey,
                      periodStart.toISOString(),
                    ]),
                  },
                });
              }
            }
          }
        }
        if (post.status === 'IN_REVIEW') {
          await db.approval.create({
            data: {
              workspaceId: workspace.id,
              brandId: brand.id,
              contentItemId: item.id,
              requestedByUserId: people[post.author],
              assignedToUserId: people.reem,
              status: 'PENDING',
            },
          });
        }
        /*
         * THE BELL, as the prototype's: unread notes for the owner — each post
         * waiting for her review and the one that failed to publish.
         */
        if (post.status === 'IN_REVIEW' || post.status === 'FAILED') {
          await db.notification.create({
            data: {
              workspaceId: workspace.id,
              userId: people.reem,
              brandId: brand.id,
              templateKey: post.status === 'FAILED' ? 'publishing.failed' : 'approval.requested',
              payload: { itemTitle: lang === 'ar' ? post.ar : post.en },
              linkPath: post.status === 'FAILED' ? '/publishing' : '/approvals',
              idempotencyKey: `parity-${lang}-${run}-${post.key}`,
            },
          });
        }
      }
      /*
       * BRAND BRAIN as the prototype's café has it: three areas complete
       * (About the business, Strategy, Learnings), three under way (Audience,
       * Tone, Offers), one source read and six facts waiting for review.
       * Written directly, as the visual fixture writes its knowledge.
       */
      const knowledge: ReadonlyArray<readonly [string, string, string, string, string, string]> = [
        [
          'IDENTITY',
          'identity.what',
          'What we do',
          'ماذا نقدّم',
          'A neighbourhood café and roastery with brunch on weekends.',
          'كافيه ومحمصة في الحي، وبرانش في الويكند.',
        ],
        [
          'IDENTITY',
          'identity.promise',
          'Our promise',
          'وعدنا',
          'Fresh coffee roasted here every week.',
          'قهوة طازجة بتتحمص عندنا كل أسبوع.',
        ],
        [
          'IDENTITY',
          'identity.difference',
          'What makes us different',
          'ما يميّزنا',
          'We roast our own beans and bake every morning.',
          'بنحمص البن بنفسنا وبنخبز كل صباح.',
        ],
        [
          'IDENTITY',
          'identity.location',
          'Where we are',
          'مكاننا',
          'Zamalek, Cairo — open daily from 8 to midnight.',
          'الزمالك، القاهرة — مفتوح يوميًا من 8 لنص الليل.',
        ],
        [
          'STRATEGY',
          'goal.primary',
          'Main goal',
          'الهدف الرئيسي',
          'More visits on weekdays.',
          'زيارات أكتر في أيام الأسبوع.',
        ],
        [
          'STRATEGY',
          'strategy.pillars',
          'Content pillars',
          'محاور المحتوى',
          'Morning coffee, behind the bar, weekend brunch.',
          'قهوة الصبح، ورا البار، برانش الويكند.',
        ],
        [
          'LEARNINGS',
          'learning.best_format',
          'Best format',
          'أنجح شكل',
          'Short reels of the bar beat still photos.',
          'الريلز القصيرة من البار أنجح من الصور.',
        ],
        [
          'LEARNINGS',
          'learning.best_time',
          'Best time',
          'أنسب وقت',
          'Mornings, 8 to 10, get the most replies.',
          'الصبح من 8 لـ 10 بيجيب أكتر تفاعل.',
        ],
        [
          'AUDIENCE',
          'audience.primary',
          'Main customer',
          'العميل الأساسي',
          'Students and young professionals nearby.',
          'طلبة وشباب بيشتغلوا قريب.',
        ],
        [
          'TONE_OF_VOICE',
          'voice.formality',
          'How formal',
          'درجة الرسمية',
          'Warm and casual, never stiff.',
          'ودود وبسيط، من غير تكلّف.',
        ],
        // Gate 2b review (4a) — the voice words and one rule, as the
        // prototype's Voice card draws them.
        [
          'TONE_OF_VOICE',
          'voice.words',
          'Voice words',
          'كلمات الأسلوب',
          'Warm, Simple, Friendly, No exaggeration',
          'دافئ، بسيط، ودود، بلا مبالغة',
        ],
        [
          'DO_DONT',
          'do.price',
          'Say the price',
          'اذكر السعر',
          'Say the price whenever a post is about an offer.',
          'اذكر السعر في كل منشور عن عرض.',
        ],
        [
          'OFFERS',
          'offers.what',
          'What we sell',
          'ماذا نبيع',
          'Coffee, pastries and weekend brunch.',
          'قهوة ومخبوزات وبرانش الويكند.',
        ],
        [
          'OFFERS',
          'offers.prices',
          'Prices',
          'الأسعار',
          'Coffee from 45 EGP; brunch plates from 180 EGP.',
          'القهوة من 45 جنيه؛ أطباق البرانش من 180 جنيه.',
        ],
      ];
      for (const [area, itemKey, titleEn, titleAr, bodyEn, bodyAr] of knowledge) {
        await db.brandKnowledgeItem.create({
          data: {
            workspaceId: workspace.id,
            brandId: brand.id,
            area: area as never,
            memory:
              area === 'LEARNINGS' ? 'LEARNING' : area === 'STRATEGY' ? 'STRATEGY' : 'CANONICAL',
            origin: 'HUMAN',
            status: 'ACTIVE',
            itemKey,
            title: { en: titleEn, ar: titleAr },
            body: { en: bodyEn, ar: bodyAr },
            createdByUserId: owner.id,
            version: 1,
            lastReviewedAt: new Date(),
            reviewDueAt: new Date(Date.now() + 365 * DAY),
          },
        });
      }
      // One expired fact, as the prototype's ("1 expired fact"): a summer offer
      // whose "valid until" day has passed. It answers no key question.
      await db.brandKnowledgeItem.create({
        data: {
          workspaceId: workspace.id,
          brandId: brand.id,
          area: 'OFFERS' as never,
          memory: 'CANONICAL',
          origin: 'HUMAN',
          status: 'ACTIVE',
          itemKey: 'offers.summer_iced',
          title: { en: 'Summer iced latte', ar: 'آيس لاتيه الصيف' },
          body: {
            en: 'Iced latte at 55 EGP all summer.',
            ar: 'آيس لاتيه بـ 55 جنيه طول الصيف.',
          },
          createdByUserId: owner.id,
          version: 1,
          lastReviewedAt: new Date(Date.now() - 120 * DAY),
          reviewDueAt: new Date(Date.now() + 365 * DAY),
          validUntil: new Date(Date.now() - 30 * DAY),
        },
      });
      const guide = await db.brandSourceDocument.create({
        data: {
          workspaceId: workspace.id,
          brandId: brand.id,
          fileName: lang === 'ar' ? 'منيو الخريف.pdf' : 'Autumn menu.pdf',
          mimeType: 'application/pdf',
          byteSize: 1_024,
          checksum: `parity-${lang}-${run}-menu`,
          storageKey: `parity/${brand.id}/menu.pdf`,
          status: 'READY',
          pageCount: 6,
          chunkCount: 9,
          idempotencyKey: `parity-${lang}-${run}-menu`,
          uploadedByUserId: owner.id,
        },
      });
      const waiting: ReadonlyArray<readonly [string, string, string, string, number]> = [
        [
          'OFFERS',
          'offers.current',
          'Cinnamon latte is the autumn special.',
          'لاتيه القرفة هو مشروب الخريف.',
          920,
        ],
        [
          'AUDIENCE',
          'audience.need',
          'A quiet place to study with good coffee.',
          'مكان هادي للمذاكرة وقهوة حلوة.',
          880,
        ],
        [
          'TONE_OF_VOICE',
          'voice.words',
          'Say “our roastery”, not “the factory”.',
          'قول «المحمصة»، مش «المصنع».',
          860,
        ],
        [
          'PROOF_POINTS',
          'proof.results',
          'Rated 4.8 on maps by 1,200 people.',
          'تقييم 4.8 على الخرائط من 1,200 شخص.',
          810,
        ],
        [
          'DO_DONT',
          'dont.never',
          'Never post discounts above 30%.',
          'ماننشرش خصومات أكتر من 30%.',
          640,
        ],
        [
          'COMPETITORS',
          'competitors.main',
          'Two chain cafés opened on the same street.',
          'اتفتح فرعين لسلاسل كافيهات في نفس الشارع.',
          590,
        ],
      ];
      for (const [area, itemKey, en, ar, confidenceMilli] of waiting) {
        await db.brandKnowledgeCandidate.create({
          data: {
            workspaceId: workspace.id,
            brandId: brand.id,
            sourceDocumentId: guide.id,
            area: area as never,
            itemKey,
            extractedTitle: { en, ar },
            extractedBody: { en, ar },
            confidenceMilli,
            evidence: [{ locator: 'page 2', quote: en }],
            status: 'PENDING',
          },
        });
      }
      /*
       * ROUND 3 (D) — THE PROTOTYPE'S FOUR RULES (`R0`), with their runs and
       * one request waiting for a person: a post approved → the next free
       * slot (6 runs); weekly engagement drops → pause a campaign, which asks
       * first (1 run, waiting now); a review waiting 24 hours → remind the
       * reviewer (3 runs); nothing scheduled for 3 days → draft 3 ideas (off).
       */
      const ruleSpecs = [
        ['slot', 'CONTENT_APPROVED', 'SCHEDULE_NEXT_FREE_SLOT', {}, true, 6],
        [
          'pause',
          'WEEKLY_ENGAGEMENT_DROPPED',
          'PAUSE_CAMPAIGN',
          { campaignId: campaigns.weekends },
          true,
          0,
        ],
        ['remind', 'REVIEW_WAITING_24H', 'REMIND_REVIEWER', {}, true, 3],
        ['ideas', 'SCHEDULE_GAP', 'DRAFT_IDEAS', {}, false, 0],
      ] as const;
      const ruleIds: Record<string, string> = {};
      for (const [index, [key, triggerType, actionType, actionConfig, enabled, runs]] of [
        ...ruleSpecs,
      ].entries()) {
        const rule = await db.automationRule.create({
          data: {
            workspaceId: workspace.id,
            brandId: brand.id,
            name: words.rules[key],
            enabled,
            triggerType,
            triggerConfig: {},
            conditions: [],
            actionType,
            actionConfig: actionConfig as never,
            maxRunsPerDay: 0,
            createdByUserId: owner.id,
            armedAt: new Date(Date.now() - (40 - index) * DAY),
            // Newest first on the list: the prototype's first rule is the newest.
            createdAt: new Date(Date.now() - (index + 1) * 60_000),
          },
        });
        ruleIds[key] = rule.id;
        for (let n = 0; n < runs; n += 1) {
          const at = new Date(Date.now() - (n * 2 + 1) * DAY - (index + 1) * 3_600_000);
          await db.automationRun.create({
            data: {
              workspaceId: workspace.id,
              brandId: brand.id,
              ruleId: rule.id,
              status: 'SUCCEEDED',
              triggerType,
              actionType,
              conditionsHeld: true,
              idempotencyKey: `parity-${lang}-${run}-${key}-${n}`,
              correlationId: randomUUID(),
              startedAt: at,
              finishedAt: new Date(at.getTime() + 1_200),
              durationMs: 1_200,
              createdAt: at,
            },
          });
        }
      }
      await db.automationRun.create({
        data: {
          workspaceId: workspace.id,
          brandId: brand.id,
          ruleId: ruleIds.pause!,
          status: 'AWAITING_CONFIRMATION',
          triggerType: 'WEEKLY_ENGAGEMENT_DROPPED',
          actionType: 'PAUSE_CAMPAIGN',
          conditionsHeld: true,
          resourceType: 'Campaign',
          resourceId: campaigns.weekends!,
          confirmationExpiresAt: new Date(Date.now() + 20 * 3_600_000),
          idempotencyKey: `parity-${lang}-${run}-pause-waiting`,
          correlationId: randomUUID(),
          createdAt: new Date(Date.now() - 2 * 3_600_000),
        },
      });

      /*
       * ROUND 3 (D) — A NOTES THREAD ON ONE POST, as the prototype's Studio
       * shows it: Sara asks about the photo on the menu board, Reem answers.
       */
      const menuboard = postIds.menuboard;
      if (menuboard) {
        const thread = await db.noteThread.create({
          data: {
            workspaceId: workspace.id,
            brandId: brand.id,
            subjectType: 'CONTENT_ITEM',
            contentItemId: menuboard,
            createdByUserId: people.sara,
          },
        });
        for (const [index, [who, body]] of words.thread.entries()) {
          await db.note.create({
            data: {
              workspaceId: workspace.id,
              threadId: thread.id,
              authorUserId: people[who],
              body,
              createdAt: new Date(Date.now() - (90 - index * 30) * 60_000),
            },
          });
        }
      }

      return brand.id;
    },
    { prisma: tenant },
  );

  const ledger = new CreditLedgerService({ prisma: platform });
  await platform.creditWallet.upsert({
    where: { workspaceId: workspace.id },
    create: { workspaceId: workspace.id },
    update: {},
  });
  await ledger.grant({
    workspaceId: workspace.id,
    source: 'PROMOTIONAL_GRANT',
    credits: 1_200,
    reason: 'Parity fixture allowance',
    idempotencyKey: `parity-fixture-grant:${workspace.id}`,
  });

  /*
   * A PLAN WITH QUOTAS, as the prototype's café has one: the fixture catalogue's
   * higher plan (`tests/support/plans-fixture.ts`), its storage and seat
   * ceilings granted as workspace overrides — the Control Center's own lever —
   * and the storage the library has used so far. Fixture state only.
   */
  const periodStart = new Date(Date.now() - 12 * DAY);
  const periodEnd = new Date(Date.now() + 18 * DAY);
  await platform.workspaceSubscription.create({
    data: {
      workspaceId: workspace.id,
      planKey: 'fixture-growth',
      status: 'ACTIVE',
      billingInterval: 'MONTH',
      currency: 'USD',
      pinnedMonthlyMinor: 7900,
      pinnedAnnualMinor: 79000,
      pinnedMonthlyCredits: 1200,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
    },
  });
  // The wallet's next reset, as the scheduler stamps it at a period boundary
  // (`runCycleResetWithin`'s `nextResetAt: currentPeriodEnd`): Home's credits
  // card reads it for "of N · resets D".
  await platform.creditWallet.update({
    where: { workspaceId: workspace.id },
    data: { nextResetAt: periodEnd },
  });
  for (const [featureKey, limitValue] of [
    ['limit.storage_gb', 50],
    ['limit.seats', 8],
    // The prototype's plan card: 3 / 12 social accounts, n / 500 scheduled posts.
    ['limit.social_accounts', 12],
    ['limit.scheduled_posts', 500],
  ] as const) {
    await platform.workspaceOverride.create({
      data: {
        workspaceId: workspace.id,
        featureKey,
        enabled: true,
        limitValue,
        reason: 'Parity fixture: the prototype café plan',
        grantedByPlatformUserId: platformOwner.id,
      },
    });
  }
  /*
   * The storage counter holds what is actually stored, as the product keeps it
   * (every upload, delete and purge, and B-1's recompute): the SAME rows the
   * Media card's categories group. Review of 2a: a counter of 3.1 GB with a few
   * kilobytes behind it is a state the product cannot reach, and the card's
   * categories could not add up to it.
   */
  const stored = (await measureStorageBreakdown(platform, workspace.id)).reduce(
    (sum, row) => sum + row.bytes,
    0n,
  );
  await platform.usageCounter.create({
    data: {
      workspaceId: workspace.id,
      featureKey: 'limit.storage_gb',
      periodStart: new Date('2000-01-01T00:00:00Z'),
      periodEnd: new Date('2100-01-01T00:00:00Z'),
      usedValue: gigabytesFor(stored),
      usedBytes: stored,
    },
  });

  // The prototype's team rows read the brand each person works on ("Reema Café").
  await platform.membership.updateMany({
    where: { workspaceId: workspace.id, userId: { in: [people.sara, people.omar] } },
    data: { brandScope: [brandId] },
  });

  /*
   * GATE 2b — the prototype's strategy (`Main.dc.html` lines 1001–1060), as the
   * brand's ACCEPTED strategy: the objective, three pillars, the channel mix and
   * four weeks. Test data for the parity pair only, in this run's own workspace.
   */
  const both = (en: string, ar: string) => ({ en, ar });
  const why = (en: string, ar: string) => ({ evidenceRefs: [], text: both(en, ar) });
  await platform.insight.create({
    data: {
      workspaceId: workspace.id,
      brandId,
      type: 'STRATEGY',
      status: 'ACCEPTED',
      basis: 'BRAND_CONTEXT',
      title: both('Strategy', 'الاستراتيجية'),
      body: {
        summary: both('More weekday morning visits', 'زيارات صباحية أكثر في أيام الأسبوع'),
        pillars: [
          {
            name: both('Morning coffee', 'قهوة الصباح'),
            sharePercent: 40,
            rationale: why(
              'From Offers · Latte, flat white, cortado',
              'من العروض · لاتيه وفلات وايت وكورتادو',
            ),
          },
          {
            name: both('Seasonal offers', 'العروض الموسمية'),
            sharePercent: 35,
            rationale: why('From Offers · the autumn menu', 'من العروض · قائمة الخريف'),
          },
          {
            name: both('Behind the bar', 'خلف البار'),
            sharePercent: 25,
            rationale: why('From Story · the team and the beans', 'من القصة · الفريق والبن'),
          },
        ],
        channelMix: [
          {
            platformKey: 'instagram',
            sharePercent: 60,
            rationale: why('Most visits start here.', 'تبدأ معظم الزيارات من هنا.'),
          },
          {
            platformKey: 'tiktok',
            sharePercent: 25,
            rationale: why(
              'Short videos reach new people.',
              'الفيديوهات القصيرة تصل إلى أشخاص جدد.',
            ),
          },
          {
            platformKey: 'facebook',
            sharePercent: 15,
            rationale: why('Regulars and families.', 'الزبائن الدائمون والعائلات.'),
          },
        ],
        monthlyPlan: [1, 2, 3, 4].map((week) => ({
          weekNumber: week,
          theme: [
            both('Autumn menu launch', 'إطلاق قائمة الخريف'),
            both('Morning rituals', 'طقوس الصباح'),
            both('Meet the team', 'تعرّف على الفريق'),
            both('Weekend brunch', 'برانش نهاية الأسبوع'),
          ][week - 1],
          postsPlanned: 3,
          rationale: why('Built on this month’s goal.', 'مبنية على هدف هذا الشهر.'),
        })),
      },
      periodStart: new Date('2026-10-05T00:00:00Z'),
      periodEnd: new Date('2027-01-02T00:00:00Z'),
      reviewedAt: new Date('2026-10-05T08:00:00Z'),
      idempotencyKey: `e2e-parity-strategy-${lang}-${run}`,
    },
  });

  return { email: ownerEmail, password, workspaceId: workspace.id, workspaceSlug: slug, brandId };
}

/** The prototype's cover headlines (`Main.dc.html` line 2502), by post. */
const OVERLAY: Readonly<Record<string, readonly [string, string]>> = {
  teaser: ['Autumn offer', 'عرض الخريف'],
  brunch: ['Brunch is back', 'عودة البرانش'],
  menuboard: ['Autumn menu', 'قائمة الخريف'],
};

/** The café industry the parity brands are filed under (round 3, D). */
const PARITY_INDUSTRY = 'e2e-parity-cafe';

/**
 * ROUND 3 (D) — THE CALENDAR'S ★ CHIPS FOR AN EGYPTIAN CAFÉ, as the prototype
 * shows them in October: a public holiday for Egypt and two observances for a
 * café. They are operator configuration (D-329), so the fixture activates them
 * in the DEVELOPMENT environment through the configuration service — each
 * entry replaced rather than appended, in this month so a run any day shows
 * them. Test fixtures only.
 */
async function seedParityCalendar(platform: PrismaClient): Promise<void> {
  const owner = await platform.platformUser.findFirstOrThrow({
    where: { deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true, roleId: true },
  });
  const grants = await platform.rolePermission.findMany({
    where: { roleId: owner.roleId },
    include: { permission: true },
  });
  const actor = {
    platformUserId: owner.id,
    roleKey: 'platform_owner',
    mfaVerified: true,
    permissionKeys: grants.map((grant) => grant.permission.key),
  };
  const configuration = new ConfigurationService({ prisma: platform, cacheTtlMs: 0 });
  const activate = async (domain: 'content' | 'onboarding', payload: Record<string, unknown>) => {
    const draft = await configuration.createDraft(
      actor,
      domain,
      'DEVELOPMENT',
      'Parity fixture: the calendar moments of an Egyptian café.',
      payload,
    );
    const report = await configuration.validateDraft(actor, draft.id);
    if (!report.valid) {
      throw new Error(report.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '));
    }
    await configuration.activate(actor, draft.id, { acknowledgeHighImpact: true });
  };
  const month = new Date().toISOString().slice(0, 7);
  const ours = (name: { en?: string | undefined }) =>
    ['National Holiday (fixture)', 'International Coffee Day', 'World Food Day'].includes(
      name.en ?? '',
    );
  const content = await configuration.get('content', 'DEVELOPMENT');
  await activate('content', {
    ...content,
    calendar: {
      ...content.calendar,
      holidays: [
        ...content.calendar.holidays.filter((row) => !ours(row.name)),
        {
          country: 'EG',
          date: `${month}-06`,
          name: { en: 'National Holiday (fixture)', ar: 'عطلة وطنية (بيانات اختبار)' },
        },
      ],
      observances: [
        ...content.calendar.observances.filter((row) => row.industry !== PARITY_INDUSTRY),
        {
          industry: PARITY_INDUSTRY,
          date: `${month}-01`,
          name: { en: 'International Coffee Day', ar: 'اليوم العالمي للقهوة' },
        },
        {
          industry: PARITY_INDUSTRY,
          date: `${month}-16`,
          name: { en: 'World Food Day', ar: 'يوم الغذاء العالمي' },
        },
      ],
      // Gate 2b review (4d) — the prototype's publish-time chips (09:00, 13:00,
      // 18:00) are the times the calendar suggests for the workspace's country.
      suggestedTimes: [
        ...(content.calendar.suggestedTimes ?? []).filter((row) => row.country !== 'EG'),
        { country: 'EG', times: ['09:00', '13:00', '18:00'] },
      ],
    },
  });
  const onboarding = await configuration.get('onboarding', 'DEVELOPMENT');
  if (!onboarding.industries.some((industry) => industry.key === PARITY_INDUSTRY)) {
    await activate('onboarding', {
      ...onboarding,
      industries: [
        ...onboarding.industries,
        { key: PARITY_INDUSTRY, name: { en: 'Café', ar: 'مقهى' }, offersQuestionSet: 'food' },
      ],
    });
  }
}

async function main(): Promise<void> {
  refuseUnsafe();
  const platform = client('DATABASE_PLATFORM_URL');
  const tenant = client('DATABASE_URL');
  const run = randomUUID().slice(0, 6);
  try {
    await seedParityCalendar(platform);
    const fixture: E2eParityFixture = {
      en: await build(platform, tenant, 'en', run),
      ar: await build(platform, tenant, 'ar', run),
    };
    mkdirSync(path.dirname(E2E_PARITY_FILE), { recursive: true });
    writeFileSync(E2E_PARITY_FILE, JSON.stringify(fixture, null, 2), { mode: 0o600 });
    console.log(`Parity fixture ready: run ${run} (${POSTS.length} posts in each language)`);
  } finally {
    await platform.$disconnect();
    await tenant.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
