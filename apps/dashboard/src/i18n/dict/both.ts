/**
 * B2 — THE FEW WORDS A PAGE SHOWS IN BOTH LANGUAGES, whatever its own.
 *
 * Brand Brain names the brand's voice words in English AND Arabic (one record,
 * two titles), and the Look card writes each font slot's sample in that
 * slot's language. These are the only cross-language strings a client
 * component needs, so they live here, once; `./en.ts` and `./ar.ts` take
 * their values from this module, and a page in the browser carries these
 * few sentences rather than the other language's whole dictionary.
 */
export const BOTH = {
  en: {
    'bb.voice.words': 'Voice words',
    'bb.look.sample.heading': 'Fresh ideas, every week',
    'bb.look.sample.body': 'This is how your posts read in English.',
  },
  ar: {
    'bb.voice.words': 'كلمات الأسلوب',
    'bb.look.sample.heading': 'أفكار جديدة كل أسبوع',
    'bb.look.sample.body': 'هكذا تبدو منشوراتك باللغة العربية.',
  },
} as const;

export type BothKey = keyof (typeof BOTH)['en'];
