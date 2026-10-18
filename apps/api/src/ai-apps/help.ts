/**
 * D-566 — WHAT `get_help` SAYS, in English and Arabic.
 *
 * Fixed sentences about the screens and the flow, written once here; the live
 * facts (channels, post kinds, limits, whether approval comes before
 * scheduling) are filled from configuration by the tool, never typed into a
 * sentence. Nothing here invents a number. Arabic follows the glossary
 * (docs/ARABIC-GLOSSARY.md): منشور، مسودة، مراجعة، الموافقة، جدولة، نشر.
 */

export const HELP_TOPICS = [
  'overview',
  'posting',
  'channels',
  'approvals',
  'calendar',
  'performance',
  'limits',
] as const;
export type HelpTopic = (typeof HELP_TOPICS)[number];

type Copy = Readonly<Record<HelpTopic, { readonly title: string; readonly text: string }>>;

export const HELP_COPY: Readonly<Record<'en' | 'ar', Copy>> = {
  en: {
    overview: {
      title: 'What Brandspace is',
      text:
        'Brandspace is where this team plans, writes, reviews and publishes its social posts. ' +
        'Home shows what needs attention, Posts lists every post, the Studio is where a post is written, ' +
        'the Calendar shows when posts go out, Approvals holds posts waiting for a reviewer, ' +
        'Performance shows how published posts did, and Brand Brain holds the facts the brand has approved.',
    },
    posting: {
      title: 'Writing a post through an AI app',
      text:
        'You can write a post and save it as a draft for one brand, in one format, for one or more channels. ' +
        'You can give it a proposed time and send it for review. It then appears in Posts and, with a time, on the Calendar as proposed. ' +
        'You can change a draft, or a post a reviewer sent back, until it is sent for review again.',
    },
    channels: {
      title: 'Channels',
      text:
        'A channel is a social network a post goes to. Each channel has its own limits on caption length, hashtags and media, ' +
        'listed below. A format can only go to channels that carry it.',
    },
    approvals: {
      title: 'Review and approval',
      text:
        'A post sent for review waits in Approvals until a person approves it, asks for changes or rejects it. ' +
        'Only a person in Brandspace can approve, schedule or publish a post. An AI app never can.',
    },
    calendar: {
      title: 'The calendar',
      text:
        'A proposed time is a suggestion on the Calendar. Nothing is scheduled or published until a person schedules it in Brandspace. ' +
        'Times are in the workspace time zone.',
    },
    performance: {
      title: 'Performance',
      text:
        'Figures come from the social accounts connected to the brand. With no connected account there are no figures, ' +
        'and Brandspace says so instead of guessing.',
    },
    limits: {
      title: 'Limits',
      text:
        'Each connected AI app has a limit on how many requests it can make per minute. ' +
        'Posts follow each channel’s own limits. Using an AI app spends no Brandspace AI credits.',
    },
  },
  ar: {
    overview: {
      title: 'ما هو Brandspace',
      text:
        'Brandspace هو المكان الذي يخطط فيه هذا الفريق منشوراته على وسائل التواصل ويكتبها ويراجعها وينشرها. ' +
        'تعرض الرئيسية ما يحتاج إلى انتباهك، وتعرض المنشورات كل منشور، والاستوديو هو مكان كتابة المنشور، ' +
        'ويعرض التقويم مواعيد خروج المنشورات، وتضم الموافقات المنشورات التي تنتظر مراجِعًا، ' +
        'ويعرض الأداء نتائج المنشورات المنشورة، ويضم عقل العلامة المعلومات المعتمدة للعلامة التجارية.',
    },
    posting: {
      title: 'كتابة منشور من تطبيق ذكاء اصطناعي',
      text:
        'يمكنك كتابة منشور وحفظه مسودةً لعلامة تجارية واحدة، بصيغة واحدة، لقناة واحدة أو أكثر. ' +
        'يمكنك أن تقترح له موعدًا وأن ترسله للمراجعة. يظهر بعدها في المنشورات، ومع الموعد يظهر في التقويم مقترحًا. ' +
        'يمكنك تعديل المسودة، أو المنشور الذي أعاده المراجِع، حتى يُرسل للمراجعة مرة أخرى.',
    },
    channels: {
      title: 'القنوات',
      text:
        'القناة هي منصة التواصل التي يذهب إليها المنشور. لكل قناة حدودها لطول النص والوسوم والوسائط، ' +
        'وهي مذكورة أدناه. لا تذهب الصيغة إلا إلى القنوات التي تدعمها.',
    },
    approvals: {
      title: 'المراجعة والموافقة',
      text:
        'ينتظر المنشور المرسل للمراجعة في الموافقات حتى يوافق عليه شخص أو يطلب تعديلات أو يرفضه. ' +
        'لا يستطيع الموافقة على منشور أو جدولته أو نشره إلا شخص داخل Brandspace، ولا يستطيع ذلك تطبيق ذكاء اصطناعي أبدًا.',
    },
    calendar: {
      title: 'التقويم',
      text:
        'الموعد المقترح اقتراح في التقويم فقط. لا يُجدول شيء ولا يُنشر حتى يجدوله شخص داخل Brandspace. ' +
        'المواعيد بتوقيت مساحة العمل.',
    },
    performance: {
      title: 'الأداء',
      text:
        'تأتي الأرقام من حسابات التواصل المربوطة بالعلامة التجارية. إذا لم يكن هناك حساب مربوط فلا توجد أرقام، ' +
        'ويقول Brandspace ذلك بدلًا من التخمين.',
    },
    limits: {
      title: 'الحدود',
      text:
        'لكل تطبيق ذكاء اصطناعي متصل حد لعدد الطلبات في الدقيقة. ' +
        'تتبع المنشورات حدود كل قناة. استخدام تطبيق ذكاء اصطناعي لا يستهلك أي رصيد من Brandspace.',
    },
  },
};

export const WHAT_THE_AI_CAN_DO: Readonly<Record<'en' | 'ar', readonly string[]>> = {
  en: [
    'Read who you are, your workspace and your brands',
    'Read the facts Brand Brain has approved',
    'List and read posts, and read the calendar',
    'Write a draft, change a draft, give it a proposed time and send it for review',
    'Read performance and a period report',
  ],
  ar: [
    'معرفة من أنت ومساحة عملك وعلاماتك التجارية',
    'قراءة المعلومات المعتمدة في عقل العلامة',
    'عرض المنشورات وقراءتها وقراءة التقويم',
    'كتابة مسودة وتعديلها واقتراح موعد لها وإرسالها للمراجعة',
    'قراءة الأداء وتقرير عن فترة',
  ],
};

export const WHAT_ONLY_A_PERSON_CAN_DO: Readonly<Record<'en' | 'ar', readonly string[]>> = {
  en: [
    'Approve, request changes or reject a post',
    'Schedule or publish a post',
    'Delete or archive anything',
    'Connect or disconnect social accounts',
    'Change billing, the team or anyone’s permissions',
  ],
  ar: [
    'الموافقة على منشور أو طلب تعديلات أو رفضه',
    'جدولة منشور أو نشره',
    'حذف أي شيء أو أرشفته',
    'ربط حسابات التواصل أو إلغاء ربطها',
    'تغيير الفوترة أو الفريق أو صلاحيات أي شخص',
  ],
};
