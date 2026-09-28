/**
 * PHASE 2C (Q19) — THE KEY QUESTIONS BRAND BRAIN SHIPS WITH, as the
 * `brand-brain.questions` configuration defaults.
 *
 * ================================================================
 *   DRAFT — PENDING OWNER REVIEW. The owner reviews the wording in
 *   the Phase 2C-1 pull request; it must not merge before approval.
 * ================================================================
 *
 * Configuration, not code: an operator replaces any of it by activating a new
 * `brand-brain` version in the Control Center, and the application reads only
 * what the schema resolved. This module holds the defaults the schema applies
 * when no version has been activated.
 *
 * HOW THE LISTS ARE BUILT (owner, 2026-09-28):
 *   - short questions, answerable by ONE fact each;
 *   - each names the `itemKey` of the fact that answers it, in its own area —
 *     answering is a lookup, never a guess;
 *   - the Offers questions depend on the industry: an industry in
 *     `onboarding.industries` names its set (`offersQuestionSet`: food,
 *     fashion, beauty, services), which replaces the general Offers list.
 *
 * Keys that line up with existing facts on purpose: `goal.primary` is the goal
 * the setup wizard writes (D-335); `voice.words`, `do.*` and `dont.*` are the
 * Voice card's keys (Phase 2C, decision 2.b).
 */

export interface DefaultKeyQuestion {
  readonly key: string;
  readonly itemKey: string;
  readonly prompt: { readonly en: string; readonly ar: string };
}

export interface DefaultBrandBrainQuestions {
  readonly areas: Readonly<Record<string, readonly DefaultKeyQuestion[]>>;
  readonly offersSets: Readonly<Record<string, readonly DefaultKeyQuestion[]>>;
}

const question = (key: string, itemKey: string, en: string, ar: string): DefaultKeyQuestion => ({
  key,
  itemKey,
  prompt: { en, ar },
});

export const BRAND_BRAIN_QUESTIONS: DefaultBrandBrainQuestions = {
  areas: {
    // "About the business" (the IDENTITY area).
    IDENTITY: [
      question('what', 'identity.what', 'What does your business do?', 'ماذا يقدّم نشاطك التجاري؟'),
      question(
        'promise',
        'identity.promise',
        'What do you promise your customers?',
        'بماذا تعد عملاءك؟',
      ),
      question(
        'difference',
        'identity.difference',
        'What makes you different?',
        'ما الذي يميّزك عن غيرك؟',
      ),
      question('where', 'identity.location', 'Where do you operate?', 'أين تعمل؟'),
    ],
    AUDIENCE: [
      question('primary', 'audience.primary', 'Who is your main customer?', 'من هو عميلك الأساسي؟'),
      question(
        'need',
        'audience.need',
        'What problem do you solve for them?',
        'ما المشكلة التي تحلّها لهم؟',
      ),
      question(
        'channels',
        'audience.channels',
        'Where do they spend time online?',
        'أين يقضون وقتهم على الإنترنت؟',
      ),
    ],
    TONE_OF_VOICE: [
      question(
        'words',
        'voice.words',
        'Which words describe your voice?',
        'ما الكلمات التي تصف أسلوبك؟',
      ),
      question('formality', 'voice.formality', 'Formal or casual?', 'رسمي أم ودّي؟'),
      question(
        'language',
        'voice.language',
        'Which language and dialect do you write in?',
        'بأي لغة ولهجة تكتب؟',
      ),
    ],
    OFFERS: [
      question('what', 'offers.what', 'What do you sell?', 'ماذا تبيع؟'),
      question('prices', 'offers.prices', 'What are your prices?', 'ما أسعارك؟'),
      question('current', 'offers.current', 'What offer is running now?', 'ما العرض الحالي؟'),
    ],
    PROOF_POINTS: [
      question(
        'results',
        'proof.results',
        'What results can you show?',
        'ما النتائج التي تستطيع إثباتها؟',
      ),
      question(
        'testimonial',
        'proof.testimonial',
        'What does a happy customer say?',
        'ماذا يقول عميل راضٍ؟',
      ),
      question(
        'credentials',
        'proof.credentials',
        'Any awards, years or certifications?',
        'هل لديك جوائز أو سنوات خبرة أو شهادات؟',
      ),
    ],
    DO_DONT: [
      question('always', 'do.always', 'What must every post do?', 'ما الذي يجب أن يفعله كل منشور؟'),
      question(
        'never',
        'dont.never',
        'What must a post never say?',
        'ما الذي لا يقوله منشور أبدًا؟',
      ),
    ],
    COMPETITORS: [
      question(
        'main',
        'competitors.main',
        'Who are your main competitors?',
        'من منافسوك الرئيسيون؟',
      ),
      question(
        'edge',
        'competitors.edge',
        'Why do customers choose you over them?',
        'لماذا يختارك العملاء بدلًا منهم؟',
      ),
    ],
    GLOSSARY: [
      question(
        'terms',
        'glossary.terms',
        'Which names or words must be written exactly?',
        'ما الأسماء أو الكلمات التي تُكتب كما هي دائمًا؟',
      ),
    ],
    STRATEGY: [
      question(
        'goal',
        'goal.primary',
        'What is your main goal right now?',
        'ما هدفك الرئيسي الآن؟',
      ),
      question(
        'pillars',
        'strategy.pillars',
        'Which topics should you post about?',
        'ما المواضيع التي تنشر عنها؟',
      ),
    ],
    LEARNINGS: [
      question(
        'format',
        'learning.best_format',
        'Which kind of post works best for you?',
        'ما نوع المنشور الأنجح لديك؟',
      ),
      question(
        'timing',
        'learning.best_time',
        'When does your audience respond most?',
        'متى يتفاعل جمهورك أكثر؟',
      ),
    ],
  },
  offersSets: {
    // Appendix B D3's own example for food: what you sell / prices / hours & offers.
    food: [
      question('menu', 'offers.menu', 'What is on your menu?', 'ماذا تقدّم في قائمتك؟'),
      question('prices', 'offers.prices', 'What are your prices?', 'ما أسعارك؟'),
      question(
        'hours',
        'offers.hours',
        'What are your hours and current offers?',
        'ما مواعيد العمل والعروض الحالية؟',
      ),
    ],
    fashion: [
      question(
        'collections',
        'offers.collections',
        'Which collections do you sell?',
        'ما المجموعات التي تبيعها؟',
      ),
      question('prices', 'offers.prices', 'What is your price range?', 'ما نطاق أسعارك؟'),
      question('sizes', 'offers.sizes', 'Which sizes do you carry?', 'ما المقاسات المتوفرة؟'),
      question(
        'delivery',
        'offers.delivery',
        'How do delivery and returns work?',
        'كيف يتم التوصيل والاسترجاع؟',
      ),
    ],
    beauty: [
      question(
        'treatments',
        'offers.services',
        'Which treatments or products do you offer?',
        'ما العلاجات أو المنتجات التي تقدّمها؟',
      ),
      question('prices', 'offers.prices', 'What are your prices?', 'ما أسعارك؟'),
      question('booking', 'offers.booking', 'How do customers book?', 'كيف يحجز العملاء؟'),
    ],
    services: [
      question(
        'services',
        'offers.services',
        'Which services do you offer?',
        'ما الخدمات التي تقدّمها؟',
      ),
      question('prices', 'offers.prices', 'How do you price your work?', 'كيف تسعّر خدماتك؟'),
      question(
        'process',
        'offers.process',
        'How does working with you start?',
        'كيف يبدأ العمل معك؟',
      ),
    ],
  },
};
