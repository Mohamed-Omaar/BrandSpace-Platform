import { createHash } from 'node:crypto';
import { AppError, assertBrandInScope, type Clock, systemClock } from '@brandspace/shared';
import type { TenantScopedClient } from '@brandspace/database';
import { writeAuditEvent } from '@brandspace/database';
import type { AiGateway, AiGatewayResult } from '@brandspace/ai-gateway';
import type { AssetActor, AssetUploadService } from '@brandspace/assets';
import { CREATIVE_FORMATS, findCreativeFormat, type CreativeFormat } from './formats';

/**
 * THE AI CREATIVE STUDIO (AC-28).
 *
 * ONE IMAGE, GENERATED AND THEN STORED, and the order matters: the gateway
 * meters and settles the generation, and only a SUCCEEDED result with bytes
 * becomes an asset. A failed generation leaves nothing behind — no half-asset,
 * no orphan row, no charge (AC-28.6).
 *
 * IT DOES NOT TOUCH CREDITS ITSELF. Reserve → execute → settle lives entirely
 * in `AiGateway`, which is the only thing in this product allowed to move the
 * ledger, and it is idempotent on the key this service hands it. A second
 * service doing its own accounting is two ledgers (CLAUDE.md §2.4).
 *
 * THE FILE GOES INTO THE ONE ASSET LIBRARY. Not a parallel AI image store:
 * the same `AssetUploadService` a person's own upload goes through, so a
 * generated image gets the same scanner, the same quota, the same versioning,
 * the same download grants and the same brand rules. `AssetSource.AI_GENERATED`
 * and the `aiRequestId` are the only difference, and they exist so a customer
 * can always tell what a model made from what they made.
 *
 * BRAND IDENTITY GUIDES GENERATION; IT DOES NOT OVERLAY IT (D-193, AC-28.7).
 * The brand's palette, typography and description shape the PROMPT. Nothing
 * here composites a logo onto the result — stamping artwork is a design act the
 * product has not been asked to perform and could not undo.
 *
 * NO MODEL, PROVIDER OR PROMPT REACHES THE CUSTOMER (AC-28.8). The result
 * carries an asset id and a credit figure. What routed it is an operator's
 * record, and `docs/AI-GATEWAY.md` keeps it there.
 */

export interface CreativeStudioOptions {
  readonly db: TenantScopedClient;
  readonly workspaceId: string;
  readonly gateway: AiGateway;
  readonly uploads: AssetUploadService;
  readonly clock?: Clock;
}

/** What the brand contributes to a generation. Read, never invented. */
export interface BrandIdentityInput {
  readonly name: string;
  readonly industry: string | null;
  readonly description: string | null;
  readonly palette: readonly string[];
  readonly typography: readonly string[];
  /** Approved Brand Brain lines, already retrieved and already permitted. */
  readonly knowledge: readonly string[];
}

export interface GenerateCreativeInput {
  readonly brandId: string;
  /** What the customer asked for, in their own words. */
  readonly brief: string;
  /** A key from `CREATIVE_FORMATS`. Decides the size and the aspect. */
  readonly formatKey: string;
  readonly identity: BrandIdentityInput;
  readonly idempotencyKey: string;
  readonly actorUserId: string;
  readonly planKey: string | null;
  readonly actor: AssetActor;
}

export interface GeneratedCreative {
  readonly assetId: string;
  readonly aiRequestId: string;
  readonly creditsChargedMilli: bigint;
  readonly format: CreativeFormat;
  readonly replayed: boolean;
}

const BRIEF_MAX = 1_000;

export function creativeBriefRequired(): AppError {
  return new AppError('VALIDATION_FAILED', 'Describe the image you want.');
}

export function unknownCreativeFormat(): AppError {
  return new AppError('VALIDATION_FAILED', 'That output format is not one this product offers.');
}

export function creativeGenerationFailed(message: string | null): AppError {
  /*
   * `CONFLICT`, matching what the Content Studio answers for the same
   * condition. The error taxonomy has no AI-specific code and should not gain
   * one here: a generation that did not produce a usable result is a state the
   * caller can retry, and the CUSTOMER-SAFE message is the gateway's own.
   * Never a provider's.
   */
  return new AppError('CONFLICT', message ?? 'The image could not be generated. Try again.');
}

export function creativeReturnedNoBytes(): AppError {
  /*
   * A PROVIDER THAT RETURNED A REFERENCE AND NO BYTES is a provider this
   * product cannot yet store from — a url-returning adapter needs a fetch step
   * that belongs outside the gateway (Phase 10). Until one exists, this is an
   * honest failure rather than an empty asset.
   */
  return new AppError('CONFLICT', 'The image could not be retrieved. Try again.');
}

export class CreativeStudioService {
  readonly #db: TenantScopedClient;
  readonly #workspaceId: string;
  readonly #gateway: AiGateway;
  readonly #uploads: AssetUploadService;
  readonly #clock: Clock;

  constructor(options: CreativeStudioOptions) {
    this.#db = options.db;
    this.#workspaceId = options.workspaceId;
    this.#gateway = options.gateway;
    this.#uploads = options.uploads;
    this.#clock = options.clock ?? systemClock;
  }

  /** What one generation would cost, before anything is spent (AC-28.5). */
  async quote(input: {
    readonly formatKey: string;
    readonly planKey: string | null;
  }): Promise<{ estimateMilli: bigint }> {
    const format = findCreativeFormat(input.formatKey);
    if (!format) throw unknownCreativeFormat();
    const quote = await this.#gateway.quote({
      workspaceId: this.#workspaceId,
      taskKey: 'image.generate',
      planKey: input.planKey,
      input: { kind: 'image', prompt: '', count: 1, size: format.size },
    });
    return { estimateMilli: quote.estimateMilli };
  }

  async generate(input: GenerateCreativeInput): Promise<GeneratedCreative> {
    // BEFORE ANYTHING IS READ OR SPENT. A brand outside the member's scope must
    // be indistinguishable from one that does not exist.
    assertBrandInScope(input.actor.brandScope, input.brandId);

    const brief = input.brief.trim();
    if (brief === '') throw creativeBriefRequired();

    const format = findCreativeFormat(input.formatKey);
    if (!format) throw unknownCreativeFormat();

    /*
     * THE ASSET IS THE DURABLE ARTIFACT, SO THE REPLAY CHECK COMES FIRST.
     *
     * The gateway is idempotent, but a replay returns the RECORDED OUTCOME —
     * and this task runs with `persistOutput: false` (D-78), because the image
     * belongs in the Asset Library and asking the gateway to keep a copy would
     * make it a second media store. So a replayed generation has no bytes to
     * hand back, and a service that went straight to the gateway on a retry
     * would get a successful-but-empty result and report a failure for work
     * that had in fact succeeded.
     *
     * The upload session already carries request idempotency, keyed by the
     * CUSTOMER'S key. Finding a completed one means this generation has already
     * happened: return the asset, call no provider, and move no credit.
     */
    const uploadKey = `creative:${input.idempotencyKey}`;
    const replayed = await this.#existingAsset(uploadKey, format);
    if (replayed) return replayed;

    /*
     * THE GATEWAY OWNS THE MONEY. It reserves against the wallet, executes,
     * and settles or releases — idempotently, on this key. A retry with the
     * same key returns the first outcome rather than charging again (AC-28.6).
     */
    const result: AiGatewayResult = await this.#gateway.execute({
      workspaceId: this.#workspaceId,
      userId: input.actorUserId,
      taskKey: 'image.generate',
      planKey: input.planKey,
      idempotencyKey: `creative-studio:${input.idempotencyKey}`,
      input: {
        kind: 'image',
        prompt: this.#prompt(brief.slice(0, BRIEF_MAX), format, input.identity),
        count: 1,
        size: format.size,
      },
    });

    if (result.status !== 'SUCCEEDED' || result.output?.kind !== 'image') {
      /*
       * A RACE PAST THE CHECK ABOVE LANDS HERE, and it is not a failure: two
       * requests with the same key, the first still in flight when the second
       * arrived. The gateway replayed rather than charging twice, so the bytes
       * are gone but the ASSET exists — look for it before reporting anything.
       */
      if (result.replayed) {
        const raced = await this.#existingAsset(uploadKey, format);
        if (raced) return raced;
      }
      // Nothing is stored. The gateway has already settled or released.
      throw creativeGenerationFailed(result.failureMessage);
    }

    const image = result.output.images?.[0];
    if (!image?.base64 || !image.mimeType) throw creativeReturnedNoBytes();

    const bytes = new Uint8Array(Buffer.from(image.base64, 'base64'));
    if (bytes.byteLength === 0) throw creativeReturnedNoBytes();

    /*
     * THE SAME UPLOAD PATH A PERSON'S OWN FILE TAKES. Signature-checked,
     * quota-counted, scanned, versioned. The idempotency key is derived from
     * the AI REQUEST, so a replayed generation cannot produce a second asset
     * and a retried store returns the first one.
     */
    const session = await this.#uploads.initiate({
      brandId: input.brandId,
      folderId: null,
      fileName: this.#fileName(brief, format, image.ref),
      mimeType: image.mimeType,
      sizeBytes: bytes.byteLength,
      idempotencyKey: uploadKey,
      actor: input.actor,
    });

    const stored = await this.#uploads.complete({
      sessionId: session.session.id,
      bytes,
      actor: input.actor,
      provenance: { source: 'AI_GENERATED', aiRequestId: result.requestId },
    });

    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'creative.image.generated',
      actorType: 'USER',
      actorId: input.actorUserId,
      resourceType: 'Asset',
      resourceId: stored.asset.id,
      brandId: input.brandId,
      after: {
        formatKey: format.key,
        aiRequestId: result.requestId,
        // NO PROMPT, NO MODEL, NO PROVIDER. The request row already holds the
        // operator's side of this; an audit event is read by the customer.
        creditsChargedMilli: result.creditsChargedMilli.toString(),
      },
    });

    return {
      assetId: stored.asset.id,
      aiRequestId: result.requestId,
      creditsChargedMilli: result.creditsChargedMilli,
      format,
      replayed: result.replayed || stored.replayed,
    };
  }

  /**
   * The asset a previous run of this exact request already produced.
   *
   * SCOPED BY THE TENANT CLIENT, so another workspace's session is invisible,
   * and by `assetId` being set, which only a COMPLETED session has. A session
   * that was started and abandoned leaves this null and the generation runs.
   */
  async #existingAsset(
    uploadKey: string,
    format: CreativeFormat,
  ): Promise<GeneratedCreative | null> {
    const session = await this.#db.assetUploadSession.findFirst({
      where: { idempotencyKey: uploadKey, status: 'COMPLETED', assetId: { not: null } },
      select: { assetId: true },
    });
    if (!session?.assetId) return null;

    const asset = await this.#db.asset.findFirst({
      where: { id: session.assetId, deletedAt: null },
      select: { id: true, aiRequestId: true },
    });
    if (!asset) return null;

    return {
      assetId: asset.id,
      aiRequestId: asset.aiRequestId ?? '',
      // NOTHING WAS CHARGED THIS TIME. The first run's charge stands, and
      // reporting it again would let a caller add two numbers that are one.
      creditsChargedMilli: 0n,
      format,
      replayed: true,
    };
  }

  /**
   * The prompt, built from the brief and the brand's own identity.
   *
   * WHAT GOES IN, AND WHY EACH PART. The brief is what the customer asked for.
   * The palette and typography are the brand's declared identity (D-193), so a
   * generated image looks like it belongs to them rather than to the model's
   * default taste. Brand Brain lines are included only when the caller has
   * already retrieved and permitted them — this service never reaches into the
   * brain itself, because retrieval has its own scope rules and a second
   * implementation of them is a second set of answers.
   *
   * NO LOGO INSTRUCTION. Identity informs the image; nothing asks a model to
   * reproduce a wordmark, which it cannot do faithfully and which the product
   * must not imply it has done.
   */
  #prompt(brief: string, format: CreativeFormat, identity: BrandIdentityInput): string {
    const lines: string[] = [
      'Create a single on-brand marketing image.',
      `Intended use: ${format.label} at ${format.size} (${format.aspect}).`,
      `Brand: ${identity.name}.`,
    ];
    if (identity.industry) lines.push(`Industry: ${identity.industry}.`);
    if (identity.description) lines.push(`About the brand: ${identity.description}`);
    if (identity.palette.length > 0) {
      lines.push(`Use this colour palette: ${identity.palette.join(', ')}.`);
    }
    if (identity.typography.length > 0) {
      lines.push(`Typographic character: ${identity.typography.join(', ')}.`);
    }
    for (const line of identity.knowledge) lines.push(`Brand note: ${line}`);
    lines.push('Do not render a logo, a wordmark or any brand lettering.');
    lines.push(`Request: ${brief}`);
    return lines.join('\n');
  }

  /**
   * A stable, readable file name.
   *
   * DERIVED, NOT TAKEN FROM THE BRIEF VERBATIM: a brief is customer prose and
   * can contain anything, including path separators and control characters. A
   * short slug plus a fingerprint is recognisable in a library listing and
   * cannot be used to smuggle a path (docs/SECURITY.md §11.2).
   */
  #fileName(brief: string, format: CreativeFormat, ref: string): string {
    const slug =
      brief
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'creative';
    const fingerprint = createHash('sha256').update(ref).digest('hex').slice(0, 8);
    return `${slug}-${format.key}-${fingerprint}.png`;
  }

  /** The formats this product offers, for a screen that has to list them. */
  static formats(): readonly CreativeFormat[] {
    return CREATIVE_FORMATS;
  }

  /** Exposed so a caller can stamp a deterministic key. Never a clock read. */
  now(): Date {
    return this.#clock.now();
  }
}
