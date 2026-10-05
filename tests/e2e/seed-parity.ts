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
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { WorkspaceAdminService, hashPassword } from '@brandspace/auth';
import { CreditLedgerService } from '@brandspace/entitlements';
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
  const ownerEmail = `e2e-parity-${lang}-${run}@brandspace.test`;

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
  const workspace = await platform.workspace.findUniqueOrThrow({ where: { slug } });

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
        email: `e2e-parity-${lang}-${run}-${key}@brandspace.test`,
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
          industry: lang === 'ar' ? 'مقهى' : 'Café',
          websiteUrl: 'https://reema.coffee',
          // The prototype café posts in both languages, Arabic first (round 3).
          defaultLocale: lang === 'ar' ? 'AR' : 'EN',
          supportedLocales: ['AR', 'EN'],
          colorPalette: ['#111114', '#FFD60A', '#F3E9D7'],
        },
      });

      for (const [provider, name] of [
        ['INSTAGRAM', '@reema.cafe'],
        ['FACEBOOK', 'Reema Café'],
        ['TIKTOK', '@reemacafe'],
      ] as const) {
        await db.socialConnection.create({
          data: {
            workspaceId: workspace.id,
            brandId: brand.id,
            provider,
            externalAccountId: `parity-${lang}-${run}-${provider.toLowerCase()}`,
            displayName: name,
            targetKind: 'MOCK',
            status: 'ACTIVE',
            connectedByUserId: owner.id,
            connectedAt: new Date(),
          },
        });
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
        pictures[key] = asset.id;
      }

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
            createdByUserId: people[post.author],
            createdAt: changedAt,
            updatedAt: changedAt,
          },
        });
        const picture = pictures[post.art];
        for (const platformKey of post.channels) {
          await db.contentVariant.create({
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
            },
          });
        }
        if (when) {
          await db.calendarSlot.create({
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
  await platform.usageCounter.create({
    data: {
      workspaceId: workspace.id,
      featureKey: 'limit.storage_gb',
      periodStart: new Date('2000-01-01T00:00:00Z'),
      periodEnd: new Date('2100-01-01T00:00:00Z'),
      usedValue: 3,
      usedBytes: BigInt(3_100_000_000),
    },
  });

  // The prototype's team rows read the brand each person works on ("Reema Café").
  await platform.membership.updateMany({
    where: { workspaceId: workspace.id, userId: { in: [people.sara, people.omar] } },
    data: { brandScope: [brandId] },
  });

  return { email: ownerEmail, password, workspaceId: workspace.id, workspaceSlug: slug, brandId };
}

async function main(): Promise<void> {
  refuseUnsafe();
  const platform = client('DATABASE_PLATFORM_URL');
  const tenant = client('DATABASE_URL');
  const run = randomUUID().slice(0, 6);
  try {
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
