import {
  AiGateway,
  AiProviderError,
  ConfigurationAiSource,
  aiAvailableFor,
  customerMessageFor,
  type ProviderCredentialSource,
} from '@brandspace/ai-gateway';
import {
  DEVELOPMENT_ONLY_AI_ADAPTERS,
  aiAdapterRegistry,
  registeredAiAdapterKeys,
} from '@brandspace/ai-gateway/adapters';
import type { FactModelPort } from '@brandspace/brand-brain';
import { ConfigurationService } from '@brandspace/config';
import { getPlatformClient } from '@brandspace/database/platform';
import { CreditLedgerService } from '@brandspace/entitlements';
import { SecretService } from '@brandspace/secrets';
import { createLogger, currentEnvironment, isAppError } from '@brandspace/shared';

/**
 * PR B (D-591) — `brand.extract` FROM THE WORKER, through the ONE AI gateway
 * (reserve → confirm → settle, D-14): the worker reads a source whole with one
 * model call, made between reading the file and the short write transaction
 * (never inside it, H-4).
 *
 * AVAILABLE OR NOT AT ALL. The call is made only when the task has a route to
 * an active provider whose adapter is registered here — the same rule as
 * `GET /v1/ai/availability`. Otherwise, and whenever the call fails (no price
 * active, no credential, the provider erred), the port answers null and the
 * source is read with today's keyword extraction; a failed call is released,
 * never charged, and the job records no AI request, so the screen says which.
 */
const log = createLogger({ context: { component: 'worker.brand-extract' } });

let gateway: AiGateway | null = null;
let configuration: ConfigurationAiSource | null = null;

function secretsSource(): ProviderCredentialSource {
  const secrets = new SecretService({ prisma: getPlatformClient() });
  return {
    async resolve(secretRef) {
      if (!secretRef) return null;
      try {
        return await secrets.resolveSecret(secretRef, currentEnvironment());
      } catch (error) {
        if (isAppError(error) && error.code === 'NOT_FOUND') return null;
        throw new AiProviderError(
          'AUTH_ERROR',
          customerMessageFor('AUTH_ERROR'),
          'The provider credential could not be read from the vault.',
        );
      }
    },
  };
}

function aiGateway(): AiGateway {
  const environment = currentEnvironment();
  configuration ??= new ConfigurationAiSource(
    new ConfigurationService({ prisma: getPlatformClient() }),
    environment,
  );
  gateway ??= new AiGateway({
    prisma: getPlatformClient(),
    ledger: new CreditLedgerService({ prisma: getPlatformClient() }),
    adapters: aiAdapterRegistry(environment),
    configuration,
    credentials: secretsSource(),
    environment,
  });
  return gateway;
}

export function brandExtractPort(input: {
  readonly workspaceId: string;
  readonly planKey: string | null;
  /** One logical action per ingestion attempt: a redelivery replays, never re-pays. */
  readonly idempotencyKey: string;
}): FactModelPort {
  return {
    async complete(request) {
      try {
        const environment = currentEnvironment();
        const production = environment === 'PRODUCTION';
        const ai = aiGateway();
        const loaded = await new ConfigurationAiSource(
          new ConfigurationService({ prisma: getPlatformClient(), cacheTtlMs: 0 }),
          environment,
        ).load();
        const available = aiAvailableFor(
          'brand.extract',
          { workspaceId: input.workspaceId, planKey: input.planKey },
          loaded,
          {
            registered: registeredAiAdapterKeys(production),
            production,
            developmentOnly: DEVELOPMENT_ONLY_AI_ADAPTERS,
          },
        );
        if (!available) return null;
        const result = await ai.execute({
          workspaceId: input.workspaceId,
          userId: null,
          taskKey: 'brand.extract',
          planKey: input.planKey,
          idempotencyKey: input.idempotencyKey,
          input: {
            kind: 'text',
            prompt: request.prompt,
            untrustedContext: [...request.context],
          },
        });
        if (result.status !== 'SUCCEEDED' || result.output?.kind !== 'text') return null;
        return { text: result.output.text, requestId: result.requestId };
      } catch (error) {
        // Identifiers only: no file name, no text, no provider payload.
        log.warn('brand.extract unavailable; using today’s extraction', {
          workspaceId: input.workspaceId,
          errorName: error instanceof Error ? error.name : 'unknown',
        });
        return null;
      }
    },
  };
}
