import {
  AI_CAPABILITIES,
  assessCapability,
  findAiCapability,
  NO_MODEL_FEATURES,
  REQUESTED_AI_CAPABILITIES,
  tasksForCapability,
  type RegisteredModel,
} from '@brandspace/ai-gateway';
import {
  SectionHeader,
  colorTokens,
  fontTokens,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';
import { Cell, DataTable, EmptyState, PageIntro } from '../../../../components/admin-shell';
import {
  currentEnvironment,
  getConfigService,
  requirePageActor,
} from '../../../../server/platform-context';

export const dynamic = 'force-dynamic';

/**
 * AI ROUTING — the capability layer and the task rules beneath it (Phase 10 §7, §8).
 *
 * WHAT THIS SCREEN HAS TO MAKE OBVIOUS, because getting it wrong costs real
 * money on a customer's request:
 *
 *   1. WHICH LAYER ANSWERS. A task rule wins outright; the capability route is
 *      what answers when nobody wrote one. Showing them in one list would hide
 *      the precedence that decides every request.
 *
 *   2. WHICH MODELS CAN ACTUALLY SERVE A CAPABILITY, and why the others cannot.
 *      "Vision analysis" and "write a caption" are both TEXT models, so an
 *      operator reading a modality column has no way to tell them apart. The
 *      third column here is the refusal reason, computed by the same function
 *      the router uses.
 *
 *   3. WHICH CAPABILITIES A SHIPPING FEATURE ACTUALLY REQUESTS. An owner may
 *      configure `VISION_ANALYSIS` ahead of a feature needing it, which is
 *      useful preparation — but an unrouted capability that nothing calls must
 *      not read as a broken product.
 */
export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  await requirePageActor(locale, 'platform.configuration.read');
  const isArabic = locale === 'ar';
  const environment = currentEnvironment();

  const configuration = getConfigService();
  const [routing, capabilityRouting, catalogue] = await Promise.all([
    configuration.get('ai.routing', environment),
    configuration.get('ai.capability-routing', environment),
    configuration.get('ai.models', environment),
  ]);

  const models: RegisteredModel[] = catalogue.models.map((model) => ({
    key: model.key,
    providerKey: model.providerKey,
    modality: model.modality,
    qualityTier: model.qualityTier,
    status: model.status,
    disableSwitch: model.disableSwitch,
    capabilities: model.capabilities,
    features: {
      ...NO_MODEL_FEATURES,
      vision: model.supportsVision,
      structuredOutput: model.supportsStructuredOutput,
      toolUse: model.supportsToolUse,
      audioInput: model.supportsAudioInput,
      audioOutput: model.supportsAudioOutput,
      embeddings: model.supportsEmbeddings,
    },
    latencyTier: model.latencyTier,
  }));

  const routeFor = (capability: string) =>
    capabilityRouting.routes.find((route) => route.capability === capability) ?? null;

  return (
    <>
      <PageIntro
        description={
          isArabic
            ? `الملف النشط: ${capabilityRouting.activeProfile}. قيم مقروءة من الإصدار المُفعّل؛ التعديل عبر صفحة الإعدادات.`
            : `Active profile: ${capabilityRouting.activeProfile}. Read from the active configuration version; edit on the Configuration page.`
        }
      />

      <SectionHeader
        title={isArabic ? 'ملف التوجيه النشط' : 'Active routing profile'}
        description={
          isArabic
            ? 'الملف يرتّب النماذج التي أدخلتها؛ لا يضيف أي نموذج ولا يسمح بنموذج لا يعلن القدرة المطلوبة.'
            : 'A profile RANKS the models you entered. It adds none, and it can never promote a model that does not declare the capability.'
        }
      />
      <DataTable headers={[isArabic ? 'الملف' : 'Profile', isArabic ? 'المعنى' : 'What it does']}>
        {(['economy', 'balanced', 'premium', 'custom'] as const).map((profile) => (
          <tr key={profile} data-testid={`profile-${profile}`}>
            <Cell>
              <span
                style={{
                  fontWeight: capabilityRouting.activeProfile === profile ? 700 : 400,
                  color:
                    capabilityRouting.activeProfile === profile
                      ? colorTokens.brandPurple
                      : colorTokens.textPrimary,
                }}
              >
                {profile}
                {capabilityRouting.activeProfile === profile
                  ? isArabic
                    ? ' — نشط'
                    : ' — active'
                  : ''}
              </span>
            </Cell>
            <Cell>{profileExplanation(profile, isArabic)}</Cell>
          </tr>
        ))}
      </DataTable>

      <div style={{ marginBlockStart: spacingTokens.xl }}>
        <SectionHeader
          title={isArabic ? 'القدرات' : 'Capabilities'}
          description={
            isArabic
              ? 'ما يطلبه المنتج، وما يمكن لكل نموذج خدمته فعليًا.'
              : 'What the product asks for, and which models can actually serve it.'
          }
        />
        <DataTable
          headers={[
            isArabic ? 'القدرة' : 'Capability',
            isArabic ? 'تطلبها ميزات' : 'Requested by',
            isArabic ? 'المسار' : 'Route',
            isArabic ? 'نماذج مؤهّلة' : 'Eligible models',
          ]}
        >
          {AI_CAPABILITIES.map((capability) => {
            const route = routeFor(capability.key);
            const eligible = models
              .map((model) => assessCapability(capability, model))
              .filter((assessment) => assessment.refusal === null)
              .map((assessment) => assessment.model.key);
            const tasks = tasksForCapability(capability.key);
            const requested = REQUESTED_AI_CAPABILITIES.includes(capability.key);

            return (
              <tr key={capability.key} data-testid={`capability-${capability.key}`}>
                <Cell>
                  <code style={{ fontFamily: fontTokens.mono }}>{capability.key}</code>
                  <div style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}>
                    {capability.inputModality} → {capability.outputModality}
                  </div>
                </Cell>
                <Cell>
                  {tasks.length === 0 ? (
                    <span style={{ color: colorTokens.textMuted }}>
                      {isArabic ? 'لا تطلبها أي ميزة بعد' : 'No shipping feature requests this yet'}
                    </span>
                  ) : (
                    <span
                      style={{ color: requested ? colorTokens.textPrimary : colorTokens.textMuted }}
                    >
                      {tasks.map((task) => task.key).join(', ')}
                    </span>
                  )}
                </Cell>
                <Cell>
                  {route === null ? (
                    <span style={{ color: colorTokens.textMuted }}>
                      {capabilityRouting.activeProfile === 'custom'
                        ? isArabic
                          ? 'غير مُهيّأ'
                          : 'Not configured'
                        : isArabic
                          ? 'يختاره الملف'
                          : 'Chosen by the profile'}
                    </span>
                  ) : !route.enabled ? (
                    <span style={{ color: colorTokens.warning }}>
                      {isArabic ? 'مُعطّلة' : 'Switched off'}
                    </span>
                  ) : (
                    <span>
                      {route.primaryModelKey ??
                        (isArabic ? 'يختاره الملف' : 'Chosen by the profile')}
                      {route.fallbackModelKeys.length > 0
                        ? ` → ${route.fallbackModelKeys.join(' → ')}`
                        : ''}
                    </span>
                  )}
                </Cell>
                <Cell>
                  {eligible.length === 0 ? (
                    <span style={{ color: colorTokens.warning }}>
                      {isArabic ? 'لا يوجد' : 'None'}
                    </span>
                  ) : (
                    eligible.join(', ')
                  )}
                </Cell>
              </tr>
            );
          })}
        </DataTable>
      </div>

      <div style={{ marginBlockStart: spacingTokens.xl }}>
        <SectionHeader
          title={isArabic ? 'لماذا يُستبعد نموذج' : 'Why a model is excluded'}
          description={
            isArabic
              ? 'نفس الفحص الذي يطبّقه الموجّه وقت الطلب — النمط وحده لا يكفي: «تحليل الصور» و«كتابة تعليق» كلاهما نصّي.'
              : 'The same check the router applies at request time. Modality alone is not enough: "vision analysis" and "write a caption" are both text.'
          }
        />
        {models.length === 0 ? (
          <EmptyState
            message={
              isArabic ? 'لا توجد نماذج في الكتالوج بعد.' : 'No models in the catalogue yet.'
            }
          />
        ) : (
          <DataTable
            headers={[
              isArabic ? 'النموذج' : 'Model',
              isArabic ? 'القدرة' : 'Capability',
              isArabic ? 'النتيجة' : 'Verdict',
            ]}
          >
            {models.flatMap((model) =>
              (model.capabilities ?? []).map((key) => {
                const capability = findAiCapability(key);
                if (!capability) return null;
                const assessment = assessCapability(capability, model);
                return (
                  <tr key={`${model.key}:${key}`} data-testid={`assessment-${model.key}-${key}`}>
                    <Cell>
                      <code style={{ fontFamily: fontTokens.mono }}>{model.key}</code>
                    </Cell>
                    <Cell>{key}</Cell>
                    <Cell>
                      <span
                        style={{
                          color:
                            assessment.refusal === null ? colorTokens.success : colorTokens.danger,
                        }}
                      >
                        {assessment.refusal ?? (isArabic ? 'مؤهّل' : 'Eligible')}
                      </span>
                    </Cell>
                  </tr>
                );
              }),
            )}
          </DataTable>
        )}
      </div>

      <div style={{ marginBlockStart: spacingTokens.xl }}>
        <SectionHeader
          title={isArabic ? 'قواعد المهام' : 'Task rules'}
          description={
            isArabic
              ? 'الأكثر تحديدًا، وتفوز على طبقة القدرات دائمًا.'
              : 'The specific answer. A task rule always wins over the capability layer.'
          }
        />
        {routing.rules.length === 0 ? (
          <EmptyState
            message={
              isArabic
                ? 'لا توجد قواعد مهام — تُوجَّه كل مهمة عبر قدرتها.'
                : 'No task rules. Every task routes through its capability.'
            }
          />
        ) : (
          <DataTable
            headers={['taskKey', 'scope', 'primaryModelKey', 'fallbackModelKeys', 'timeoutMs']}
          >
            {routing.rules.map((rule, index) => (
              <tr key={`${rule.taskKey}-${index}`} data-testid={`row-${index}`}>
                <Cell>{rule.taskKey}</Cell>
                <Cell>{rule.scope}</Cell>
                <Cell>{rule.primaryModelKey}</Cell>
                <Cell>{rule.fallbackModelKeys.join(', ') || '—'}</Cell>
                <Cell>{rule.timeoutMs}</Cell>
              </tr>
            ))}
          </DataTable>
        )}
      </div>
    </>
  );
}

function profileExplanation(
  profile: 'economy' | 'balanced' | 'premium' | 'custom',
  isArabic: boolean,
): string {
  switch (profile) {
    case 'economy':
      return isArabic
        ? 'أرخص نموذج مؤهّل لكل قدرة.'
        : 'The cheapest model that declares the capability.';
    case 'balanced':
      return isArabic
        ? 'الأرخص للعمل البسيط، والأقوى حين تتطلب القدرة شيئًا محددًا.'
        : 'Cheapest for simple work; strongest where the capability requires something specific.';
    case 'premium':
      return isArabic
        ? 'أعلى مستوى جودة مؤهّل لكل قدرة.'
        : 'The highest quality tier that declares the capability.';
    case 'custom':
      return isArabic
        ? 'الجدول أدناه هو الإجابة؛ لا ترتيب تلقائي.'
        : 'The table below is the answer. No ranking is applied.';
  }
}
