# Connected AI apps — the Brandspace remote MCP server (D-566)

> **الملخص بالعربية**
>
> يستطيع العميل ربط Claude أو ChatGPT أو أي تطبيق يدعم MCP بحسابه في Brandspace. التطبيق الخارجي هو الذي يكتب
> النص؛ Brandspace لا يشغّل أي مزوّد ذكاء اصطناعي لهذه الطلبات ولا يخصم أي رصيد. يعمل التطبيق باسم الشخص الذي
> ربطه، بصلاحياته فقط، في مساحة عمل واحدة وعلامات تجارية يختارها هو. يستطيع التطبيق القراءة وكتابة المسودات واقتراح
> موعد وإرسالها للمراجعة، ولا يستطيع أبدًا الاعتماد أو الجدولة أو النشر أو الحذف أو فصل الحسابات أو تغيير الفوترة
> أو الفريق. كل طلب مُسجَّل في سجل التدقيق، ويمكن إلغاء الربط في أي وقت من الإعدادات.

## 1. What it is

A customer connects Claude, ChatGPT or any MCP client to Brandspace. In plain words they can ask it to
write posts, put them on the calendar as a proposal, read how things are going and pull a report. The
external AI writes the text; **Brandspace runs no AI provider for these calls and spends no AI credits**.

| Surface                            | Where                                                                                           |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| The MCP endpoint                   | `POST {PUBLIC_API_BASE_URL}/mcp` (Streamable HTTP, protocol 2025-11-25, stateless)              |
| The OAuth 2.1 authorization server | the API: metadata, `/oauth/register`, `/oauth/token`, `/oauth/revoke`                           |
| The consent screen                 | the dashboard: `/{locale}/oauth/authorize` (the authorization endpoint the metadata names)      |
| Settings → Connected AI apps       | `/{locale}/settings/ai-apps` — each connection, last used, two-step Revoke                      |
| Settings → Connect                 | `/{locale}/settings/ai-apps/connect` — the address to copy and the steps for Claude and ChatGPT |
| Control Center                     | Simple → AI apps (`/console/manage/ai-apps`); the customer page's "Connected AI apps" card      |

## 2. The rules, and where each is enforced

| Rule                               | How                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The AI acts as the person          | Every call resolves `(userId, workspaceId)` from the token's connection and re-reads the membership and role (`resolveLiveAuthorization`), then intersects with the token's scopes and the connection's brands. A removed or suspended member, a lost permission or a deleted workspace takes effect at the next call.                                                                                                              |
| Never another workspace            | Every read and write runs in `withWorkspace(connection.workspaceId)` under RLS. The workspace is never taken from tool input. An id from another workspace is "not found", worded exactly as a true miss (CLAUDE.md §2.1).                                                                                                                                                                                                          |
| Never approve, schedule or publish | No tool reaches `approvals.decide`, `calendar.schedule`, `publishNow`, `reschedule`, archive, delete, social connect/disconnect, billing, members, roles or settings. `calendar.propose` is the only calendar write, and `publishChoice` is never `AFTER_APPROVAL`. A unit test pins the tool list; an isolation test proves no tool leaves a post approved, scheduled or published. Same contract as the Copilot (CLAUDE.md §2.5). |
| Consent                            | Shown on every connection (owner answer Q6): the app's name and where it returns to, what it may and may never do, the workspace, the brands ("All brands" says it includes brands added later), Allow / Cancel. An unknown app or unregistered return address is an error and is never redirected.                                                                                                                                 |
| Revoke                             | Settings → Connected AI apps (the member's own; everyone's with `integrations.manage`), or the app via RFC 7009 `/oauth/revoke`. Every token dies at once.                                                                                                                                                                                                                                                                          |
| Every tool call audited            | `ai_app.tool.called` (who, which app, which tool, outcome, the post or brand). Inputs are not copied. Refusals are written as DENIED on their own transaction.                                                                                                                                                                                                                                                                      |
| Rate limits                        | Per connection: `ai-apps.rateLimit` (60 calls per 60 s by default); per source address: registrations per hour and token requests per minute. Over the limit: 429 with `Retry-After` and a plain sentence.                                                                                                                                                                                                                          |
| Tool input is untrusted            | zod at the boundary; captions are plain text with control characters stripped; lengths capped; ids are UUIDs; hashtags and times have strict shapes; nothing is evaluated, rendered as HTML or used in SQL.                                                                                                                                                                                                                         |
| No secrets or tokens anywhere      | Tokens, codes and client ids are random, prefixed (`bsp_at_`, `bsp_rt_`, `bsp_code_`, `bsp_cli_`) and stored as SHA-256 only. The redaction layer masks the prefixes and `code_verifier`. A leak test runs the whole flow and searches every audit row, log line, error body and tool result.                                                                                                                                       |
| No credits                         | MCP never touches the AI gateway, the Copilot or generation; a test proves the ledger unchanged.                                                                                                                                                                                                                                                                                                                                    |
| Off                                | `ai-apps.enabled` (everyone), the `feature.ai_apps` kill switch, or a plan that does not include it. Metadata still answers; the consent screen shows the workspace as unavailable; a connected app gets "AI apps are turned off for this workspace" as a tool error.                                                                                                                                                               |

## 3. Tools (v1)

| Tool                | What it does                                                                                       | Live permission                                       | Scope |
| ------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ----- |
| `whoami`            | the person, workspace, role, what they may do, the brands, the app                                 | membership                                            | read  |
| `list_brands`       | the brands the connection may see                                                                  | membership                                            | read  |
| `get_brand_summary` | approved Brand Brain facts only                                                                    | `brand_brain.read`                                    | read  |
| `get_help`          | how Brandspace works, the channels and their limits from configuration (en/ar)                     | membership                                            | read  |
| `list_posts`        | posts, filtered by brand, status, channel, search                                                  | `content.read`                                        | read  |
| `get_post`          | one post with its captions per channel, review state and a link                                    | `content.read`                                        | read  |
| `create_post`       | a DRAFT, optionally with a proposed time (shown on the calendar as "Proposed") and sent for review | `content.create` (+`content.edit`, +`content.submit`) | write |
| `update_post`       | captions, hashtags, proposed time, send for review — DRAFT or CHANGES_REQUESTED only               | `content.edit` (+`content.submit`)                    | write |
| `get_calendar`      | scheduled posts and proposed drafts between two days (≤ 62)                                        | `content.read`                                        | read  |
| `get_performance`   | measured numbers; with no connected account it says so and returns no number                       | `analytics.read`                                      | read  |
| `get_report`        | a period report; the performance part only with `analytics.read`                                   | `content.read`                                        | read  |

v1 differs from the approved plan in two small ways, both recorded in D-567: `update_post` has no title
edit (no service edits a title), and `list_posts` has no date range.

## 4. OAuth

- RFC 9728 protected-resource metadata (also at the `/mcp` path-suffixed form), RFC 8414 server metadata
  with `iss` (RFC 9207), RFC 7591 dynamic client registration for public clients
  (`token_endpoint_auth_method: none`), RFC 8707 `resource`, PKCE S256 only, RFC 7009 revocation.
- `offline_access` issues a refresh token; each refresh rotates it. Presenting a used refresh token or a
  used code again revokes the connection.
- Redirect addresses: https, or loopback http on any port (RFC 8252 §7.3).
- Client-metadata documents (CIMD) come after v1 (owner answer Q4).

## 5. Data

Five tables (migrations `20261023090000_ai_app_connections` and `20261023091000_ai_app_token_replaced_scoped`, D-568; `docs/DATABASE.md` §AI apps):
`ai_app_client` (global registry, written only by the platform role), `ai_app_connection`,
`ai_app_authorization_code`, `ai_app_token`, `ai_app_rate_window` (tenant-owned, forced RLS). A token is
looked up by hash under `app.ai_app_token_hash` with read-only policies; every write runs in the
workspace.

The maintenance sweep purges codes an hour after expiry, tokens a day after expiry (a revoked refresh
token is kept until then, so reuse is still recognised), rate windows older than a day, and registered
apps that never got a connection after `oauth.unusedClientRetentionDays` (30), audited as a count only.

## 6. Configuration

The `ai-apps` domain (`docs/CONTROL-CENTER-SETTINGS.md`): `enabled`, `rateLimit`, `oauth` lifetimes and
per-address ceilings, `unusedClientRetentionDays`, `allowedOrigins`. Off in production
(`docs/production-config/ai-apps.json`). Per plan: the boolean feature `feature.ai_apps`, chosen in
Simple → AI apps or on the plan cards; the kill switch is in Advanced.

**Staging (owner answer Q5):** after the deploy, Control Center → Simple → AI apps → "For everyone" on,
and "Plans" → every plan.

## 7. Connecting

**Claude:** Customize → Connectors → + Add → Add custom connector (Team/Enterprise: an owner, under
Organization settings → Connectors). Name, the MCP address, OAuth left empty → Add → Connect → the
Brandspace consent screen → Allow.

**ChatGPT** (OpenAI's help page "Developer mode and MCP apps in ChatGPT", read 2026-10-18): developer
mode; Settings → Apps → Create with the server URL, then Scan tools; connect through the same consent
screen. Write actions are in beta for Business, Enterprise and Edu; Pro can connect read/fetch only. The
Connect page says so.

## 8. Tests

- Unit: `ai-apps-oauth`, `ai-apps-migration`, `ai-apps-control-center`, the registry pins.
- Isolation (real PostgreSQL, the SDK's MCP client against the real API): `ai-apps-mcp` (connect, OAuth,
  every tool, permission refused, other workspace refused, brand limits, live permissions, revoke, rate
  limit, feature off, credits, leak test, calendar), `ai-apps-sweep`, `ai-apps-tables`.
- E2E: `ai-apps.spec.ts` — consent in a real browser, a tool call as the person, Settings, two-step
  revoke, the plan gate, the Connect page, the calendar's "Proposed" chip, the Control Center card; en
  and ar with axe. `seed-ai-apps.ts` switches the feature on for every plan before the run.
- CI never calls Claude or ChatGPT.
