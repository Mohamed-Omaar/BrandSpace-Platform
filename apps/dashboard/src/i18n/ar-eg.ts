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

  // Batch 2 — Calendar (Main.dc.html lines 599–660; copy at 2187 and 2660–2740).
  'calendar.subtitle': 'اضغط على أي يوم فاضي عشان تعمل منشور فيه.',
  'calendar.agenda': 'جدول',
  'calendar.today': 'النهارده',
  'calendar.weekN': 'أسبوع {n}',
  'calendar.newPostDay': 'منشور جديد في اليوم ده',
  'calendar.readyTitle': 'مسودات من غير ميعاد',
  'calendar.noReady': 'مفيش مسودات من غير ميعاد.',
  'calendar.agendaEmpty': 'مفيش منشورات في الشهر ده.',
  'calendar.hint': 'اسحب أي منشور ليوم تاني عشان تغيّر ميعاده. الساعة بتفضل زي ما هي.',
  'calendar.pickDay': 'اختار يوم جديد لـ «{title}»',
  'calendar.pop.open': 'افتح',
  'calendar.pop.move': 'انقله ليوم تاني',
  'content.status.IN_REVIEW': 'في المراجعة',
  'content.status.SCHEDULED': 'مجدولة',
  'content.status.PUBLISHED': 'منشورة',
  'content.status.FAILED': 'متعثرة',

  // Batch 2 — Posts, the content library (Main.dc.html lines 538–566; copy at 2185, 2186, 2573).
  'content.p.continue': 'كمّل',
  'content.p.review': 'راجِع',
  'content.p.retry': 'أعد المحاولة',
  'content.menu.addCampaign': 'ضيفه لحملة',
  'content.menu.changeCampaign': 'غيّر الحملة',

  // Batch 2 — Studio (Main.dc.html lines 329–537; copy at 2176–2177, 2311, 2324–2326, 2577).
  'studio.editing': 'بتعدّل',
  'studio.postTo': 'انشر على',
  'studio.when': 'ميعاد النشر',
  'studio.whenTitle': 'هينزل إمتى؟',
  'studio.whenUnset': 'لسه متجدولش',
  'studio.whenDone': 'تمام',
  'studio.tabWords': 'الكلام',
  'studio.checks': 'هينزل صح؟',
  'studio.fix': 'محتاج تعديل',
  'studio.row.tags': 'الهاشتاجات',
  'studio.tagsNone': 'لسه مفيش هاشتاجات.',
  'studio.tagRemove': 'شيل {tag}',

  // Batch 3 — Approvals (Main.dc.html lines 567–598; copy at 2183).
  'approvals.subtitle': 'المنشورات اللي مستنية قرارك، بمعاينتها كاملة.',
  'approvals.tabs.forMe': 'مستني قراري',
  'approvals.tabs.sent': 'أنا بعته',
  'approvals.queueEmptyTitle': 'مفيش حاجة مستنياك.',
  'approvals.decisionNote': 'ملاحظة',

  // Batch 3 — Campaigns (Main.dc.html lines 1159–1236; copy at 2433, 2929, 3658–3669).
  'campaigns.hero.line': '{running} شغالة · {planned} مخططة · {ended} انتهت',
  'campaigns.hero.endsIn': '{name} بتخلص بعد {days} يوم',
  'campaigns.hero.endsToday': '{name} بتخلص النهارده',
  'campaigns.hero.startsIn': '{name} بتبدأ بعد {days} يوم',
  'campaigns.hero.none': 'مفيش حملة شغالة دلوقتي',
  'campaigns.hero.running': '«{name}» شغالة دلوقتي',
  'campaigns.hero.month': 'بوستات الحملات الشهر ده',
  'campaigns.hero.monthSub': '{scheduled} مجدولة · {published} اتنشرت',
  'campaigns.card.noPosts': 'لسه مفيش بوستات',
  'campaigns.card.published': 'اتنشر',
  'campaigns.card.allPublished': 'اتنشر كله',
  'campaigns.room.edit': 'عدّل',
  'campaigns.best.label': 'أنجح حملة',

  // Batch 3 — Media (Main.dc.html lines 1237–1284).
  'assets.media.generate': 'اعمل بالذكاء',
  'assets.media.use': 'استخدمه',
  'assets.media.ai': 'بالذكاء',
  'assets.media.filters': 'فلاتر',
  'analytics.sourcesNote':
    'الأرقام دي جاية من إحصائيات كل منصة بعد الربط. لو منصة مش بتنشر رقم معيّن هتشوف السبب، مش صفر.',
  'analytics.vsPrev': 'مقارنة بالفترة اللي قبلها',
  'analytics.dayByDay': 'يوم بيوم',
  'analytics.tablesNote': 'كل الأرقام دي في ملف الـ CSV.',
  'bb.pageSub': 'كل اللي المنصة عارفاه عن علامتك، وبتكتب منه كل حاجة.',
  'bb.lead':
    'كل مسودة وكل فكرة بتتكتب من المعلومات المعتمدة هنا بس. كل ما تكمّل مجالات أكتر، المسودات بتقرب من صوتك.',
  'bb.askBrand': 'اسأل البراند',
  'bb.uploadFiles': 'ارفع ملفات',
  'bb.missingSub': 'جاوب على دول والمسودات هتبقى أدق.',
  'bb.factsWaiting': '{count} معلومة مستنية مراجعتك',
  'bb.acceptHigh': 'اقبل الواثق منها',
  'bb.oneByOne': 'راجعها واحدة واحدة',
  'bb.bulkTitle': 'هيتقبل {count} معلومات بثقة عالية:',
  'bb.bulkOk': 'اقبلهم',
  'bb.bulkNone': 'مفيش معلومات بثقة عالية دلوقتي. راجعهم واحدة واحدة.',
  'bb.rvLeft': 'فاضل {count} معلومات',
  'bb.rvLeftOne': 'فاضل معلومة واحدة',
  'bb.rvArea': 'هتتحفظ في',
  'bb.rvSaid': 'اللي لقيناه في المصدر',
  'bb.rvOld': 'المعتمدة دلوقتي',
  'bb.rvClose': 'قفل المراجعة',
  'bb.rvDone': 'خلصت المراجعة',
  'bb.rvDoneSub': 'كل المعلومات المستنية اتراجعت. هنبلغك لما يجي جديد.',
  'bb.rvBack': 'رجوع للمعرفة',
  'bb.confWhy': 'قد إيه BrandSpace متأكد إن المصدر بيقول كده',
  'bb.waitingReview': 'مستنية مراجعتك',
  'bb.usedBy': 'بيستخدمها: المسودات، الاستراتيجية، المساعد، والكلام مع العلامة.',
  'bb.chatSubFacts': 'بيجاوب من {count} معلومة معتمدة',
  'bb.voice.sub': 'ده اللي الذكاء بيقراه قبل ما يكتب أي كلمة.',
  'bb.orbHint': 'دوس على أي نقطة تفتح مجالها، أو على المنتصف تسأل',

  // Batch 6 — Automations (Main.dc.html lines 1304–1334, 1556–1569; copy at 3779).
  'automations.form.when': 'لما',
  'automations.form.then': 'اعمل',
  'automations.asksFirst': 'بيستأذنك',
  'automations.usesCredits': 'بيصرف رصيد',
  'automations.more': 'أكتر',
  'automations.notifLink':
    'تنبيهاتك انت (منشور ما اتنشرش، موافقات، الرصيد، مراجعة Brand Brain) من الإعدادات ← الإشعارات',

  // Batch 6 — Settings (Main.dc.html lines 1337–1340; copy at 3909).
  'settings.group.workspace': 'المساحة',
  'settings.group.people': 'الناس',
  'settings.group.aiBilling': 'الذكاء والفوترة',

  // Batch 6 — Plan & billing (Main.dc.html lines 1445–1463; copy at 3909).
  'billing.changePlan': 'غيّر الخطة',
} as const satisfies Partial<Record<MessageKey, string>>;
