import { displayValue, labelOf, sameValue } from './fields';
import type {
  AreaContext,
  AreaKey,
  AreaSpec,
  CollectionSpec,
  FieldSpec,
  FieldValues,
} from './types';
import { plansArea } from './areas/plans';
import { trialArea } from './areas/trial';
import { channelsArea } from './areas/channels';
import { publishingArea } from './areas/publishing';
import { signupsArea } from './areas/signups';
import { uploadsArea } from './areas/uploads';
import { contentArea } from './areas/content';
import { legalArea } from './areas/legal';

/** Every Simple area, in the order the owner's navigation lists them. */
export const AREAS: readonly AreaSpec[] = [
  plansArea,
  trialArea,
  channelsArea,
  publishingArea,
  signupsArea,
  uploadsArea,
  contentArea,
  legalArea,
];

export function findArea(key: string): AreaSpec | null {
  return AREAS.find((area) => area.key === (key as AreaKey)) ?? null;
}

export function findCollection(area: AreaSpec, id: string | null): CollectionSpec | null {
  return area.collections.find((collection) => collection.id === id) ?? area.collections[0] ?? null;
}

export interface ChangeLine {
  readonly label: string;
  readonly before: string;
  readonly after: string;
}

/**
 * WHAT CHANGES, field by field, in the reader's words: "Trial credits: 200 →
 * 500". A new item lists what it is created with; an unchanged field is left out.
 */
export function changeLines(
  fields: readonly FieldSpec[],
  before: FieldValues | null,
  after: FieldValues,
  ctx: AreaContext,
): readonly ChangeLine[] {
  const lines: ChangeLine[] = [];
  for (const field of fields) {
    const was = before?.[field.id];
    const now = after[field.id];
    if (now === undefined) continue;
    if (before && sameValue(was, now)) continue;
    lines.push({
      label: labelOf(ctx, field.label),
      before: before ? displayValue(field, was, ctx) : '—',
      after: displayValue(field, now, ctx),
    });
  }
  return lines;
}
