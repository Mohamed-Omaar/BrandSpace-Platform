import type { AgentKnowledge } from '@brandspace/copilot';
import {
  BrandKnowledgeService,
  TenantBrandBrainPolicySource,
  brandProfileFor,
  questionsForBrand,
  workspaceKnowledgeAsOf,
} from '@brandspace/brand-brain';
import { getPrisma, withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { TenantOnboardingPolicySource, offersQuestionSetFor } from '@brandspace/onboarding';
import { currentEnvironment } from './phase7-context';

/**
 * PR A (smart Copilot, D-604) — HOW COMPLETE THE BRAND'S KNOWLEDGE IS.
 *
 * DISPLAY AND GUIDANCE, NEVER A PROMPT OF FACTS. The brand profile's fields
 * that are filled, plus the key questions answered, from the same Q19
 * completeness Home's checklist counts. What leaves here is a percentage and
 * the next missing thing — a profile field's fixed wording or the configured
 * key question — so the Copilot can ask for ONE thing at a time. No fact text.
 */

const PROFILE_FIELDS = ['logo', 'colours', 'fonts', 'description', 'industry', 'website'] as const;
const PROFILE_FIELD_ASK: Record<(typeof PROFILE_FIELDS)[number], { en: string; ar: string }> = {
  logo: {
    en: 'the brand logo (upload it in brand settings)',
    ar: 'شعار العلامة (يُرفع من إعدادات العلامة)',
  },
  colours: { en: 'the brand colours (hex codes)', ar: 'ألوان العلامة (رموز hex)' },
  fonts: { en: 'the brand fonts', ar: 'خطوط العلامة' },
  description: {
    en: 'a one-paragraph description of the brand',
    ar: 'وصف قصير للعلامة في فقرة واحدة',
  },
  industry: { en: 'the brand industry', ar: 'مجال عمل العلامة' },
  website: { en: 'the brand website address', ar: 'عنوان موقع العلامة' },
};

function inWorkspace<T>(workspaceId: string, fn: (db: TenantScopedClient) => Promise<T>) {
  return withWorkspace(workspaceId, fn as never, { prisma: getPrisma() }) as Promise<T>;
}

export async function brandKnowledge(
  workspaceId: string,
  brandId: string,
  language: 'ar' | 'en',
): Promise<AgentKnowledge | null> {
  return inWorkspace(workspaceId, async (db) => {
    const brand = await db.brand.findFirst({
      where: { id: brandId, deletedAt: null },
      select: {
        industry: true,
        description: true,
        websiteUrl: true,
        colorPalette: true,
        typography: true,
        primaryLogoAssetId: true,
      },
    });
    if (!brand) return null;
    const profile = await brandProfileFor(db, brandId);
    const filled: Record<(typeof PROFILE_FIELDS)[number], boolean> = {
      logo: brand.primaryLogoAssetId !== null,
      colours: (profile?.colours.length ?? 0) > 0,
      fonts: (profile?.fonts.length ?? 0) > 0,
      description: Boolean(brand.description?.trim()),
      industry: Boolean(brand.industry?.trim()),
      website: Boolean(brand.websiteUrl?.trim()),
    };
    const [policy, onboarding, asOf] = await Promise.all([
      new TenantBrandBrainPolicySource(db, currentEnvironment()).load(),
      new TenantOnboardingPolicySource(db, currentEnvironment()).load(),
      workspaceKnowledgeAsOf(db),
    ]);
    const questions = questionsForBrand(
      policy.questions,
      offersQuestionSetFor(brand.industry ?? null, onboarding.industries),
    );
    const completion = await new BrandKnowledgeService({ db, workspaceId })
      .completion(brandId, questions, asOf)
      .catch(() => null);
    const answered = completion ? completion.areas.reduce((n, area) => n + area.answered, 0) : 0;
    const total = completion ? completion.areas.reduce((n, area) => n + area.total, 0) : 0;
    const profileDone = PROFILE_FIELDS.filter((field) => filled[field]).length;
    const percent = Math.round(
      ((profileDone + answered) / Math.max(1, PROFILE_FIELDS.length + total)) * 100,
    );
    const missingField = PROFILE_FIELDS.find((field) => !filled[field]);
    const missingQuestion = completion?.missing[0]?.question.prompt;
    const nextMissing = missingField
      ? PROFILE_FIELD_ASK[missingField][language]
      : missingQuestion
        ? (missingQuestion[language] ?? missingQuestion.en ?? missingQuestion.ar ?? null)
        : null;
    return { percent, nextMissing };
  });
}
