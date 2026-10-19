import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { AI_APPS_FEATURE } from '@brandspace/entitlements';
import { ADMIN_BASE_URL, API_BASE_URL, DASHBOARD_BASE_URL } from './apps';
import { signIn as adminSignIn } from './admin-session';
import { enter, noSeriousViolations, ownWorkspace, type OwnWorkspace } from './own-workspace';
import { withPlatformPrisma } from './platform-prisma';

/**
 * D-566 — CONNECTED AI APPS, THROUGH THE SCREENS.
 *
 * A real MCP client (the SDK's), never Claude or ChatGPT: it registers as an
 * app, the person sees Brandspace's consent screen and presses Allow, the app
 * exchanges the code and calls a tool as that person. Then the person finds it
 * in Settings → Connected AI apps, revokes it in two steps, and the app is
 * refused. Plus the Connect page (the address to copy, the steps, ChatGPT's
 * plan note), the calendar's "Proposed" chip for a draft an app proposed, and
 * the Control Center's AI apps card. English and Arabic, with axe.
 *
 * `seed-ai-apps.ts` switched the feature on (for every plan) before the run; no
 * test here writes configuration. Each test uses a workspace of its own,
 * entitled by a workspace override, never by a plan.
 */

const REDIRECT = 'http://127.0.0.1:47999/callback';
const MCP_URL = `${API_BASE_URL}/mcp`;
const LOCALES = ['en', 'ar'] as const;

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function registerApp(request: APIRequestContext, name: string): Promise<string> {
  const response = await request.post(`${API_BASE_URL}/oauth/register`, {
    data: {
      client_name: name,
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

/**
 * THIS workspace may connect AI apps: a workspace override on `feature.ai_apps`
 * (the engine's second rule, after the kill switch). Not a plan: the e2e
 * customer's workspaces deliberately have none, and other suites read that
 * (a plan would offer them another workspace).
 */
async function entitled(own: OwnWorkspace): Promise<void> {
  await withPlatformPrisma(async (prisma) => {
    const owner = await prisma.platformUser.findFirstOrThrow({
      where: { deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    await prisma.workspaceOverride.create({
      data: {
        workspaceId: own.workspaceId,
        featureKey: AI_APPS_FEATURE,
        enabled: true,
        reason: 'E2E: connected AI apps for this test workspace (D-566)',
        grantedByPlatformUserId: owner.id,
      },
    });
  });
}

/** The consent screen, Allow, and the code the app receives — as the app sees it. */
async function consent(
  page: Page,
  request: APIRequestContext,
  own: OwnWorkspace,
  locale: string,
  appName: string,
): Promise<{ access: string; clientId: string }> {
  const clientId = await registerApp(request, appName);
  const { verifier, challenge } = pkce();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'brandspace.read brandspace.write offline_access',
    state: 'e2e-state',
    resource: MCP_URL,
  });
  let landed: URL | null = null;
  await page.route('http://127.0.0.1:47999/**', async (route) => {
    landed = new URL(route.request().url());
    await route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' });
  });

  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/oauth/authorize?${params.toString()}`);
  await expect(page.getByTestId('consent')).toBeVisible();
  await expect(page.locator('h1, h2').first()).toContainText(appName);
  // The person's own workspace, chosen explicitly.
  const choice = page.getByTestId(`consent-ws-${own.workspaceId}`);
  if (await choice.count()) {
    await choice.click();
    await expect(page.getByTestId('consent-form')).toBeVisible();
  }
  await expect(page.locator('input[name="workspaceId"]')).toHaveValue(own.workspaceId);
  // "All brands" says plainly that it includes brands added later (owner addition).
  await expect(page.getByTestId('consent-all-brands')).toBeChecked();
  await expect(page.getByTestId('consent-all-brands-note')).toBeVisible();
  await noSeriousViolations(page);

  await page.getByTestId('consent-allow').click();
  await expect.poll(() => landed?.toString() ?? null, { timeout: 15_000 }).not.toBeNull();
  const back = landed as unknown as URL;
  expect(back.searchParams.get('state')).toBe('e2e-state');
  expect(back.searchParams.get('iss')).toBe(API_BASE_URL);
  const code = back.searchParams.get('code');
  expect(code).toMatch(/^bsp_code_/);

  const token = await request.post(`${API_BASE_URL}/oauth/token`, {
    form: {
      grant_type: 'authorization_code',
      code: code ?? '',
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
      resource: MCP_URL,
    },
  });
  expect(token.status()).toBe(200);
  const body = (await token.json()) as { access_token: string; refresh_token: string };
  expect(body.access_token).toMatch(/^bsp_at_/);
  expect(body.refresh_token).toMatch(/^bsp_rt_/);
  return { access: body.access_token, clientId };
}

async function mcpClient(access: string): Promise<Client> {
  const client = new Client({ name: 'brandspace-e2e', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { authorization: `Bearer ${access}` } },
  });
  // The SDK declares its optional callbacks without `| undefined`, which this
  // repository's `exactOptionalPropertyTypes` reads as a mismatch; same object.
  await client.connect(transport as unknown as Transport);
  return client;
}

function data(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  const text = (result.content as { type: string; text: string }[])[0]?.text ?? '{}';
  return JSON.parse(text) as Record<string, unknown>;
}

for (const locale of LOCALES) {
  test.describe(`connected AI apps (${locale})`, () => {
    test(`consent, a tool call as the person, Settings, two-step revoke, refused after (${locale})`, async ({
      page,
      request,
    }) => {
      test.setTimeout(120_000);
      const own = await ownWorkspace(`ai-apps-${locale}`);
      await entitled(own);
      await enter(page, own.slug, locale);
      const appName = `E2E MCP client ${locale}`;
      const { access } = await consent(page, request, own, locale, appName);

      // The app works as the person, in this workspace only.
      const client = await mcpClient(access);
      const who = data(await client.callTool({ name: 'whoami', arguments: {} }));
      expect(who).toMatchObject({
        workspace: { id: own.workspaceId },
        app: { name: appName },
        permissions: { canApproveScheduleOrPublish: false },
      });
      await client.close();

      // Settings → Connected AI apps: the app, used today.
      await page.goto(`${DASHBOARD_BASE_URL}/${locale}/settings/ai-apps`);
      const connection = await withPlatformPrisma((prisma) =>
        prisma.aiAppConnection.findFirstOrThrow({
          where: { workspaceId: own.workspaceId, status: 'ACTIVE' },
          select: { id: true },
        }),
      );
      const row = page.getByTestId(`ai-app-${connection.id}`);
      await expect(row.getByTestId('ai-app-name')).toHaveText(appName);
      await expect(row.getByTestId('ai-app-last-used')).not.toHaveText(
        locale === 'ar' ? 'لم يُستخدم بعد' : 'Not used yet',
      );
      await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
      await noSeriousViolations(page);

      // Revoke, in two steps.
      await page.getByTestId(`ai-app-revoke-${connection.id}`).click();
      await page.getByTestId(`ai-app-revoke-confirm-${connection.id}`).click();
      await expect(page).toHaveURL(/ok=AI_APP_REVOKED/);
      await expect(page.getByTestId(`ai-app-${connection.id}`)).toHaveCount(0);

      // The app is refused from now on.
      const refused = await fetch(MCP_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${access}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(refused.status).toBe(401);
      expect(refused.headers.get('www-authenticate')).toContain('resource_metadata=');
    });

    test(`a workspace not entitled to AI apps cannot be chosen (${locale})`, async ({
      page,
      request,
    }) => {
      const included = await ownWorkspace(`ai-apps-in-${locale}`);
      await entitled(included);
      const without = await ownWorkspace(`ai-apps-out-${locale}`);
      await enter(page, included.slug, locale);
      const clientId = await registerApp(request, `E2E plan check ${locale}`);
      const { challenge } = pkce();
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: 'brandspace.read',
        resource: MCP_URL,
      });
      await page.goto(`${DASHBOARD_BASE_URL}/${locale}/oauth/authorize?${params.toString()}`);
      await expect(page.getByTestId(`consent-ws-${included.workspaceId}`)).toBeVisible();
      await expect(page.getByTestId(`consent-ws-${without.workspaceId}`)).toHaveCount(0);
      await expect(page.getByTestId('consent-workspaces')).toContainText(
        locale === 'ar' ? 'خطة' : 'plan',
      );
    });

    test(`an unknown app is an error on the consent screen and is never redirected (${locale})`, async ({
      page,
    }) => {
      const own = await ownWorkspace(`ai-apps-unknown-${locale}`);
      await enter(page, own.slug, locale);
      const { challenge } = pkce();
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: 'bsp_cli_this_app_was_never_registered_00000',
        redirect_uri: 'https://attacker.example/steal',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource: MCP_URL,
      });
      await page.goto(`${DASHBOARD_BASE_URL}/${locale}/oauth/authorize?${params.toString()}`);
      await expect(page.getByTestId('consent-error')).toBeVisible();
      expect(new URL(page.url()).origin).toBe(DASHBOARD_BASE_URL);
    });

    test(`the Connect page: the address to copy, the steps, ChatGPT's plan note (${locale})`, async ({
      page,
    }) => {
      const own = await ownWorkspace(`ai-apps-connect-${locale}`);
      await entitled(own);
      await enter(page, own.slug, locale);
      await page.goto(`${DASHBOARD_BASE_URL}/${locale}/settings/ai-apps/connect`);
      await expect(page.getByTestId('ai-apps-mcp-url')).toHaveValue(MCP_URL);
      await expect(page.getByTestId('ai-apps-steps-claude').locator('li')).toHaveCount(4);
      await expect(page.getByTestId('ai-apps-steps-chatgpt').locator('li')).toHaveCount(4);
      await expect(page.getByTestId('ai-apps-plans-chatgpt')).toContainText('Business');
      await expect(page.getByTestId('ai-apps-plans-chatgpt')).toContainText('Enterprise');
      await expect(page.getByTestId('ai-apps-plans-chatgpt')).toContainText('Edu');
      await expect(page.getByTestId('ai-apps-refusal')).toHaveCount(0);
      await noSeriousViolations(page);
    });

    test(`a draft an AI app proposed shows as a "Proposed" chip on the calendar (${locale})`, async ({
      page,
      request,
    }) => {
      test.setTimeout(120_000);
      const own = await ownWorkspace(`ai-apps-cal-${locale}`);
      await entitled(own);
      await enter(page, own.slug, locale);
      const { access } = await consent(page, request, own, locale, `E2E calendar ${locale}`);
      const client = await mcpClient(access);
      const help = data(await client.callTool({ name: 'get_help', arguments: {} }));
      const channel = (help['channels'] as { key: string; formats: string[] }[]).find((c) =>
        c.formats.includes('post'),
      );
      expect(channel).toBeDefined();
      // Tomorrow, in the workspace's zone (UTC for this workspace), at 10:00.
      const day = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
      const created = await client.callTool({
        name: 'create_post',
        arguments: {
          brandId: own.brandId,
          format: 'post',
          channels: [channel!.key],
          caption: 'Weekend offer from the AI app',
          proposedTime: `${day}T10:00`,
        },
      });
      expect(created.isError ?? false).toBe(false);
      await client.close();

      await page.goto(`${DASHBOARD_BASE_URL}/${locale}/calendar?month=${day.slice(0, 7)}`);
      // The month grid from 768px up, the phone agenda below it (D-468 (b)): the visible one.
      const chip = page
        .locator(`[data-kind="proposed"][data-testid*="-marker-${day}-"]`)
        .locator('visible=true');
      await expect(chip).toBeVisible();
      await expect(chip).toContainText(locale === 'ar' ? 'مقترح' : 'Proposed');
      await expect(chip).toContainText('10:00');
      // Nothing was scheduled: no post chip on that day.
      await expect(page.locator(`[data-testid="calendar-day-${day}"] .bsp-calchip`)).toHaveCount(0);
    });
  });
}

test('Control Center → AI apps: the card, in both languages', async ({ page, isMobile }) => {
  for (const locale of LOCALES) {
    await adminSignIn(page, locale, { mode: 'simple' });
    await page.goto(`${ADMIN_BASE_URL}/${locale}/console/manage/ai-apps`);
    await expect(page.getByTestId('area-collection-ai-apps')).toBeVisible();
    await expect(page.getByTestId('area-collection-plans')).toBeVisible();
    await expect(page.getByTestId('area-card-ai-apps-ai-apps')).toContainText(
      locale === 'ar' ? 'مفعّل' : 'On',
    );
    await expect(page.locator('main')).not.toContainText('ai-apps');
    await expect(page.locator('main')).not.toContainText('feature.ai_apps');
    if (!isMobile) await noSeriousViolations(page);
  }
});
