import 'server-only';
import { cookies } from 'next/headers';
import { CUSTOMER_REALM } from '@brandspace/auth';
import { createLogger, internalErrorFields } from '@brandspace/shared';

const log = createLogger({ context: { component: 'dashboard.ai-apps' } });

/**
 * D-566 — CONNECTED AI APPS: THE DASHBOARD'S SIDE OF THE CONVERSATION.
 *
 * The dashboard cannot read configuration (F-07), so the consent screen and
 * Settings → Connected AI apps ask the API, forwarding the customer's own
 * session as a bearer exactly as `/v1/ai/availability` is asked. Every
 * decision — is the app known, is the redirect registered, may this person
 * connect it in this workspace — is the API's; this module only carries it.
 *
 * NOT KNOWN IS NOT ALLOWED: no API, no session or a malformed answer reads as
 * an error, never as permission.
 */

export interface AuthorizeParams {
  readonly response_type?: string;
  readonly client_id?: string;
  readonly redirect_uri?: string;
  readonly code_challenge?: string;
  readonly code_challenge_method?: string;
  readonly scope?: string;
  readonly state?: string;
  readonly resource?: string;
}

export const AUTHORIZE_PARAM_NAMES = [
  'response_type',
  'client_id',
  'redirect_uri',
  'code_challenge',
  'code_challenge_method',
  'scope',
  'state',
  'resource',
] as const;

export interface ConsentWorkspace {
  readonly id: string;
  readonly name: string;
  readonly available: boolean;
  readonly reason: 'off' | 'plan' | null;
  readonly brands: readonly { readonly id: string; readonly name: string }[];
}

export type ConsentCheck =
  | { readonly status: 'error'; readonly code: string }
  | { readonly status: 'redirect'; readonly redirectTo: string }
  | {
      readonly status: 'ok';
      readonly client: { readonly name: string; readonly redirectHost: string };
      readonly scopes: readonly string[];
      readonly workspaces: readonly ConsentWorkspace[];
    };

export interface AiAppConnectionRow {
  readonly id: string;
  readonly app: string;
  /** The https logo the app registered, or null. Shown only if it passes `appLogoSrc`. */
  readonly logoUri: string | null;
  readonly person: string | null;
  readonly mine: boolean;
  readonly brands: 'all' | readonly string[];
  readonly canWrite: boolean;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

export interface AiAppConnections {
  readonly available: boolean;
  readonly reason: 'off' | 'plan' | null;
  readonly manageAll: boolean;
  readonly mcpUrl: string | null;
  readonly connections: readonly AiAppConnectionRow[];
}

async function call(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ readonly status: number; readonly payload: unknown } | null> {
  const base = process.env['BRANDSPACE_API_URL'];
  const token = (await cookies()).get(CUSTOMER_REALM.cookieName)?.value;
  if (!base || !token) return null;
  try {
    const upstream = await fetch(`${base.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: 'no-store',
    });
    return { status: upstream.status, payload: await upstream.json().catch(() => null) };
  } catch (error: unknown) {
    log.warn('the AI apps API could not be reached', internalErrorFields(error));
    return null;
  }
}

export function authorizeParamsFrom(
  source: Readonly<Record<string, string | string[] | undefined>> | FormData,
): AuthorizeParams {
  const out: Record<string, string> = {};
  for (const name of AUTHORIZE_PARAM_NAMES) {
    const raw = source instanceof FormData ? source.get(name) : source[name];
    if (typeof raw === 'string' && raw.length <= 2000) out[name] = raw;
  }
  return out;
}

export async function checkAuthorization(params: AuthorizeParams): Promise<ConsentCheck> {
  const answer = await call('POST', '/v1/ai-apps/authorize/check', params);
  const payload = answer?.payload as ConsentCheck | null | undefined;
  if (!payload || typeof payload !== 'object' || !('status' in payload)) {
    return { status: 'error', code: answer?.status === 401 ? 'SIGNED_OUT' : 'UNAVAILABLE' };
  }
  return payload;
}

export async function decideAuthorization(
  params: AuthorizeParams,
  decision: {
    readonly decision: 'allow' | 'cancel';
    readonly workspaceId?: string;
    readonly brandMode?: 'all' | 'some';
    readonly brandIds?: readonly string[];
  },
): Promise<
  | { readonly status: 'redirect'; readonly redirectTo: string }
  | { readonly status: 'error'; readonly code: string }
> {
  const answer = await call('POST', '/v1/ai-apps/authorize/decide', { ...params, ...decision });
  const payload = answer?.payload as { status?: string; redirectTo?: string; code?: string } | null;
  if (payload?.status === 'redirect' && typeof payload.redirectTo === 'string') {
    return { status: 'redirect', redirectTo: payload.redirectTo };
  }
  return {
    status: 'error',
    code: typeof payload?.code === 'string' ? payload.code : 'UNAVAILABLE',
  };
}

export async function listAiAppConnections(): Promise<AiAppConnections | null> {
  const answer = await call('GET', '/v1/ai-apps/connections');
  if (!answer || answer.status !== 200) return null;
  const payload = answer.payload as AiAppConnections | null;
  return payload && Array.isArray(payload.connections) ? payload : null;
}

export async function revokeAiAppConnection(id: string): Promise<boolean> {
  const answer = await call('POST', `/v1/ai-apps/connections/${encodeURIComponent(id)}/revoke`, {
    confirm: true,
  });
  return answer?.status === 200;
}
