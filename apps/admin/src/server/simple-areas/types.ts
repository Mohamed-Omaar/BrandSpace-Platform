import type { ConfigDomain } from '@brandspace/config';
import type { BadgeTone } from '@brandspace/ui';
import type { AreaCopyKey } from '../../i18n/simple-areas';

/**
 * THE OWNER'S EVERYDAY CONTROL PANEL — the model every Simple area is built from.
 *
 * An AREA is a page of cards (Plans, Channels, Uploads…). A COLLECTION is one
 * group of cards on that page (Content has industries, posting times and the
 * channels' writing rules). An ITEM is one card: a plan, a channel, an industry.
 *
 * Every area is a PURE description over the configuration documents it reads:
 * how to show an item, which fields edit it, and how an edit becomes the next
 * document. Nothing here talks to the database. The one writer is
 * `proposeAndActivate`, i.e. the Configuration Service (D-312), the same path
 * Advanced uses — there is no second store and no parallel path.
 */

/** The active documents an area reads, by domain. */
export type Docs = Partial<Record<ConfigDomain, Record<string, unknown>>>;

export type FieldKind =
  /** A whole number, optionally with "No limit" (null). */
  | 'number'
  /** A price in major units, one per currency (D-313). */
  | 'money'
  /** Yes / no. */
  | 'switch'
  /** One of a short list. */
  | 'choice'
  /** Any of a short list. */
  | 'multi'
  /** A line of text. */
  | 'text'
  /** Times of day, "HH:MM", comma separated. */
  | 'times';

export interface FieldOption {
  readonly value: string;
  /** Either a copy key or literal text (a currency code, a MIME type). */
  readonly label: AreaCopyKey | { readonly literal: string };
}

export interface FieldSpec {
  readonly id: string;
  readonly kind: FieldKind;
  readonly label: AreaCopyKey | { readonly literal: string };
  /** One sentence: what the setting is. */
  readonly help: AreaCopyKey;
  /** One sentence: what customers notice when it changes. */
  readonly impact?: AreaCopyKey;
  readonly unit?: AreaCopyKey;
  readonly min?: number;
  readonly max?: number;
  /** Numbers: offer "No limit" (stored as null). */
  readonly unlimited?: boolean;
  readonly options?: readonly FieldOption[];
  readonly required?: boolean;
  readonly maxLength?: number;
  /** Text typed in one script: Latin for keys and addresses, Arabic for Arabic names. */
  readonly dir?: 'ltr' | 'rtl';
  /** Shown but not editable in this mode (the key of an existing item). */
  readonly lockedOnEdit?: boolean;
  /** Money: the currencies offered. */
  readonly currencies?: readonly string[];
  readonly pattern?: RegExp;
  readonly patternMessage?: AreaCopyKey;
}

/** A parsed value. Money is minor units per currency. */
export type FieldValue = string | number | boolean | null | readonly string[] | MoneyValue;
export type MoneyValue = { readonly kind: 'money'; readonly minor: Readonly<Record<string, number>> };

export type FieldValues = Readonly<Record<string, FieldValue>>;

export interface Fact {
  readonly label: string;
  readonly value: string;
}

export interface ItemView {
  readonly key: string;
  readonly title: string;
  readonly subtitle?: string | undefined;
  readonly status?: { readonly label: string; readonly tone: BadgeTone };
  readonly facts: readonly Fact[];
  /** The values the editor opens with. */
  readonly values: FieldValues;
  /** A plain reason this item cannot be archived / removed / hidden, if it cannot. */
  readonly archiveBlockedReason?: string;
  /** Extra content under the facts (a plan's customer preview). */
  readonly previewKind?: 'plan';
}

export type EditMode = 'edit' | 'new' | 'duplicate';

export interface AreaContext {
  readonly locale: string;
  readonly t: (key: AreaCopyKey, values?: Record<string, string | number>) => string;
  /** Customer workspaces per plan key. */
  readonly customersPerPlan: Readonly<Record<string, number>>;
  /** Content variants per platform key, across every workspace. */
  readonly variantsPerPlatform: Readonly<Record<string, number>>;
  /** Currencies prices may be entered in. */
  readonly currencies: readonly string[];
}

/** One slice of configuration an item owns, for undo: read it, and put it back. */
export interface ItemSlice {
  readonly domain: ConfigDomain;
  readonly read: (doc: Record<string, unknown>) => unknown;
  readonly write: (doc: Record<string, unknown>, value: unknown) => Record<string, unknown>;
}

export interface CollectionSpec {
  readonly id: string;
  readonly title: AreaCopyKey;
  readonly intro?: AreaCopyKey;
  readonly domains: readonly ConfigDomain[];
  readonly fields: (
    docs: Docs,
    ctx: AreaContext,
    mode: EditMode,
    itemKey: string | null,
  ) => readonly FieldSpec[];
  readonly items: (docs: Docs, ctx: AreaContext) => readonly ItemView[];
  /** The next documents (only the ones that change). */
  readonly apply: (
    docs: Docs,
    ctx: AreaContext,
    edit: { readonly mode: EditMode; readonly itemKey: string | null; readonly values: FieldValues },
  ) => Docs;
  /** Archive (plans: retire) or remove (industries, posting times, hide a channel). */
  readonly archive?: (docs: Docs, ctx: AreaContext, itemKey: string) => Docs;
  readonly archiveLabel?: AreaCopyKey;
  readonly canCreate?: boolean;
  readonly canDuplicate?: boolean;
  /**
   * Area rules the field checks cannot see (a channel with posts cannot be
   * hidden; a recommended range cannot pass the ceiling). Plain sentences;
   * any one refuses the change, at the preview and again at save.
   */
  readonly check?: (
    before: Docs,
    after: Docs,
    ctx: AreaContext,
    edit: { readonly mode: EditMode | 'archive'; readonly itemKey: string },
  ) => readonly string[];
  /** What customers will notice, in plain sentences, for this change. */
  readonly impact?: (before: Docs, after: Docs, ctx: AreaContext, itemKey: string) => readonly string[];
  /** The configuration the item owns, per domain, for "Undo last change". */
  readonly slices: (itemKey: string) => readonly ItemSlice[];
  /** The new item's key, from the edited values. */
  readonly keyOf: (values: FieldValues, mode: EditMode, itemKey: string | null) => string;
}

/** A setting this area deliberately leaves to Advanced, shown, never hidden. */
export interface DeveloperSetting {
  readonly label: AreaCopyKey;
  readonly value: (docs: Docs, ctx: AreaContext) => string;
}

export interface AreaSpec {
  readonly key: AreaKey;
  readonly title: AreaCopyKey;
  readonly intro: AreaCopyKey;
  readonly collections: readonly CollectionSpec[];
  readonly developer: readonly DeveloperSetting[];
  /** Where the area lives (Plans keeps its own route). */
  readonly href: (locale: string) => string;
  /** A guided set-up elsewhere in Simple (keys, Test, Activate). */
  readonly guided?: readonly { readonly label: AreaCopyKey; readonly href: string }[];
}

export type AreaKey =
  | 'plans'
  | 'trial'
  | 'channels'
  | 'publishing'
  | 'signups'
  | 'uploads'
  | 'content'
  | 'legal';
