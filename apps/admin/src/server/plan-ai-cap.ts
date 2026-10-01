import { AppError } from '@brandspace/shared';
import type { PlanAutomationAiCap } from '@brandspace/entitlements';

/**
 * PHASE 2B-3 PR 6 — THE AI AUTOMATION CAP IN THE PLAN EDITORS (D-458).
 *
 * Two plan fields, each a three-way choice the form posts as
 * `aiCap.<field>.kind` (`''` not set · `limited` · `unlimited`) and
 * `aiCap.<field>.value`. NOT SET IS OFF, and is written by LEAVING THE FIELD
 * OUT of the plan — never as `null`, which the counts above it read as
 * unlimited. The 1..1000 range is the configuration schema's; this only refuses
 * what is not a whole number at all.
 */

export const PLAN_AI_CAP_FIELDS = [
  'automationAiActionsPerMonth',
  'trialAutomationAiActionsPerMonth',
] as const;

export type PlanAiCapField = (typeof PLAN_AI_CAP_FIELDS)[number];

/** Read one cap from a submitted form; `undefined` means not set (off). */
export function readPlanAiCap(
  form: FormData,
  field: PlanAiCapField,
): PlanAutomationAiCap | undefined {
  const kind = String(form.get(`aiCap.${field}.kind`) ?? '').trim();
  if (kind === '') return undefined;
  if (kind === 'unlimited') return { kind: 'unlimited' };
  if (kind === 'limited') {
    const raw = String(form.get(`aiCap.${field}.value`) ?? '').trim();
    const value = Number(raw);
    if (raw === '' || !Number.isInteger(value)) {
      throw new AppError('VALIDATION_FAILED', 'A limited AI automation cap needs a whole number.');
    }
    return { kind: 'limited', value };
  }
  throw new AppError('VALIDATION_FAILED', 'Unknown AI automation cap kind.');
}

/** The caps a form sets, ready to spread into `quotas` (absent fields stay absent). */
export function readPlanAiCaps(
  form: FormData,
): Partial<Record<PlanAiCapField, PlanAutomationAiCap>> {
  const caps: Partial<Record<PlanAiCapField, PlanAutomationAiCap>> = {};
  for (const field of PLAN_AI_CAP_FIELDS) {
    const cap = readPlanAiCap(form, field);
    if (cap) caps[field] = cap;
  }
  return caps;
}

/** What the change list compares: a number, `null` for unlimited, `'off'` when not set. */
export function planAiCapValue(cap: PlanAutomationAiCap | null | undefined): number | null | 'off' {
  if (cap === null || cap === undefined) return 'off';
  return cap.kind === 'unlimited' ? null : cap.value;
}
