import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultPayload, parseConfigPayload } from '@brandspace/config';
import { redact } from '@brandspace/shared';
import {
  addressesFrom,
  authorizationRedirect,
  authorizationServerMetadata,
  bearerChallenge,
  grantedScopes,
  isAcceptableRedirectUri,
  isS256Challenge,
  looksLike,
  newSecret,
  pkceS256Matches,
  protectedResourceMetadata,
  redirectUriRegistered,
  resourceUrl,
  sha256Hex,
} from '../../apps/api/src/ai-apps/oauth-core';
import {
  HELP_COPY,
  HELP_TOPICS,
  WHAT_ONLY_A_PERSON_CAN_DO,
  WHAT_THE_AI_CAN_DO,
} from '../../apps/api/src/ai-apps/help';
import { TOOL_NAMES, cleanText, effectiveBrandScope } from '../../apps/api/src/ai-apps/tools';

/**
 * D-566 — CONNECTED AI APPS: THE PURE PIECES.
 *
 * PKCE against the RFC 7636 test vector, the scope rules, the redirect rules
 * (MCP spec: https or loopback; loopback on any port, RFC 8252 §7.3), the two
 * metadata documents field by field, the 401 challenge, token shapes and their
 * redaction, the help copy in both languages, and — the line the owner drew —
 * the tool list: exactly the eleven approved tools, and no code path that
 * approves, schedules, publishes, archives, deletes, disconnects, bills or
 * changes the team is reachable from the MCP module.
 */

const ADDRESSES = { api: 'https://api.example.test', dashboard: 'https://app.example.test' };

describe('PKCE S256 (RFC 7636 Appendix B)', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
  it('accepts the RFC test vector', () => expect(pkceS256Matches(verifier, challenge)).toBe(true));
  it('refuses a wrong, short, missing or plain verifier', () => {
    expect(pkceS256Matches(`${verifier}x`, challenge)).toBe(false);
    expect(pkceS256Matches('short', challenge)).toBe(false);
    expect(pkceS256Matches(undefined, challenge)).toBe(false);
    // `plain` would be the challenge itself; S256 never matches it.
    expect(pkceS256Matches(challenge, challenge)).toBe(false);
  });
  it('recognises only a 43-character base64url challenge', () => {
    expect(isS256Challenge(challenge)).toBe(true);
    expect(isS256Challenge('plain-challenge')).toBe(false);
    expect(isS256Challenge(undefined)).toBe(false);
  });
});

describe('scopes', () => {
  it('grants the known scopes asked for, always read, and the default pair when none', () => {
    expect(grantedScopes('brandspace.write offline_access')).toEqual([
      'brandspace.read',
      'brandspace.write',
      'offline_access',
    ]);
    expect(grantedScopes(undefined)).toEqual(['brandspace.read', 'brandspace.write']);
    expect(grantedScopes('openid profile brandspace.admin')).toEqual(['brandspace.read']);
  });
});

describe('redirect URIs', () => {
  it('accepts https and loopback http; refuses anything else', () => {
    expect(isAcceptableRedirectUri('https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(isAcceptableRedirectUri('https://chatgpt.com/connector_platform_oauth_redirect')).toBe(
      true,
    );
    expect(isAcceptableRedirectUri('http://127.0.0.1:33418/callback')).toBe(true);
    expect(isAcceptableRedirectUri('http://localhost/callback')).toBe(true);
    expect(isAcceptableRedirectUri('http://evil.example.test/cb')).toBe(false);
    expect(isAcceptableRedirectUri('https://a.test/cb#frag')).toBe(false);
    expect(isAcceptableRedirectUri('https://user:pass@a.test/cb')).toBe(false);
    expect(isAcceptableRedirectUri('javascript:alert(1)')).toBe(false);
    expect(isAcceptableRedirectUri(`https://a.test/${'x'.repeat(500)}`)).toBe(false);
  });
  it('matches exactly, except that a loopback address matches on any port', () => {
    expect(redirectUriRegistered('https://a.test/cb', ['https://a.test/cb'])).toBe(true);
    expect(redirectUriRegistered('https://a.test/cb2', ['https://a.test/cb'])).toBe(false);
    expect(redirectUriRegistered('http://127.0.0.1:5555/cb', ['http://127.0.0.1:1111/cb'])).toBe(
      true,
    );
    expect(redirectUriRegistered('http://127.0.0.1:5555/other', ['http://127.0.0.1:1111/cb'])).toBe(
      false,
    );
  });
  it('builds the redirect with code, state and iss (RFC 9207)', () => {
    const url = new URL(
      authorizationRedirect('https://a.test/cb?x=1', { code: 'c', state: 's', iss: ADDRESSES.api }),
    );
    expect(url.searchParams.get('x')).toBe('1');
    expect(url.searchParams.get('code')).toBe('c');
    expect(url.searchParams.get('iss')).toBe(ADDRESSES.api);
  });
});

describe('metadata documents', () => {
  it('protected resource metadata (RFC 9728)', () => {
    expect(protectedResourceMetadata(ADDRESSES)).toMatchObject({
      resource: 'https://api.example.test/mcp',
      authorization_servers: ['https://api.example.test'],
      bearer_methods_supported: ['header'],
    });
  });
  it('authorization server metadata (RFC 8414) carries what Claude and ChatGPT require', () => {
    const doc = authorizationServerMetadata(ADDRESSES);
    expect(doc.issuer).toBe('https://api.example.test');
    expect(doc.authorization_endpoint).toBe('https://app.example.test/oauth/authorize');
    expect(doc.code_challenge_methods_supported).toEqual(['S256']);
    expect(doc.token_endpoint_auth_methods_supported).toEqual(['none']);
    expect(doc.scopes_supported).toContain('offline_access');
    expect(doc.authorization_response_iss_parameter_supported).toBe(true);
    expect(doc.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    // No CIMD in v1: advertising it would make Claude choose it.
    expect(doc).not.toHaveProperty('client_id_metadata_document_supported');
  });
  it('the 401 challenge names the resource metadata and the scopes', () => {
    expect(bearerChallenge(ADDRESSES)).toBe(
      'Bearer resource_metadata="https://api.example.test/.well-known/oauth-protected-resource/mcp", scope="brandspace.read brandspace.write"',
    );
    expect(bearerChallenge(ADDRESSES, { error: 'invalid_token' })).toMatch(
      /^Bearer error="invalid_token", /,
    );
  });
});

describe('the MCP address (the Connect page, the metadata, the 401 challenge)', () => {
  it('is PUBLIC_API_BASE_URL + /mcp, read from the deployment, never from a request', () => {
    const addresses = addressesFrom({
      PUBLIC_API_BASE_URL: 'https://api.example.test/',
      PUBLIC_DASHBOARD_BASE_URL: 'https://app.example.test',
    });
    expect(addresses).toEqual({
      api: 'https://api.example.test',
      dashboard: 'https://app.example.test',
    });
    expect(resourceUrl(addresses!)).toBe('https://api.example.test/mcp');
    // Not configured: no address at all (the Connect page says so) rather than a guess.
    expect(addressesFrom({ PUBLIC_DASHBOARD_BASE_URL: 'https://app.example.test' })).toBeNull();
    // The function takes the environment only; nothing about a request can reach it.
    expect(addressesFrom.length).toBeLessThanOrEqual(1);
  });
});

describe('tokens and their redaction', () => {
  it('opaque, prefixed, 256 random bits; only a hash is kept', () => {
    const access = newSecret('access');
    expect(access).toMatch(/^bsp_at_[A-Za-z0-9_-]{43}$/);
    expect(looksLike('access', access)).toBe(true);
    expect(looksLike('refresh', access)).toBe(false);
    expect(sha256Hex(access)).toMatch(/^[0-9a-f]{64}$/);
    expect(newSecret('access')).not.toBe(access);
  });
  it('every token shape is redacted from logs and audit rows, wherever it appears', () => {
    for (const kind of ['access', 'refresh', 'code', 'client'] as const) {
      const value = newSecret(kind);
      expect(JSON.stringify(redact({ message: `failed with ${value} inside` }))).not.toContain(
        value,
      );
    }
    expect(redact({ code_verifier: 'abc' })).toEqual({ code_verifier: '[REDACTED]' });
  });
});

describe('configuration', () => {
  it('the ai-apps document is off by default with the approved numbers', () => {
    const doc = defaultPayload('ai-apps');
    expect(doc.enabled).toBe(false);
    expect(doc.rateLimit).toEqual({ windowSeconds: 60, maxCallsPerConnection: 60 });
    expect(doc.oauth).toEqual({
      authorizationCodeTtlSeconds: 60,
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlDays: 30,
      registrationPerIpPerHour: 20,
      tokenPerIpPerMinute: 60,
      unusedClientRetentionDays: 30,
    });
    expect(doc.allowedOrigins).toEqual([]);
  });
  it('refuses lifetimes past what the database allows', () => {
    expect(() =>
      parseConfigPayload('ai-apps', { oauth: { authorizationCodeTtlSeconds: 601 } }),
    ).toThrow();
    expect(() => parseConfigPayload('ai-apps', { oauth: { refreshTokenTtlDays: 91 } })).toThrow();
  });
});

describe('the tools', () => {
  it('are exactly the eleven the owner approved', () => {
    expect([...TOOL_NAMES]).toEqual([
      'whoami',
      'list_brands',
      'get_brand_summary',
      'get_help',
      'list_posts',
      'get_post',
      'create_post',
      'update_post',
      'get_calendar',
      'get_performance',
      'get_report',
    ]);
  });

  it('no file of the MCP module reaches approve, schedule, publish, archive, delete, disconnect, billing, members or AI', () => {
    const dir = path.resolve(__dirname, '../../apps/api/src/ai-apps');
    const source = readdirSync(dir)
      .filter((file) => file.endsWith('.ts'))
      .map((file) => readFileSync(path.join(dir, file), 'utf8'))
      .join('\n');
    for (const forbidden of [
      /\.decide\(/,
      /\.schedule\(/,
      /\.publishNow\(/,
      /\.reschedule\(/,
      /scheduleNextFreeSlot/,
      /\.transition\(/,
      /\.archiveItem\(/,
      /afterApproval:\s*true/,
      /AFTER_APPROVAL['"]/,
      /\.delete\(/,
      /\.disconnect\w*\(/i,
      /socialConnection\.(update|delete|create)/,
      /@brandspace\/billing/,
      /@brandspace\/ai-gateway/,
      /AiGateway/,
      /ContentStudioService/,
      /CreditLedger/,
      /membership\.(update|create|delete)/,
    ]) {
      expect(source, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it('the brand scope is the member’s, narrowed by the connection, and never widened', () => {
    expect(effectiveBrandScope([], [])).toEqual([]);
    expect(effectiveBrandScope(['a', 'b'], [])).toEqual(['a', 'b']);
    expect(effectiveBrandScope([], ['b'])).toEqual(['b']);
    expect(effectiveBrandScope(['a', 'b'], ['b', 'c'])).toEqual(['b']);
    // Nothing in common: a scope that matches nothing, never "unrestricted".
    expect(effectiveBrandScope(['a'], ['c'])).toEqual(['00000000-0000-0000-0000-000000000000']);
  });

  it('strips control characters from text and keeps line breaks', () => {
    expect(cleanText('a\u0000b\u0007c\nd\te')).toBe('abc\nd\te');
  });
});

describe('help copy', () => {
  it('has every topic in English and Arabic, and the two lists in both', () => {
    for (const topic of HELP_TOPICS) {
      expect(HELP_COPY.en[topic].text.length).toBeGreaterThan(20);
      expect(HELP_COPY.ar[topic].text).toMatch(/[؀-ۿ]/);
    }
    expect(WHAT_THE_AI_CAN_DO.ar.length).toBe(WHAT_THE_AI_CAN_DO.en.length);
    expect(WHAT_ONLY_A_PERSON_CAN_DO.ar.length).toBe(WHAT_ONLY_A_PERSON_CAN_DO.en.length);
  });
});
