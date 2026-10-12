/**
 * PR F, Q11 — THE BETA'S LEGAL DOCUMENTS: a FIRST DRAFT, written from what the
 * code actually does (the data it stores, the processors it calls, the cookies
 * it sets, the windows its configuration declares) and NOT reviewed by a
 * lawyer. Every page says so at the top, and the Control Center's readiness
 * check reads "draft, legal review pending" until the owner marks the
 * documents reviewed (`onboarding.legalDocuments[].reviewed`).
 *
 * EVERY `[BRACKETED]` PHRASE IS A PLACEHOLDER the owner must fill — the legal
 * entity, its address, the governing law and the rest. The page draws them
 * highlighted, so an unfilled one cannot pass for real text.
 *
 * THE VERSION is the one sign-up asks a person to accept
 * (`onboarding.legalDocuments[].version` in `docs/production-config/
 * onboarding.json`); publishing a new text means raising both.
 *
 * Retention windows marked "currently" are configuration (`onboarding`,
 * `assets`, `brand-brain`, `copilot`); the text says so rather than promising a
 * number an owner can change.
 */

export const LEGAL_VERSION = '2026-10 beta draft';

export type LegalDocumentKey = 'terms' | 'privacy' | 'data-deletion';
export type LegalBlock = string | { readonly list: readonly string[] };

export interface LegalSection {
  readonly id: string;
  readonly heading: string;
  readonly body: readonly LegalBlock[];
}

export interface LegalDocument {
  readonly title: string;
  readonly summary: string;
  readonly sections: readonly LegalSection[];
}

/** The routes, in the order the page's own tabs list them. */
export const LEGAL_DOCUMENT_KEYS: readonly LegalDocumentKey[] = [
  'terms',
  'privacy',
  'data-deletion',
];

const SUPPORT = 'support@brandspace.cc';
const PRIVACY = 'privacy@brandspace.cc';

const en: Record<LegalDocumentKey, LegalDocument> = {
  terms: {
    title: 'Terms of Service',
    summary:
      'The rules for using Brandspace during its closed beta. Please read them before you create an account.',
    sections: [
      {
        id: 'who',
        heading: 'Who we are',
        body: [
          `Brandspace is operated by [LEGAL ENTITY NAME], [REGISTERED ADDRESS] (“Brandspace”, “we”, “us”). You can reach us at ${SUPPORT}.`,
          'These terms apply to everyone who creates an account or is invited to a workspace.',
        ],
      },
      {
        id: 'beta',
        heading: 'The closed beta',
        body: [
          {
            list: [
              'Brandspace is in a closed beta. You use it on a free trial. No payment is taken and no payment details are asked for.',
              'The trial lasts the number of days shown when you sign up. While payments are not available, nothing is locked when the trial ends. We will tell you before that changes.',
              'Some features are not active in the beta: the AI features (writing, image generation, the Copilot and explanations) and connecting social media accounts, scheduling and publishing. Where a feature is not available, the product says so.',
              'The service is provided “as is” and “as available”, without any promise that it will be uninterrupted, free of errors or fit for a particular purpose. Features may change, pause or be removed during the beta.',
              'We announce changes to these terms by email or in the product before they take effect. If you keep using Brandspace after a change takes effect, the new terms apply.',
            ],
          },
        ],
      },
      {
        id: 'account',
        heading: 'Your account',
        body: [
          {
            list: [
              'Give accurate details, keep your password to yourself and turn on two-step verification if you can.',
              'You are responsible for what happens under your account. Tell us at once if you think someone else has used it.',
              'A workspace owner decides who is invited and which role each member has, and is responsible for the members they invite.',
              'You must be at least [MINIMUM AGE] years old and able to accept these terms, for yourself or for the organisation you represent.',
            ],
          },
        ],
      },
      {
        id: 'content',
        heading: 'Your content',
        body: [
          'You keep ownership of everything you add to Brandspace: brand details, Brand Brain knowledge, documents, media, posts, notes and the rest.',
          'You allow us to store, process and show that content only to provide the service to you and to the people you invite. We do not sell it and do not use it for advertising.',
          'You confirm that you have the right to use everything you upload or write in Brandspace.',
        ],
      },
      {
        id: 'uploads',
        heading: 'Uploaded files and malware scanning',
        body: [
          'During the beta, uploaded files are not scanned for malware. You upload and open files at your own risk.',
          {
            list: [
              'Only the file types the product accepts can be uploaded, and the size limits shown beside each upload control apply.',
              'An uploaded file is always delivered as a download. Brandspace never opens it as a web page.',
              'Open only files you trust, and keep your own device protected.',
            ],
          },
          'If we switch file scanning on, this section will be updated before it changes how uploads work.',
        ],
      },
      {
        id: 'use',
        heading: 'Acceptable use',
        body: [
          'Do not use Brandspace to:',
          {
            list: [
              'break the law or anyone’s rights, including copyright and privacy;',
              'upload malware or anything designed to harm a device or a person;',
              'try to reach another workspace’s data, test or bypass our security, or overload the service;',
              'send spam or content that harasses, threatens or deceives;',
              'resell or share access to the service without our written permission.',
            ],
          },
          'We may remove content or suspend an account that breaks these rules. Where we can, we will tell you first.',
        ],
      },
      {
        id: 'data',
        heading: 'Your data during the beta',
        body: [
          'How we handle personal data is described in the Privacy Policy. We keep backups, but during the beta please keep your own copies of files that matter to you.',
        ],
      },
      {
        id: 'ending',
        heading: 'Ending',
        body: [
          {
            list: [
              'You can stop using Brandspace at any time. A workspace owner can delete the workspace from Settings → Data controls; see the Data deletion page.',
              'We may end the beta or close an account. Unless there is a security or legal reason, we will give you [NOTICE PERIOD] notice and a way to take your files.',
            ],
          },
        ],
      },
      {
        id: 'liability',
        heading: 'Liability',
        body: [
          'As far as the law allows, [LEGAL ENTITY NAME] is not liable for indirect or consequential loss, or for loss of profits or data, arising from your use of the beta. Our total liability is limited to [LIABILITY CAP]. Nothing in these terms limits liability that the law does not allow to be limited.',
        ],
      },
      {
        id: 'law',
        heading: 'Governing law',
        body: [
          'These terms are governed by the laws of [GOVERNING LAW]. Disputes are settled by the courts of [JURISDICTION].',
        ],
      },
      {
        id: 'contact',
        heading: 'Contact',
        body: [`Questions about these terms: ${SUPPORT}.`],
      },
    ],
  },
  privacy: {
    title: 'Privacy Policy',
    summary:
      'What Brandspace collects, why, who processes it, how long it is kept and how you control it.',
    sections: [
      {
        id: 'who',
        heading: 'Who is responsible',
        body: [
          `[LEGAL ENTITY NAME], [REGISTERED ADDRESS], is responsible for the personal data described here. Contact: ${PRIVACY}.`,
          'The content a team adds to a workspace is decided by that workspace’s owner. We process it to provide the service to them.',
        ],
      },
      {
        id: 'collect',
        heading: 'What we collect and why',
        body: [
          {
            list: [
              'Account: your name, email address, password (stored only as a one-way hash), language and time zone, and your two-step verification settings (the secret is encrypted; recovery codes are stored only as hashes). Why: to create your account and keep it secure.',
              'Sign-in and security records: for each session, when it started, its IP address and browser; and for the legal documents you accepted, which version, when, and from which IP address and browser. Why: security, preventing abuse, and proof of acceptance.',
              'Workspace and brands: the workspace’s name, country, time zone, city (Egypt only), currency and language; each brand’s name, website, industry, colours, logo, fonts and publishing languages. Why: to set up and run your workspace.',
              'Brand Brain: the facts you enter or accept, and the documents you upload to it. We read a document’s text to suggest facts. Why: to keep your brand’s knowledge in one place.',
              'Media: the images, videos, audio, documents and fonts you upload. Why: to store them and use them in your content.',
              'Content and teamwork: posts, drafts, the calendar, campaigns, strategy, approvals, notes and mentions, and automations. Why: this is the service.',
              'Team: the names and email addresses of the people invited, and their roles. Why: so your team can work together.',
              'Usage: your plan, trial dates, usage counts, and credit balance and movements. Why: to apply your plan’s limits.',
              'Activity log: who did what and when in a workspace (for example, “a post was approved”), never the contents of files. Why: accountability and security.',
              'Emails: the address and the message for each email we send (verification, password reset, invitations, notifications). Why: to reach you about your account.',
              'Technical logs: errors and service events, with passwords, keys and tokens removed. Why: to keep the service working.',
            ],
          },
          'We do not sell personal data and do not use it for advertising. There are no advertising or analytics trackers in Brandspace.',
        ],
      },
      {
        id: 'processors',
        heading: 'Who processes your data',
        body: [
          {
            list: [
              'Railway: hosts the application, its PostgreSQL database and its job queue (Redis). It holds all the data the service stores. Region: [HOSTING REGION].',
              'Cloudflare R2: stores the files you upload. [CONFIRM STORAGE PROVIDER AND REGION]',
              'Amazon Web Services (KMS): manages the encryption keys that protect stored secrets, such as two-step verification secrets. It receives encryption requests, not your content.',
              'Resend: sends our emails. It receives each recipient’s email address and the message.',
            ],
          },
          'Not active in the beta:',
          {
            list: [
              'AI providers. No content is sent to any AI model during the beta. Before AI features are switched on, this policy will name the provider and say what it receives.',
              'File scanning. No scanner is used during the beta. If Scanii is switched on, each uploaded file will be sent to it for a malware check; Scanii deletes the file after the check and keeps a record of the result for up to 400 days.',
              'Social platforms. No social account can be connected during the beta. Before connecting Facebook, Instagram or TikTok becomes available, this policy will say what each platform receives and what we receive from it.',
            ],
          },
        ],
      },
      {
        id: 'cookies',
        heading: 'Cookies and browser storage',
        body: [
          'Brandspace sets only the cookies it needs to work. There are no advertising or analytics cookies.',
          {
            list: [
              '__Host-bs_customer_session: keeps you signed in. Lasts up to 12 hours.',
              'bs_signup_draft: keeps your name, email and time zone if a sign-up is refused, so you do not retype them (never your password). Lasts 2 minutes.',
              'bs_brand: remembers which brand you were working on. Lasts up to 1 year.',
              'bs_mfa_recovery_codes: shows your new recovery codes once after you set up two-step verification. Lasts 5 minutes.',
            ],
          },
          'In your browser’s own storage, Brandspace remembers hints you dismissed and keeps an unfinished draft while you work in a tab. You can clear both in your browser at any time.',
        ],
      },
      {
        id: 'retention',
        heading: 'How long we keep data',
        body: [
          {
            list: [
              'Account and workspace data: while the account or workspace exists.',
              'A deleted workspace: removed after a grace period (currently 30 days), during which its owner can cancel the deletion.',
              'Deleted files: removed from storage after currently 30 days.',
              'Uploads that were never finished: removed after currently 24 hours.',
              'Brand Brain chat and Copilot conversations: currently 90 days (these features are not active in the beta).',
              'Backups: [BACKUP RETENTION PERIOD].',
              'Activity log and security records: [AUDIT LOG RETENTION PERIOD].',
            ],
          },
          'Periods marked “currently” are settings. If we change one, we update this page.',
        ],
      },
      {
        id: 'isolation',
        heading: 'Your workspace is kept separate',
        body: [
          'Every workspace’s data is kept apart from every other workspace’s. The separation is checked twice: by the application, and again by rules inside the database itself. A person in one workspace cannot see, search, count or export another workspace’s data.',
        ],
      },
      {
        id: 'security',
        heading: 'Security',
        body: [
          {
            list: [
              'Every connection is encrypted (HTTPS).',
              'Passwords are stored only as one-way hashes. Secrets are encrypted with authenticated encryption, and their keys are held in a key management service.',
              'Two-step verification is available for every account.',
              'Access to production systems is restricted, and actions in a workspace are recorded in its activity log.',
              'Uploaded files are always delivered as downloads, never opened as web pages.',
            ],
          },
          'No system is perfectly secure. If a breach affects your data, we will tell you without undue delay.',
        ],
      },
      {
        id: 'rights',
        heading: 'Your rights',
        body: [
          'You can ask to see, correct, receive a copy of, or delete your personal data, and you can object to or ask us to limit how we use it.',
          {
            list: [
              'In the product: reset your password from the sign-in page (“Forgot password?”), manage two-step verification in Settings → Security, and, as a workspace owner, delete the workspace in Settings → Data controls.',
              `Everything else: email ${PRIVACY} from your account’s address. We answer within [RESPONSE PERIOD].`,
            ],
          },
          'You may also complain to [SUPERVISORY AUTHORITY].',
        ],
      },
      {
        id: 'transfers',
        heading: 'Where your data is',
        body: [
          'Your data is stored in [HOSTING REGION]. Our providers may process it in other countries under their own safeguards. [INTERNATIONAL TRANSFER BASIS]',
        ],
      },
      {
        id: 'children',
        heading: 'Children',
        body: ['Brandspace is not meant for anyone under [MINIMUM AGE].'],
      },
      {
        id: 'changes',
        heading: 'Changes to this policy',
        body: ['We announce changes by email or in the product before they take effect.'],
      },
      {
        id: 'contact',
        heading: 'Contact',
        body: [`Privacy questions and requests: ${PRIVACY}.`],
      },
    ],
  },
  'data-deletion': {
    title: 'Data deletion',
    summary: 'How to delete your data from Brandspace, and what happens when you do.',
    sections: [
      {
        id: 'workspace',
        heading: 'Delete a workspace',
        body: [
          'A workspace owner can delete the whole workspace: Settings → Data controls → Delete workspace, then type the workspace’s name to confirm.',
          {
            list: [
              'The workspace is scheduled for deletion. During the grace period (currently 30 days) the owner can cancel.',
              'After that, the workspace and everything in it is deleted: brands, Brand Brain, media, posts, the calendar, campaigns, notes, and every member’s access to it. Its files are removed from storage.',
            ],
          },
        ],
      },
      {
        id: 'account',
        heading: 'Delete your account',
        body: [
          `Email ${PRIVACY} from your account’s address and ask for your account to be deleted. We confirm it is you, then remove your account and your personal details within [RESPONSE PERIOD].`,
          'If you own a workspace, delete it first or ask us to hand it to another member.',
        ],
      },
      {
        id: 'items',
        heading: 'Delete single items',
        body: [
          'You can delete files, posts, notes and other items in the product at any time. A deleted file is removed from storage after currently 30 days.',
        ],
      },
      {
        id: 'social',
        heading: 'Connected social accounts (Facebook, Instagram, TikTok)',
        body: [
          'Connecting social accounts is not available during the beta. When it is:',
          {
            list: [
              'Disconnecting an account in Brandspace, or removing Brandspace from the platform’s own settings, deletes the access tokens we hold for it and the data we received from that platform, such as post metrics.',
              'Your own content in Brandspace (the drafts, posts and files you created) is kept until you delete it.',
              `To confirm a deletion, email ${PRIVACY} with your account’s identifier on that platform. We reply with a confirmation code.`,
            ],
          },
        ],
      },
      {
        id: 'kept',
        heading: 'What we keep',
        body: [
          'Some records are kept after a deletion because we must keep them: the activity log entries and the records of accepted legal documents, for [RECORD RETENTION PERIOD]. Backups that still contain deleted data expire after [BACKUP RETENTION PERIOD].',
        ],
      },
      {
        id: 'contact',
        heading: 'Contact',
        body: [`Deletion requests and questions: ${PRIVACY}.`],
      },
    ],
  },
};

const ar: Record<LegalDocumentKey, LegalDocument> = {
  terms: {
    title: 'شروط الخدمة',
    summary:
      'قواعد استخدام Brandspace خلال فترته التجريبية المغلقة. يُرجى قراءتها قبل إنشاء حسابك.',
    sections: [
      {
        id: 'who',
        heading: 'من نحن',
        body: [
          `تُشغِّل Brandspace الجهةُ [اسم الكيان القانوني]، وعنوانها [العنوان المسجَّل] («Brandspace» أو «نحن»). يمكنك التواصل معنا عبر ${SUPPORT}.`,
          'تسري هذه الشروط على كل من ينشئ حسابًا أو يُدعى إلى مساحة عمل.',
        ],
      },
      {
        id: 'beta',
        heading: 'الفترة التجريبية المغلقة',
        body: [
          {
            list: [
              'Brandspace في فترة تجريبية مغلقة، وتستخدمه ضمن تجربة مجانية. لا يُحصَّل أي مبلغ ولا تُطلب أي بيانات دفع.',
              'تستمر التجربة عدد الأيام الظاهر عند التسجيل. وما دام الدفع غير متاح، لا يُقفل شيء عند انتهاء التجربة، وسنُعلمك قبل أي تغيير في ذلك.',
              'بعض الميزات غير مفعّلة في الفترة التجريبية: ميزات الذكاء الاصطناعي (الكتابة وإنشاء الصور والمساعد والشرح)، وربط حسابات التواصل الاجتماعي والجدولة والنشر. وحيث تكون الميزة غير متاحة يذكر المنتج ذلك.',
              'تُقدَّم الخدمة «كما هي» و«حسب توفّرها»، دون أي تعهّد بأن تعمل دون انقطاع أو أخطاء أو أن تناسب غرضًا معيّنًا. وقد تتغيّر الميزات أو تتوقف أو تُزال خلال الفترة التجريبية.',
              'نُعلن أي تغيير في هذه الشروط بالبريد الإلكتروني أو داخل المنتج قبل سريانه. وإذا واصلت استخدام Brandspace بعد سريان التغيير، تسري الشروط الجديدة.',
            ],
          },
        ],
      },
      {
        id: 'account',
        heading: 'حسابك',
        body: [
          {
            list: [
              'قدِّم بيانات صحيحة، واحتفظ بكلمة المرور لنفسك، وفعِّل التحقق بخطوتين إن أمكنك.',
              'أنت مسؤول عمّا يحدث في حسابك. أبلغنا فورًا إذا ظننت أن غيرك استخدمه.',
              'يقرر مالك مساحة العمل من يُدعى إليها ودور كل عضو، ويتحمّل مسؤولية الأعضاء الذين يدعوهم.',
              'يجب ألّا يقلّ عمرك عن [الحد الأدنى للعمر] سنة، وأن تكون أهلًا لقبول هذه الشروط عن نفسك أو عن الجهة التي تمثّلها.',
            ],
          },
        ],
      },
      {
        id: 'content',
        heading: 'محتواك',
        body: [
          'يبقى كل ما تضيفه إلى Brandspace ملكًا لك: بيانات العلامة ومعارف عقل العلامة والمستندات والوسائط والمنشورات والملاحظات وغيرها.',
          'تأذن لنا بتخزين هذا المحتوى ومعالجته وعرضه فقط لتقديم الخدمة لك وللأشخاص الذين تدعوهم. لا نبيعه ولا نستخدمه في الإعلانات.',
          'تؤكد أن لديك الحق في استخدام كل ما ترفعه أو تكتبه في Brandspace.',
        ],
      },
      {
        id: 'uploads',
        heading: 'الملفات المرفوعة وفحص البرمجيات الضارة',
        body: [
          'خلال الفترة التجريبية لا تُفحص الملفات المرفوعة بحثًا عن البرمجيات الضارة. ترفع الملفات وتفتحها على مسؤوليتك.',
          {
            list: [
              'لا يمكن رفع إلا أنواع الملفات التي يقبلها المنتج، وتسري حدود الحجم الظاهرة بجانب كل أداة رفع.',
              'يُسلَّم الملف المرفوع دائمًا للتنزيل، ولا يفتحه Brandspace أبدًا كصفحة ويب.',
              'لا تفتح إلا الملفات التي تثق بها، واحرص على حماية جهازك.',
            ],
          },
          'إذا فعّلنا فحص الملفات، فسنحدّث هذا القسم قبل أن يتغيّر شيء في طريقة الرفع.',
        ],
      },
      {
        id: 'use',
        heading: 'الاستخدام المقبول',
        body: [
          'لا تستخدم Brandspace من أجل:',
          {
            list: [
              'مخالفة القانون أو حقوق أي شخص، بما فيها حقوق النشر والخصوصية؛',
              'رفع برمجيات ضارة أو أي شيء صُمِّم لإيذاء جهاز أو شخص؛',
              'محاولة الوصول إلى بيانات مساحة عمل أخرى، أو اختبار أمننا أو تجاوزه، أو إرهاق الخدمة؛',
              'إرسال رسائل مزعجة أو محتوى فيه مضايقة أو تهديد أو تضليل؛',
              'إعادة بيع الخدمة أو مشاركة الوصول إليها دون إذن كتابي منّا.',
            ],
          },
          'قد نزيل محتوى أو نوقف حسابًا يخالف هذه القواعد، وسنُعلمك أولًا حيثما أمكن.',
        ],
      },
      {
        id: 'data',
        heading: 'بياناتك خلال الفترة التجريبية',
        body: [
          'توضح سياسة الخصوصية كيف نتعامل مع البيانات الشخصية. نحتفظ بنسخ احتياطية، لكن يُرجى خلال الفترة التجريبية الاحتفاظ بنسخك الخاصة من الملفات المهمة لك.',
        ],
      },
      {
        id: 'ending',
        heading: 'الإنهاء',
        body: [
          {
            list: [
              'يمكنك التوقف عن استخدام Brandspace في أي وقت. ويمكن لمالك مساحة العمل حذفها من الإعدادات ← التحكم في البيانات؛ راجع صفحة حذف البيانات.',
              'قد ننهي الفترة التجريبية أو نغلق حسابًا. وما لم يكن هناك سبب أمني أو قانوني، سنمنحك مهلة [مدة الإشعار] وطريقة لأخذ ملفاتك.',
            ],
          },
        ],
      },
      {
        id: 'liability',
        heading: 'المسؤولية',
        body: [
          'في الحدود التي يسمح بها القانون، لا تتحمّل [اسم الكيان القانوني] المسؤولية عن الخسائر غير المباشرة أو التبعية، ولا عن فقدان الأرباح أو البيانات، الناتجة عن استخدامك للفترة التجريبية. ويقتصر إجمالي مسؤوليتنا على [حد المسؤولية]. ولا يحدّ شيء في هذه الشروط من مسؤولية لا يجيز القانون الحدّ منها.',
        ],
      },
      {
        id: 'law',
        heading: 'القانون الواجب التطبيق',
        body: [
          'تخضع هذه الشروط لقوانين [القانون الواجب التطبيق]، وتختص محاكم [جهة الاختصاص] بالفصل في النزاعات.',
        ],
      },
      {
        id: 'contact',
        heading: 'التواصل',
        body: [`للاستفسار عن هذه الشروط: ${SUPPORT}.`],
      },
    ],
  },
  privacy: {
    title: 'سياسة الخصوصية',
    summary: 'ما الذي يجمعه Brandspace، ولماذا، ومن يعالجه، ومدة الاحتفاظ به، وكيف تتحكم فيه.',
    sections: [
      {
        id: 'who',
        heading: 'الجهة المسؤولة',
        body: [
          `[اسم الكيان القانوني]، وعنوانها [العنوان المسجَّل]، هي المسؤولة عن البيانات الشخصية الموضّحة هنا. للتواصل: ${PRIVACY}.`,
          'يقرر مالك مساحة العمل المحتوى الذي يضيفه فريقه إليها، ونعالجه نحن لتقديم الخدمة له.',
        ],
      },
      {
        id: 'collect',
        heading: 'ما نجمعه ولماذا',
        body: [
          {
            list: [
              'الحساب: اسمك وبريدك الإلكتروني وكلمة المرور (تُخزَّن كتجزئة أحادية الاتجاه فقط) ولغتك ومنطقتك الزمنية، وإعدادات التحقق بخطوتين (المفتاح السري مشفّر، ورموز الاسترداد تُخزَّن كتجزئة فقط). السبب: إنشاء حسابك وحمايته.',
              'سجلات الدخول والأمان: لكل جلسة وقت بدئها وعنوان IP والمتصفح؛ وللمستندات القانونية التي قبلتها: الإصدار ووقت القبول وعنوان IP والمتصفح. السبب: الأمان ومنع إساءة الاستخدام وإثبات القبول.',
              'مساحة العمل والعلامات التجارية: اسم مساحة العمل وبلدها ومنطقتها الزمنية ومدينتها (لمصر فقط) وعملتها ولغتها؛ واسم كل علامة وموقعها ومجالها وألوانها وشعارها وخطوطها ولغات النشر فيها. السبب: إعداد مساحة عملك وتشغيلها.',
              'عقل العلامة: الحقائق التي تُدخلها أو تعتمدها، والمستندات التي ترفعها إليه. نقرأ نص المستند لاقتراح حقائق. السبب: جمع معارف علامتك في مكان واحد.',
              'الوسائط: الصور ومقاطع الفيديو والملفات الصوتية والمستندات والخطوط التي ترفعها. السبب: تخزينها واستخدامها في محتواك.',
              'المحتوى والعمل الجماعي: المنشورات والمسودات والتقويم والحملات والاستراتيجية والموافقات والملاحظات والإشارات والأتمتة. السبب: هذه هي الخدمة.',
              'الفريق: أسماء المدعوين وعناوين بريدهم الإلكتروني وأدوارهم. السبب: تمكين فريقك من العمل معًا.',
              'الاستخدام: خطتك وتواريخ التجربة وعدّادات الاستخدام والرصيد وحركاته. السبب: تطبيق حدود خطتك.',
              'سجل النشاط: من فعل ماذا ومتى في مساحة العمل (مثل «تمت الموافقة على منشور»)، دون محتوى الملفات أبدًا. السبب: المساءلة والأمان.',
              'رسائل البريد: العنوان والرسالة لكل بريد نرسله (التحقق وإعادة تعيين كلمة المرور والدعوات والإشعارات). السبب: التواصل معك بشأن حسابك.',
              'السجلات التقنية: الأخطاء وأحداث الخدمة، بعد حذف كلمات المرور والمفاتيح والرموز. السبب: الحفاظ على عمل الخدمة.',
            ],
          },
          'لا نبيع البيانات الشخصية ولا نستخدمها في الإعلانات، ولا توجد في Brandspace أدوات تتبّع إعلانية أو تحليلية.',
        ],
      },
      {
        id: 'processors',
        heading: 'من يعالج بياناتك',
        body: [
          {
            list: [
              'Railway: يستضيف التطبيق وقاعدة بيانات PostgreSQL وطابور المهام (Redis)، ويحتفظ بكل البيانات التي تخزّنها الخدمة. المنطقة: [منطقة الاستضافة].',
              'Cloudflare R2: يخزّن الملفات التي ترفعها. [تأكيد مزوّد التخزين ومنطقته]',
              'Amazon Web Services (KMS): يدير مفاتيح التشفير التي تحمي الأسرار المخزّنة، مثل مفاتيح التحقق بخطوتين. يتلقى طلبات التشفير، لا محتواك.',
              'Resend: يرسل رسائلنا البريدية، ويتلقى عنوان كل مستلم والرسالة.',
            ],
          },
          'غير مفعّل في الفترة التجريبية:',
          {
            list: [
              'مزوّدو الذكاء الاصطناعي: لا يُرسل أي محتوى إلى أي نموذج ذكاء اصطناعي خلال الفترة التجريبية. وقبل تفعيل ميزات الذكاء الاصطناعي ستذكر هذه السياسة المزوّد وما يتلقاه.',
              'فحص الملفات: لا يُستخدم أي فاحص خلال الفترة التجريبية. وإذا فُعِّل Scanii فسيُرسل كل ملف مرفوع إليه لفحصه من البرمجيات الضارة، ويحذف Scanii الملف بعد الفحص ويحتفظ بسجل النتيجة مدة تصل إلى 400 يوم.',
              'منصات التواصل الاجتماعي: لا يمكن ربط أي حساب خلال الفترة التجريبية. وقبل إتاحة ربط Facebook أو Instagram أو TikTok ستذكر هذه السياسة ما تتلقاه كل منصة وما نتلقاه منها.',
            ],
          },
        ],
      },
      {
        id: 'cookies',
        heading: 'ملفات تعريف الارتباط وتخزين المتصفح',
        body: [
          'لا يضع Brandspace إلا ملفات تعريف الارتباط اللازمة لعمله، ولا توجد ملفات إعلانية أو تحليلية.',
          {
            list: [
              '__Host-bs_customer_session: يُبقيك مسجّلًا الدخول. مدته حتى 12 ساعة.',
              'bs_signup_draft: يحفظ اسمك وبريدك ومنطقتك الزمنية إذا رُفض التسجيل حتى لا تعيد كتابتها (ولا يحفظ كلمة المرور أبدًا). مدته دقيقتان.',
              'bs_brand: يتذكّر العلامة التي كنت تعمل عليها. مدته حتى سنة.',
              'bs_mfa_recovery_codes: يعرض رموز الاسترداد الجديدة مرة واحدة بعد إعداد التحقق بخطوتين. مدته 5 دقائق.',
            ],
          },
          'وفي تخزين متصفحك نفسه، يتذكّر Brandspace التلميحات التي أغلقتها، ويحفظ مسودة لم تكتمل أثناء عملك في علامة التبويب. يمكنك مسحهما من متصفحك في أي وقت.',
        ],
      },
      {
        id: 'retention',
        heading: 'مدة الاحتفاظ بالبيانات',
        body: [
          {
            list: [
              'بيانات الحساب ومساحة العمل: ما دام الحساب أو مساحة العمل قائمًا.',
              'مساحة العمل المحذوفة: تُزال بعد مهلة (حاليًا 30 يومًا) يستطيع مالكها خلالها إلغاء الحذف.',
              'الملفات المحذوفة: تُزال من التخزين بعد 30 يومًا حاليًا.',
              'عمليات الرفع التي لم تكتمل: تُزال بعد 24 ساعة حاليًا.',
              'محادثات عقل العلامة والمساعد: 90 يومًا حاليًا (هاتان الميزتان غير مفعّلتين في الفترة التجريبية).',
              'النسخ الاحتياطية: [مدة الاحتفاظ بالنسخ الاحتياطية].',
              'سجل النشاط وسجلات الأمان: [مدة الاحتفاظ بسجل النشاط].',
            ],
          },
          'المدد الموصوفة بـ«حاليًا» إعدادات، وإذا غيّرنا إحداها حدّثنا هذه الصفحة.',
        ],
      },
      {
        id: 'isolation',
        heading: 'فصل مساحة عملك',
        body: [
          'تُفصل بيانات كل مساحة عمل عن بيانات غيرها، ويُتحقَّق من هذا الفصل مرتين: في التطبيق، ثم بقواعد داخل قاعدة البيانات نفسها. لا يستطيع شخص في مساحة عمل أن يرى بيانات مساحة عمل أخرى أو يبحث فيها أو يعدّها أو يصدّرها.',
        ],
      },
      {
        id: 'security',
        heading: 'الأمان',
        body: [
          {
            list: [
              'كل اتصال مشفّر (HTTPS).',
              'تُخزَّن كلمات المرور كتجزئة أحادية الاتجاه فقط، وتُشفَّر الأسرار بتشفير موثَّق، وتُحفظ مفاتيحها في خدمة لإدارة المفاتيح.',
              'التحقق بخطوتين متاح لكل حساب.',
              'الوصول إلى أنظمة التشغيل مقيّد، وتُسجَّل الإجراءات في سجل نشاط مساحة العمل.',
              'تُسلَّم الملفات المرفوعة دائمًا للتنزيل، ولا تُفتح كصفحات ويب.',
            ],
          },
          'لا يوجد نظام آمن تمامًا. وإذا تأثرت بياناتك باختراق فسنُعلمك دون تأخير غير مبرّر.',
        ],
      },
      {
        id: 'rights',
        heading: 'حقوقك',
        body: [
          'يمكنك أن تطلب الاطلاع على بياناتك الشخصية أو تصحيحها أو الحصول على نسخة منها أو حذفها، ويمكنك الاعتراض على طريقة استخدامنا لها أو طلب تقييدها.',
          {
            list: [
              'داخل المنتج: أعِد تعيين كلمة المرور من صفحة تسجيل الدخول («نسيت كلمة المرور؟»)، وأدِر التحقق بخطوتين من الإعدادات ← الأمان، ويمكنك بصفتك مالك مساحة العمل حذفها من الإعدادات ← التحكم في البيانات.',
              `ولغير ذلك: راسل ${PRIVACY} من عنوان بريد حسابك، وسنردّ خلال [مدة الرد].`,
            ],
          },
          'ويمكنك أيضًا تقديم شكوى إلى [الجهة الرقابية].',
        ],
      },
      {
        id: 'transfers',
        heading: 'مكان بياناتك',
        body: [
          'تُخزَّن بياناتك في [منطقة الاستضافة]. وقد يعالجها مزوّدونا في بلدان أخرى وفق ضماناتهم. [أساس النقل الدولي للبيانات]',
        ],
      },
      {
        id: 'children',
        heading: 'الأطفال',
        body: ['Brandspace غير مخصّص لمن هم دون [الحد الأدنى للعمر].'],
      },
      {
        id: 'changes',
        heading: 'تغيير هذه السياسة',
        body: ['نُعلن أي تغيير بالبريد الإلكتروني أو داخل المنتج قبل سريانه.'],
      },
      {
        id: 'contact',
        heading: 'التواصل',
        body: [`لأسئلة الخصوصية وطلباتها: ${PRIVACY}.`],
      },
    ],
  },
  'data-deletion': {
    title: 'حذف البيانات',
    summary: 'كيف تحذف بياناتك من Brandspace، وما الذي يحدث عند حذفها.',
    sections: [
      {
        id: 'workspace',
        heading: 'حذف مساحة عمل',
        body: [
          'يمكن لمالك مساحة العمل حذفها بالكامل: الإعدادات ← التحكم في البيانات ← حذف مساحة العمل، ثم كتابة اسمها للتأكيد.',
          {
            list: [
              'تُجدول مساحة العمل للحذف، ويستطيع المالك الإلغاء خلال المهلة (حاليًا 30 يومًا).',
              'بعد ذلك تُحذف مساحة العمل وكل ما فيها: العلامات التجارية وعقل العلامة والوسائط والمنشورات والتقويم والحملات والملاحظات، ويزول وصول كل الأعضاء إليها. وتُزال ملفاتها من التخزين.',
            ],
          },
        ],
      },
      {
        id: 'account',
        heading: 'حذف حسابك',
        body: [
          `راسل ${PRIVACY} من عنوان بريد حسابك واطلب حذف حسابك. نتحقق من هويتك ثم نزيل حسابك وبياناتك الشخصية خلال [مدة الرد].`,
          'إذا كنت تملك مساحة عمل، فاحذفها أولًا أو اطلب منا نقل ملكيتها إلى عضو آخر.',
        ],
      },
      {
        id: 'items',
        heading: 'حذف عناصر منفردة',
        body: [
          'يمكنك حذف الملفات والمنشورات والملاحظات وغيرها من داخل المنتج في أي وقت. ويُزال الملف المحذوف من التخزين بعد 30 يومًا حاليًا.',
        ],
      },
      {
        id: 'social',
        heading: 'حسابات التواصل الاجتماعي المرتبطة (Facebook وInstagram وTikTok)',
        body: [
          'ربط حسابات التواصل الاجتماعي غير متاح خلال الفترة التجريبية. وعند إتاحته:',
          {
            list: [
              'يؤدي فصل الحساب في Brandspace، أو إزالة Brandspace من إعدادات المنصة نفسها، إلى حذف رموز الوصول التي نحتفظ بها لذلك الحساب والبيانات التي تلقيناها من المنصة، مثل مقاييس المنشورات.',
              'يبقى محتواك في Brandspace (المسودات والمنشورات والملفات التي أنشأتها) حتى تحذفه أنت.',
              `لتأكيد الحذف، راسل ${PRIVACY} مع معرّف حسابك على تلك المنصة، وسنردّ برمز تأكيد.`,
            ],
          },
        ],
      },
      {
        id: 'kept',
        heading: 'ما نحتفظ به',
        body: [
          'نحتفظ ببعض السجلات بعد الحذف لأننا ملزمون بذلك: قيود سجل النشاط وسجلات قبول المستندات القانونية، مدة [مدة الاحتفاظ بالسجلات]. وتنتهي النسخ الاحتياطية التي ما زالت تتضمن بيانات محذوفة بعد [مدة الاحتفاظ بالنسخ الاحتياطية].',
        ],
      },
      {
        id: 'contact',
        heading: 'التواصل',
        body: [`لطلبات الحذف والأسئلة: ${PRIVACY}.`],
      },
    ],
  },
};

export function legalDocument(key: LegalDocumentKey, locale: string): LegalDocument {
  return (locale === 'ar' ? ar : en)[key];
}

/** Every placeholder still in the text, for the report and the readiness check. */
export function legalPlaceholders(): readonly string[] {
  const found = new Set<string>();
  for (const locale of [en, ar]) {
    for (const document of Object.values(locale)) {
      const texts = [
        document.title,
        document.summary,
        ...document.sections.flatMap((section) => [
          section.heading,
          ...section.body.flatMap((block) => (typeof block === 'string' ? [block] : block.list)),
        ]),
      ];
      for (const text of texts)
        for (const match of text.matchAll(/\[[^\]]+\]/g)) found.add(match[0]);
    }
  }
  return [...found];
}
