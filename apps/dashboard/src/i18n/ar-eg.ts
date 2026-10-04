import type { MessageKey } from './messages';

/**
 * EGYPTIAN ARABIC — the interface Arabic of an Egyptian workspace (D-468, D-470).
 *
 * The interface Arabic follows the workspace's country: Egypt gets the
 * prototype's Egyptian Arabic, every other country the product's formal Arabic
 * (`messages.ar`) until its own dialect is written. `messages.ts` lays this file
 * over `ar` key by key (`dictionaryFor('ar-EG')`), so a key absent here falls
 * back to the formal string. Nothing else reads it.
 *
 * WHAT IS HERE: every Arabic string of `prototype-2026-09-27` that differs from
 * the formal one the product ships for the same key, written exactly as the
 * prototype writes it — same keys, same placeholders. A key absent here means
 * the prototype's Arabic and the formal Arabic agree, or the prototype has no
 * string for it.
 *
 * Collected screen by screen as each batch is ported; the batch that added an
 * entry is named in the comment above its group.
 */
export const arEgOverrides = {
  // Batch 1 — the shell (Main.dc.html lines 79–191).
  'nav.group.workspace': 'المساحة',
  'nav.collapseMenu': 'صغّر القايمة',
  'nav.expandMenu': 'كبّر القايمة',
  'topbar.switchLanguage': 'حوّل للإنجليزي',
  'topbar.menu.postSub': 'الكلام والتصميم والمعاينة في مكان واحد',
  'brand.selectedCaption': 'العلامة النشطة',
  'ws.menuNote':
    'كل مساحة ليها فريقها وبياناتها. عدد المساحات حسب خطة صاحب الحساب، والمالك بس هو اللي يعمل مساحة جديدة.',

  // Batch 1 — Home (Main.dc.html lines 192–328; copy at 2172, 2895, 4137, 4230, 4385, 4509).
  'home.greeting.afternoon': 'مساء الخير يا {name}',
  'home.p.description': 'نظرة سريعة على {brand}: إيه اللي محتاجك، وإيه اللي جاي.',
  'home.p.perfTitle': 'الأداء · آخر 28 يوم',
  'home.p.waitingApproval': 'مستنيين موافقتك',
  'home.p.kSchedSub': 'في الأسبوعين الجايين',
  'home.p.kWaiting': 'مستنية موافقتك',
  'home.p.kWaitingSub': 'مستنية قرارك',
  'home.p.kWaitingClear': 'مفيش حاجة مستنية',
  'home.p.kPub': 'اتنشرت',
  'home.p.kPubSub': 'آخر 28 يوم · {count} قنوات',
  'home.p.kCred': 'رصيد الذكاء',
  'home.p.kCredSub': 'من {total} · بيتجدد {date}',
  'home.p.kCredSubReset': 'بيتجدد {date}',
  'home.p.setupLeftOne': 'فاضل خطوة',
  'home.p.setupLeft': 'فاضل {count} خطوات',
  'home.p.stepBrain': 'علّم Brand Brain الأساسيات ({done}/{total})',
  'home.p.stepPost': 'اعمل أول منشور',
  'home.p.stepSchedule': 'جدول أول منشور',
  'home.p.stepSubmit': 'ابعت أول منشور للمراجعة',
  'home.p.stepTeam': 'ادعي فريقك',
  'home.p.allClear': 'تمام',
  'home.p.tag.brandBrain': 'Brand Brain',
  'home.p.tag.change': 'تغيّر',
  'home.p.upcoming': 'الجاي',
  'home.p.viewAll': 'الكل',
  'home.p.cpCardTitle': 'اسألني أو اختار حاجة أعملها:',
  'home.p.sug1': 'اعمل 3 بوستات للأسبوع الجاي',
  'home.p.sug2': 'ليه التفاعل قلّ؟',
  'home.p.noticedTitle': 'BrandSpace لاحظ',
  'home.p.noticedScope': 'من شغلك وأرقامك بس',
  'home.p.patternEvidence': 'من سجل الجدولة',
  'home.p.automateIt': 'اعملها أتمتة',
  'home.preference.accept': 'خليه الافتراضي',
  'home.preference.snooze': 'مش دلوقتي',
  'home.preference.dismiss': 'متقترحهاش تاني',
  'home.p.sub.approver': 'انت بتراجع وتوافق على منشورات الفريق.',
  'home.p.sub.creator': 'انت بتكتب المنشورات وتبعتها للمراجعة.',
  'home.p.sub.analyst': 'انت بتتابع الأداء وتطلع التقارير.',
  'home.p.sub.client': 'انت بتشوف الخطة والمنشورات الجاية وتدي رأيك.',
  'home.p.s.queue': 'مستني مراجعتك',
  'home.p.s.queueSub': 'منشورات الفريق اللي محتاجة موافقتك.',
  'home.p.s.draftsSub': 'اللي لسه شغال عليه.',
  'home.p.s.sent': 'بعته للمراجعة',
  'home.p.s.sentSub': 'مستني رد المراجع.',
  'home.p.s.mineSched': 'متجدول',
  'home.p.s.mineSchedSub': 'منشوراتك اللي هتنزل.',
  'home.p.s.up': 'الجاي',
  'home.p.s.upSub': 'اللي هينزل الأيام الجاية.',
  'home.p.s.top': 'أحسن المنشورات',
  'home.p.s.topSub': 'حسب الوصول، من الحسابات المربوطة.',
  'home.p.s.fb': 'مستني رأيك',
  'home.p.s.fbSub': 'منشورات عايزينك تشوفها قبل ما تنزل.',
  'home.p.s.empty': 'مفيش حاجة هنا دلوقتي.',
} as const satisfies Partial<Record<MessageKey, string>>;
