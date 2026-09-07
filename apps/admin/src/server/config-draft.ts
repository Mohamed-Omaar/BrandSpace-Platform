import 'server-only';
import { AppError } from '@brandspace/shared';
import {
  defaultPayload,
  type ConfigDomain,
  type ConfigVersionSummary,
  type ImpactPreview,
  type ValidationReport,
} from '@brandspace/config';
import type { AuthenticatedPlatformActor } from '@brandspace/auth';
import { currentEnvironment, getConfigService, serviceActor } from './platform-context';

/**
 * Structured editing over versioned configuration.
 *
 * Every Phase 3 editor — plans, features, flags, cohorts, credit policy — is a
 * FORM over a configuration draft, not a JSON textarea. They all need the same
 * five things, and repeating them per page is how the lifecycle rules drift:
 *
 *   1. the ACTIVE payload, which is what customers are resolving against now,
 *   2. the open DRAFT if there is one, with its lock version,
 *   3. read-modify-write of one item inside a collection, under that lock,
 *   4. the validation report and impact preview,
 *   5. the version history.
 *
 * Nothing here authorises anything. Every call goes through the Configuration
 * Service, which re-checks the actor's permission itself — the page guard and
 * the action guard are convenience, not the control (R-02).
 */

export interface DomainEditorState {
  readonly domain: ConfigDomain;
  readonly environment: 'DEVELOPMENT' | 'STAGING' | 'PRODUCTION';
  /** What is live right now. Empty when the owner has activated nothing. */
  readonly activePayload: Record<string, unknown>;
  readonly activeVersion: ConfigVersionSummary | null;
  /** The open draft, if one exists. */
  readonly draft: (ConfigVersionSummary & { payload: Record<string, unknown> }) | null;
  readonly versions: readonly ConfigVersionSummary[];
  readonly validation: ValidationReport | null;
  readonly impact: ImpactPreview | null;
}

/** Everything a domain editor page needs, in one round of queries. */
export async function loadDomainEditor(
  actor: AuthenticatedPlatformActor,
  domain: ConfigDomain,
): Promise<DomainEditorState> {
  const config = getConfigService();
  const environment = currentEnvironment();
  const service = serviceActor(actor);

  const versions = await config.listVersions(service, domain, environment);
  const activeSummary = versions.find((v) => v.status === 'ACTIVE') ?? null;
  // A draft and a validated draft are both editable; only one of each can be
  // open at a time, and VALIDATED is the state an activation is launched from.
  const draftSummary =
    versions.find((v) => v.status === 'DRAFT' || v.status === 'VALIDATED') ?? null;

  const activePayload = activeSummary
    ? ((await config.getVersion(service, activeSummary.id)).payload as Record<string, unknown>)
    : (defaultPayload(domain) as Record<string, unknown>);

  const draft = draftSummary
    ? {
        ...draftSummary,
        payload: (await config.getVersion(service, draftSummary.id)).payload as Record<
          string,
          unknown
        >,
      }
    : null;

  return {
    domain,
    environment,
    activePayload,
    activeVersion: activeSummary,
    draft,
    versions,
    validation: (draftSummary?.validationReport as ValidationReport | null) ?? null,
    impact: (draftSummary?.impactPreview as ImpactPreview | null) ?? null,
  };
}

/**
 * Insert or replace one item inside a draft's collection, by its natural key.
 *
 * Read-modify-write under the draft's lock version, so two operators editing
 * different plans in the same draft cannot silently discard each other's work:
 * the second save is refused and the operator is told to reload, rather than
 * the first edit vanishing.
 *
 * If no draft is open, one is created from the ACTIVE payload first — which is
 * what makes "edit a plan" a single action for the operator instead of a
 * two-step ritual they have to remember.
 */
export async function upsertCollectionItem(
  actor: AuthenticatedPlatformActor,
  domain: ConfigDomain,
  options: {
    readonly field: string;
    readonly keyField: string;
    readonly key: string;
    readonly item: Record<string, unknown>;
    readonly reason: string;
    readonly expectedLockVersion?: number | null;
  },
): Promise<void> {
  const config = getConfigService();
  const service = serviceActor(actor);
  const state = await loadDomainEditor(actor, domain);

  let draft = state.draft;
  if (!draft) {
    const created = await config.createDraft(service, domain, state.environment, options.reason);
    draft = {
      ...created,
      payload: (await config.getVersion(service, created.id)).payload as Record<string, unknown>,
    };
  }

  // The operator's page was rendered against a specific version. If it moved
  // underneath them, refuse rather than overwrite.
  if (
    options.expectedLockVersion !== undefined &&
    options.expectedLockVersion !== null &&
    draft.lockVersion !== options.expectedLockVersion
  ) {
    throw new AppError(
      'CONFLICT',
      'This draft changed since the page was loaded. Reload before saving.',
      { expectedLockVersion: options.expectedLockVersion },
    );
  }

  const payload = { ...draft.payload };
  const collection = [...((payload[options.field] ?? []) as Record<string, unknown>[])];
  const index = collection.findIndex((row) => String(row[options.keyField]) === options.key);

  if (index >= 0) {
    // MERGE rather than replace. A form posts the fields it renders; anything
    // the editor does not show — a field added by a later schema version, or one
    // a narrower screen omits — must survive the save rather than be erased by
    // absence.
    collection[index] = { ...collection[index], ...options.item };
  } else {
    collection.push(options.item);
  }

  payload[options.field] = collection;
  await config.updateDraft(service, draft.id, payload, draft.lockVersion);
}

/** Remove one item from a draft's collection. */
export async function removeCollectionItem(
  actor: AuthenticatedPlatformActor,
  domain: ConfigDomain,
  options: {
    readonly field: string;
    readonly keyField: string;
    readonly key: string;
    readonly reason: string;
  },
): Promise<void> {
  const config = getConfigService();
  const service = serviceActor(actor);
  const state = await loadDomainEditor(actor, domain);

  let draft = state.draft;
  if (!draft) {
    const created = await config.createDraft(service, domain, state.environment, options.reason);
    draft = {
      ...created,
      payload: (await config.getVersion(service, created.id)).payload as Record<string, unknown>,
    };
  }

  const payload = { ...draft.payload };
  const collection = ((payload[options.field] ?? []) as Record<string, unknown>[]).filter(
    (row) => String(row[options.keyField]) !== options.key,
  );
  payload[options.field] = collection;
  await config.updateDraft(service, draft.id, payload, draft.lockVersion);
}

/**
 * Replace a whole collection inside a draft.
 *
 * For collections with no single natural key — `planEntitlements` is keyed on
 * the PAIR (plan, feature) — where an upsert-by-key would append rather than
 * replace, and a plan would end up granting the same feature twice with
 * different answers.
 */
export async function replaceCollection(
  actor: AuthenticatedPlatformActor,
  domain: ConfigDomain,
  options: {
    readonly field: string;
    readonly rows: readonly Record<string, unknown>[];
    readonly reason: string;
  },
): Promise<void> {
  const config = getConfigService();
  const service = serviceActor(actor);
  const state = await loadDomainEditor(actor, domain);

  let draft = state.draft;
  if (!draft) {
    const created = await config.createDraft(service, domain, state.environment, options.reason);
    draft = {
      ...created,
      payload: (await config.getVersion(service, created.id)).payload as Record<string, unknown>,
    };
  }

  await config.updateDraft(
    service,
    draft.id,
    { ...draft.payload, [options.field]: options.rows },
    draft.lockVersion,
  );
}

/** The rows a domain's collection currently has, draft first then active. */
export async function currentCollection(
  actor: AuthenticatedPlatformActor,
  domain: ConfigDomain,
  field: string,
): Promise<Record<string, unknown>[]> {
  const state = await loadDomainEditor(actor, domain);
  const source = state.draft?.payload ?? state.activePayload;
  return [...((source[field] ?? []) as Record<string, unknown>[])];
}

/** Replace a scalar domain's whole document — the credit-policy editor. */
export async function replaceDocument(
  actor: AuthenticatedPlatformActor,
  domain: ConfigDomain,
  document: Record<string, unknown>,
  reason: string,
): Promise<void> {
  const config = getConfigService();
  const service = serviceActor(actor);
  const state = await loadDomainEditor(actor, domain);

  let draft = state.draft;
  if (!draft) {
    const created = await config.createDraft(service, domain, state.environment, reason);
    draft = {
      ...created,
      payload: (await config.getVersion(service, created.id)).payload as Record<string, unknown>,
    };
  }
  await config.updateDraft(service, draft.id, { ...draft.payload, ...document }, draft.lockVersion);
}
