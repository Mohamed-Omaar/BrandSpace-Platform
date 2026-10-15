import type { AreaCopyKey } from '../../i18n/simple-areas';
import { formatMinor, majorToMinor, minorToMajorInput } from '../money';
import { sameJson } from './json';
import type { AreaContext, FieldSpec, FieldValue, FieldValues, MoneyValue } from './types';

/**
 * FORM VALUES <-> FIELD VALUES, with plain refusals in the reader's language.
 *
 * One reader for both steps of an edit: the editor submits to the preview
 * (GET, so the preview is a page the owner can reload), and the preview's
 * confirmation posts the same names to the save action. Each field is read by
 * its kind; anything that does not fit is refused with one sentence naming the
 * field — never rounded, never guessed, never a raw schema message.
 */

/** The form-field name for a field (and its parts). */
export const fieldName = (id: string, part?: string) => (part ? `f.${id}.${part}` : `f.${id}`);

export interface Source {
  get(name: string): string | null;
  getAll(name: string): string[];
}

export function sourceOf(query: Record<string, string | string[] | undefined>): Source {
  return {
    get: (name) => {
      const value = query[name];
      return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
    },
    getAll: (name) => {
      const value = query[name];
      return Array.isArray(value) ? value : value === undefined ? [] : [value];
    },
  };
}

export function formSource(form: FormData): Source {
  return {
    get: (name) => {
      const value = form.get(name);
      return typeof value === 'string' ? value : null;
    },
    getAll: (name) =>
      form.getAll(name).filter((value): value is string => typeof value === 'string'),
  };
}

export function labelOf(ctx: AreaContext, label: FieldSpec['label']): string {
  return typeof label === 'string' ? ctx.t(label) : label.literal;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function parseFields(
  fields: readonly FieldSpec[],
  source: Source,
  ctx: AreaContext,
): { readonly values: FieldValues; readonly errors: Readonly<Record<string, string>> } {
  const values: Record<string, FieldValue> = {};
  const errors: Record<string, string> = {};
  const refuse = (
    field: FieldSpec,
    key: AreaCopyKey,
    extra: Record<string, string | number> = {},
  ) => {
    errors[field.id] = ctx.t(key, { field: labelOf(ctx, field.label), ...extra });
  };

  for (const field of fields) {
    const raw = (source.get(fieldName(field.id)) ?? '').trim();
    switch (field.kind) {
      case 'switch':
        values[field.id] = source.get(fieldName(field.id)) === 'on';
        break;
      case 'multi': {
        const allowed = new Set((field.options ?? []).map((option) => option.value));
        const chosen = [...new Set(source.getAll(fieldName(field.id)))];
        if (chosen.some((value) => !allowed.has(value))) refuse(field, 'v.choice');
        else if (field.required && chosen.length === 0) refuse(field, 'v.pickOne');
        else
          values[field.id] = (field.options ?? [])
            .map((o) => o.value)
            .filter((v) => chosen.includes(v));
        break;
      }
      case 'choice': {
        if (!(field.options ?? []).some((option) => option.value === raw))
          refuse(field, 'v.choice');
        else values[field.id] = raw;
        break;
      }
      case 'text': {
        if (field.required && raw === '') refuse(field, 'v.required');
        else if (field.maxLength !== undefined && raw.length > field.maxLength)
          refuse(field, 'v.tooLong', { max: field.maxLength });
        else if (field.pattern && raw !== '' && !field.pattern.test(raw))
          refuse(field, field.patternMessage ?? 'v.format');
        else values[field.id] = raw;
        break;
      }
      case 'times': {
        const parts = raw
          .split(/[,،\s]+/)
          .map((part) => part.trim())
          .filter(Boolean);
        if (parts.length === 0 || parts.some((part) => !TIME.test(part))) refuse(field, 'v.times');
        else if (field.max !== undefined && parts.length > field.max)
          refuse(field, 'v.tooMany', { max: field.max });
        else values[field.id] = [...new Set(parts)].sort();
        break;
      }
      case 'number': {
        if (field.unlimited && source.get(fieldName(field.id, 'none')) === 'on') {
          values[field.id] = null;
          break;
        }
        if (raw === '') {
          refuse(field, field.unlimited ? 'v.numberOrNone' : 'v.required');
          break;
        }
        if (!/^\d+$/.test(raw)) {
          refuse(field, 'v.wholeNumber');
          break;
        }
        const value = Number(raw);
        if (!Number.isSafeInteger(value)) refuse(field, 'v.wholeNumber');
        else if (field.min !== undefined && value < field.min)
          refuse(field, 'v.atLeast', { min: field.min });
        else if (field.max !== undefined && value > field.max)
          refuse(field, 'v.atMost', { max: field.max });
        else values[field.id] = value;
        break;
      }
      case 'money': {
        const minor: Record<string, number> = {};
        for (const currency of field.currencies ?? []) {
          const entered = (source.get(fieldName(field.id, currency)) ?? '').trim();
          try {
            minor[currency] = majorToMinor(entered, currency);
          } catch {
            refuse(field, 'v.money', { currency });
          }
        }
        values[field.id] = { kind: 'money', minor } satisfies MoneyValue;
        break;
      }
    }
  }
  return { values, errors };
}

/** A value as the editor's input shows it again (the preview's "Change" goes back with these). */
export function toQuery(
  fields: readonly FieldSpec[],
  values: FieldValues,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const field of fields) {
    const value = values[field.id];
    if (value === undefined) continue;
    switch (field.kind) {
      case 'switch':
        if (value === true) out[fieldName(field.id)] = 'on';
        break;
      case 'multi':
      case 'times':
        if (field.kind === 'times')
          out[fieldName(field.id)] = (value as readonly string[]).join(', ');
        else out[fieldName(field.id)] = [...(value as readonly string[])];
        break;
      case 'number':
        if (value === null) out[fieldName(field.id, 'none')] = 'on';
        else out[fieldName(field.id)] = String(value);
        break;
      case 'money':
        for (const [currency, minor] of Object.entries((value as MoneyValue).minor)) {
          out[fieldName(field.id, currency)] = minorToMajorInput(minor, currency);
        }
        break;
      default:
        out[fieldName(field.id)] = String(value);
    }
  }
  return out;
}

/** A value as a person reads it in a card or a preview sentence. */
export function displayValue(
  field: FieldSpec,
  value: FieldValue | undefined,
  ctx: AreaContext,
): string {
  if (value === undefined) return '—';
  switch (field.kind) {
    case 'switch':
      return ctx.t(value ? 'w.yes' : 'w.no');
    case 'number':
      if (value === null) return ctx.t('w.noLimit');
      return `${new Intl.NumberFormat(ctx.locale === 'ar' ? 'ar-u-nu-latn' : 'en').format(value as number)}${field.unit ? ` ${ctx.t(field.unit)}` : ''}`;
    case 'choice':
      return optionLabel(field, String(value), ctx);
    case 'multi':
      return (value as readonly string[]).length === 0
        ? ctx.t('w.none')
        : (value as readonly string[])
            .map((v) => optionLabel(field, v, ctx))
            .join(ctx.locale === 'ar' ? '، ' : ', ');
    case 'times':
      return (value as readonly string[]).join(ctx.locale === 'ar' ? '، ' : ', ');
    case 'money': {
      const entries = Object.entries((value as MoneyValue).minor);
      return entries.length === 0
        ? '—'
        : entries.map(([currency, minor]) => formatMinor(minor, currency, ctx.locale)).join(' · ');
    }
    default:
      return String(value) === '' ? '—' : String(value);
  }
}

function optionLabel(field: FieldSpec, value: string, ctx: AreaContext): string {
  const option = (field.options ?? []).find((candidate) => candidate.value === value);
  if (!option) return value;
  return typeof option.label === 'string' ? ctx.t(option.label) : option.label.literal;
}

/** Same value? Compared as JSON, so a list in the same order is the same list. */
export function sameValue(a: FieldValue | undefined, b: FieldValue | undefined): boolean {
  return sameJson(a ?? null, b ?? null);
}
