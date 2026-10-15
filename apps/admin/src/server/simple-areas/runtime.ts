import 'server-only';
import { AppError } from '@brandspace/shared';
import { parseConfigPayload, type ConfigDomain } from '@brandspace/config';
import type { AuthenticatedPlatformActor } from '@brandspace/auth';
import { areaCopy, type AreaCopyKey } from '../../i18n/simple-areas';
import { loadCustomersPerPlan } from '../owner-overview';
import {
  currentEnvironment,
  getConfigService,
  getPlatformPrisma,
  serviceActor,
} from '../platform-context';
import { proposeAndActivate } from '../simple-config';
import { arrayOf, rec, sameJson, str } from './json';
import type { AreaContext, CollectionSpec, Docs, ItemSlice } from './types';

/**
 * The server half of the Simple areas: read the active documents, build the
 * context the cards need, and write a change — always through
 * `proposeAndActivate`, i.e. the Configuration Service's own lifecycle (create
 * draft, validate, impact preview, activate), with its permission checks, its
 * MFA requirement, its dual control and its audit event (D-312).
 */

export async function loadDocs(domains: readonly ConfigDomain[]): Promise<Docs> {
  const config = getConfigService();
  const environment = currentEnvironment();
  const entries = await Promise.all(
    [...new Set(domains)].map(async (domain) => [
      domain,
      structuredClone(
        (await config.get(domain, environment)) as unknown as Record<string, unknown>,
      ),
    ]),
  );
  return Object.fromEntries(entries) as Docs;
}

/** Aggregate counts only: how many post versions each channel already carries. */
async function variantsPerPlatform(): Promise<Record<string, number>> {
  const rows = await getPlatformPrisma().contentVariant.groupBy({
    by: ['platformKey'],
    _count: { _all: true },
  });
  return Object.fromEntries(rows.map((row) => [row.platformKey, row._count._all]));
}

export async function areaContext(locale: string, docs: Docs): Promise<AreaContext> {
  const [perPlan, perPlatform, operations] = await Promise.all([
    loadCustomersPerPlan(),
    variantsPerPlatform(),
    docs.operations
      ? Promise.resolve(docs.operations)
      : loadDocs(['operations']).then((d) => d.operations ?? {}),
  ]);
  const planCurrencies = arrayOf(docs.plans?.['plans'])
    .flatMap((plan) => arrayOf(rec(plan)['prices']).map((price) => str(rec(price)['currency'])))
    .filter(Boolean);
  const supported = arrayOf(rec(operations)['supportedCurrencies']).map(str).filter(Boolean);
  const t = areaCopy(locale);
  return {
    locale,
    t: (key: AreaCopyKey, values?: Record<string, string | number>) => t(key, values),
    customersPerPlan: Object.fromEntries(perPlan),
    variantsPerPlatform: perPlatform,
    currencies: [...new Set([...supported, ...planCurrencies])],
  };
}

export function mayChange(actor: AuthenticatedPlatformActor): boolean {
  return (
    actor.permissionKeys.includes('platform.configuration.manage') &&
    actor.permissionKeys.includes('platform.configuration.activate')
  );
}

/**
 * Write the next documents, one domain at a time, through the service.
 * Each domain is its own activation (the service's unit of change); a refusal
 * stops before the next one, and the ones already activated are reported.
 */
/**
 * A change that writes two documents saved the first and was refused on a
 * later one (D-558: sequential activations, not one transaction). What was
 * activated stays; the owner is told which part is missing and may try it
 * again (`retryPartAction`).
 */
export class PartialWrite extends Error {
  constructor(
    readonly written: readonly ConfigDomain[],
    readonly failed: ConfigDomain,
    readonly refusal: unknown,
  ) {
    super('PARTIAL_WRITE');
    this.name = 'PartialWrite';
  }
}

export async function writeDocs(input: {
  readonly actor: AuthenticatedPlatformActor;
  readonly before: Docs;
  readonly after: Docs;
  readonly reason: string;
}): Promise<readonly ConfigDomain[]> {
  const written: ConfigDomain[] = [];
  const changed = (Object.keys(input.after) as ConfigDomain[]).filter(
    (domain) => !sameJson(input.before[domain], input.after[domain]),
  );
  if (changed.length === 0) throw new AppError('CONFLICT', 'UNCHANGED');
  for (const domain of changed) {
    const next = input.after[domain] as Record<string, unknown>;
    try {
      await proposeAndActivate<Record<string, unknown>>({
        actor: input.actor,
        domain,
        reason: input.reason,
        acknowledged: true,
        change: () => structuredClone(next),
        unchanged: (active) => sameJson(active, next),
      });
    } catch (error: unknown) {
      if (written.length > 0) throw new PartialWrite([...written], domain, error);
      throw error;
    }
    written.push(domain);
  }
  return written;
}

export interface UndoTarget {
  readonly domain: ConfigDomain;
  readonly slice: ItemSlice;
  readonly value: unknown;
  /** When the change being undone was made. */
  readonly changedAt: Date;
}

/**
 * "UNDO LAST CHANGE", PER ITEM. For each slice of configuration the item owns,
 * walk the domain's activated versions newest first and find the most recent
 * one where this item's slice differs from what is live; the most recent such
 * change across the slices is the one undone, by putting the slice back to its
 * value before that change — as a NEW version through the same service, never
 * by rewriting history.
 *
 * Versions are compared PARSED, so a default the stored payload omitted does
 * not read as a change.
 */
export async function findUndo(
  actor: AuthenticatedPlatformActor,
  collection: CollectionSpec,
  itemKey: string,
  limit = 40,
): Promise<UndoTarget | null> {
  const config = getConfigService();
  const environment = currentEnvironment();
  const service = serviceActor(actor);
  let best: UndoTarget | null = null;
  for (const slice of collection.slices(itemKey)) {
    const versions = (await config.listVersions(service, slice.domain, environment))
      .filter(
        (version) =>
          version.activatedAt !== null &&
          (version.status === 'ACTIVE' || version.status === 'SUPERSEDED'),
      )
      .sort((a, b) => (b.activatedAt?.getTime() ?? 0) - (a.activatedAt?.getTime() ?? 0))
      .slice(0, limit);
    if (versions.length < 2) continue;
    const read = async (id: string) =>
      slice.read(
        parseConfigPayload(
          slice.domain,
          (await config.getVersion(service, id)).payload,
        ) as unknown as Record<string, unknown>,
      );
    const live = await read(versions[0]!.id);
    let newer = versions[0]!;
    for (const version of versions.slice(1)) {
      const value = await read(version.id);
      if (!sameJson(value ?? null, live ?? null)) {
        const changedAt = newer.activatedAt as Date;
        if (!best || changedAt > best.changedAt)
          best = { domain: slice.domain, slice, value, changedAt };
        break;
      }
      newer = version;
    }
  }
  return best;
}
