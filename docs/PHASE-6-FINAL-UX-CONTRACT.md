# BrandSpace — Phase 6 Final UX / Product Correction: Master Implementation Contract

> **OWNER-APPROVED.** Recorded from the product owner's specification of 2026-09-24 (D-277) — the
> requirements text is kept as written; the long acceptance lists of §55–§60 are carried item by item in
> the execution document rather than repeated here. This document is
> the **PRODUCT / UX / INFORMATION-ARCHITECTURE authority** for Phase 6. The BrandSpace Design System
> (`packages/ui`, `docs/DESIGN-SYSTEM.md`) remains the **VISUAL** authority. Where
> `docs/UI-FIDELITY-CONTRACT.md` describes an affected screen as a mechanical port whose composition may
> not be repositioned, simplified or reorganised, that restriction is **superseded** for every surface
> this contract redesigns. Delivery status against every section lives in
> `docs/PHASE-6-FINAL-EXECUTION.md`.

---

This is an OWNER-APPROVED PRODUCT AND UX CORRECTION.

This specification supersedes every earlier interpretation of Phase 6 where "preserve the current
design" was interpreted as "preserve the current page composition or workflow".

The BrandSpace Design System remains the VISUAL authority:

- existing identity
- colors
- typography
- tokens
- component primitives
- accessibility rules
- responsive foundations

THIS DOCUMENT is now the PRODUCT / UX / INFORMATION-ARCHITECTURE authority.

Where an old UI-FIDELITY-CONTRACT says an affected screen is a "mechanical port" whose composition may
not be repositioned, simplified or reorganized, that restriction is superseded for every surface
explicitly redesigned below.

Record that owner decision in:

- docs/DECISIONS.md
- docs/UI-FIDELITY-CONTRACT.md
- the Phase 6 execution document

Do NOT invent a second visual system. Do NOT recreate the old composition just because an old demo
used it.

## 0. Repository / safety rules

Start from the CURRENT exact HEAD of `feat/phase-5-staging-full-e2e`. At the time this owner
specification was prepared PR #37 was open, draft, not merged. A newer HEAD may exist. VERIFY CURRENT
HEAD FIRST. Preserve all newer fixes. Do NOT reset to an earlier Phase 6 SHA.

P6-16 already connected real Top Bar domains on the branch: Review / Notes / Notifications / Copilot /
Create. Preserve those real integrations and adapt them only where this specification requires UX
changes.

DO NOT MERGE PR #37.

DO NOT touch Production: no Production deploy, migration, variable, data, social publishing,
credential or domain change. Staging only.

Do not perform external real social publishing during automated or owner smoke testing unless the owner
explicitly authorizes a specific test account/action.

No fake data. No fake AI insights. No fake confidence. No fake readiness. No dead controls. No "coming
soon" button pretending to work. No placeholder Top Bar actions. No silent external actions.

Reuse the current backend/domain models whenever possible. Do not rewrite working RLS, permissions,
services, pipelines or ledgers just to support a new composition.

When a genuine data-model addition is required by this contract, add it properly: migration + FORCE RLS
where applicable + service rules + permissions + isolation tests + unit/E2E coverage.

## 1. The product experience we are building

BrandSpace is not a collection of disconnected SaaS modules. The user journey is:

UNDERSTAND → PLAN → CREATE → REVIEW → PUBLISH → LEARN → IMPROVE. Then the loop repeats.

The user should experience: "BrandSpace understands my brand. It tells me what needs me now. It helps
me plan. It helps me create. My team collaborates on the work itself. We review and publish. BrandSpace
measures what happened. It learns only with my approval. Then it helps me improve."

The user should NOT have to understand the internal architecture. Approvals are not a separate mental
product. Notes are not Notion/Jira. Brand Brain is not a document dump. Analytics is not just charts.
Copilot is not just a chat page. Assets are not a folder where uploaded images are dumped. Automations
are not the first interface most users should see.

## 2. Product UX principles

1. Context before navigation. If an action can be completed where the user already is, do not force
   them into another module.
2. Progressive disclosure. Show the simple path first. Put advanced controls behind Advanced
   options/details.
3. One obvious primary action per local surface.
4. Content-first visual language. Use real thumbnails, previews, media, people, status and
   conversation. Avoid an interface made mainly from text cards and tables.
5. Fewer cards. Not every piece of information needs a rounded card inside another card.
6. Social/team feel without becoming a social network. Human names, avatars, relative timestamps,
   conversations, mentions and activity timelines.
7. AI is contextual. It knows the selected Workspace, Brand, Campaign, Content, page and current state
   whenever permissions allow.
8. AI explains why a recommendation exists when useful.
9. AI never silently converts inference into brand truth.
10. AI never silently performs external/destructive actions.
11. Preview consequential changes before applying them.
12. Show Undo after reversible Copilot actions while the compensation contract remains valid.
13. Preserve honest unavailable/insufficient-data states.
14. Arabic remains first-class RTL.
15. Customer interface DEFAULT language is English.

## 3. Final information architecture

PRIMARY SIDEBAR: Home; Brand Brain (prominent, visually associated with the currently selected Brand);
PLAN — Strategy, Campaigns; CREATE — Content, Creative, Assets; PUBLISH — Calendar, Publishing;
IMPROVE — Analytics, Intelligence; AUTOMATE — Automations; BOTTOM — Settings.

Do NOT expose the entire internal module inventory in the main sidebar. Move these out of primary
navigation:

- Approvals → Home / Top Bar Review / Content / Campaign contextual entry points
- Notes → Top Bar Notes / Home / object-context conversations
- Notifications → Top Bar bell
- Copilot → Top Bar global Copilot (a dedicated route may remain technically reachable, but it is not
  the primary mental model)
- Team → Settings > Team
- Permissions → Settings > Team / Roles & permissions
- Activity → Settings > Activity, plus contextual activity timelines on objects
- Plan / Billing → Settings > Billing & Usage
- Data Controls → Settings > Data Controls
- Social connection administration → Settings > Connections, and operational account health also
  appears under Publishing > Accounts
- Onboarding → never remain a permanent primary nav module after setup
- Brand Profile → contextual from Brand selector / Brand Brain / Settings

## 4. Global shell

Workspace selection and Brand selection must always be clear. The user must never wonder: which
workspace am I in? which brand am I editing? is this "All brands"? will this action affect another
brand?

Top Bar must remain functional. Current P6-16 real actions should remain: Review, Notes,
Notifications, Copilot, + Create. Language/Profile may remain according to the shared shell.

Do not reintroduce fake Search in this correction. There is no approved global Search requirement in
this final correction. Search can be a future bounded project.

Counts/dots must be REAL: pending review count only if user can act; unread note mentions from real
Notes domain; unread notifications from NotificationService. No decorative unread dot.

## 5. Default language

English is the DEFAULT BrandSpace CUSTOMER INTERFACE language. Fix all old Arabic-default assumptions.

Required: locale-less dashboard URL → /en; signup → English unless /ar explicitly requested; sign-in →
English unless /ar explicitly requested; reset/verification → English unless /ar explicitly requested;
first onboarding → English; Setup Wizard interface language defaults EN; workspace/interface fallbacks
default EN; explicit /ar stays Arabic RTL; explicit /en stays English LTR; locale switching preserves
the exact route, query and selected object.

Audit comments/tests/docs carrying old D-03 Arabic-default semantics.

IMPORTANT: INTERFACE LANGUAGE and CONTENT LANGUAGE are different concepts. A Brand may primarily create
Arabic content while the BrandSpace interface is EN. For new content: use explicit content-language
choice when supplied; otherwise use the Brand/workspace content preference if one exists; otherwise EN.
Do not change unrelated linguistic semantics merely because the UI default is EN.

## 6. First-run Setup Wizard

Replace the current "checklist linking to unrelated pages" experience with one guided first-run
journey. Do not create a fake onboarding-progress source of truth. Completion state must continue to
derive from real domain data.

FLOW: 1. Create Workspace → 2. Add Brand → 3. Let BrandSpace learn the Brand → 4. Review extracted
knowledge → 5. Connect socials → 6. Choose first goal → 7. Enter Home.

- **Step 1 — Workspace.** Ask only essentials: Workspace name; timezone/country/currency only where
  genuinely required; UI language, default EN. No silent business defaults.
- **Step 2 — Add Brand.** Ask only: Brand name, Website, Industry, Brand/content languages, Logo
  optional, Brand colors optional. Do not dump the whole Brand Profile form into onboarding.
- **Step 3 — Let BrandSpace learn.** Copy direction: "Let's learn about your brand". Allow brand
  guidelines, company profile, service/product files, presentations, FAQs, other supported documents.
  User may Skip for now. Reuse the existing Brand Brain ingestion/extraction pipeline.
- **Step 4 — Review extracted knowledge.** Show structured candidate values, not a wall of extracted
  text (Identity, Audience, Products / services / offers, Tone of voice, Brand rules, Proof points,
  FAQs / glossary where supported). Allow Accept, Edit, Reject/dismiss. Do not silently promote
  extraction into canonical truth.
- **Step 5 — Connect socials.** Show supported real providers only. Explain: "Connecting an account lets
  BrandSpace schedule, publish and measure content." Allow Skip. Do not perform a real external post.
- **Step 6 — First goal.** "What do you want BrandSpace to help you achieve first?" Options based on
  supported strategy/campaign vocabulary: Build awareness, Increase engagement, Generate leads, Drive
  traffic where supported, Launch something, Improve consistency / retention where semantically
  appropriate, Build authority if mapped safely, I'm not sure. DO NOT store this as an onboarding-only
  duplicate truth. Map it into the existing Strategy/goal domain or the proper Brand strategy starting
  point.
- **Step 7 — Home.** Do not continue setup forever. Show: "You're ready to start." Recommended first
  action: Plan with Copilot or Create first post, depending on available Brand Brain knowledge and
  connected capabilities. A new user should reach a meaningful AI-assisted first draft quickly.

## 7. Home / Command Center

Home is not a metric dashboard. It answers: "What needs me now?" "What should I do next?" "What did
BrandSpace notice?"

TOP: Good morning, {name}; Selected Brand.

- **Section A — What needs you.** Use real attention sources (posts waiting for review, a note assigned
  to you, unread mention, social account needs reconnection, publish failed, campaign missing content,
  overdue/at-risk scheduled work, unresolved Brand Brain review, other existing real attention
  sources). Every row: human sentence, useful context, one clear action, deep link to the exact object.
  Do not show meaningless zeros.
- **Section B — Recommended by BrandSpace.** Show only 2–3 highest-value grounded recommendations. Each
  recommendation: title, short explanation, evidence summary, View evidence, Give to Copilot, Dismiss
  where appropriate. No fabricated recommendation.
- **Section C — Notes / Team.** Actual relevant note preview when possible: Avatar + person, message
  excerpt, linked object, relative time, Open post/campaign/brand, Resolve if authorized. Do not reduce
  collaboration to "3 mentions" if the top relevant item can be shown honestly.
- **Section D — Coming up.** Compact 7-day content/calendar view. Do not replicate the full calendar.
- **Section E — Performance snapshot.** Metrics come after work/intelligence/team. Real values only.

## 8. Proactive intelligence types

Do not mix every suggestion into one generic "AI suggestion". There are four distinct types:
A. ATTENTION — a present fact ("Instagram needs reconnection."); B. INSIGHT — evidence-backed ("Arabic
educational Reels generated more saves over this measured period."); C. PREFERENCE — observed user
preference ("You usually prefer shorter LinkedIn drafts."); D. WORKFLOW — repeated behavior ("You have
repeated this workflow four times."). The visual treatment can share a system, but the meaning must
remain distinct.

## 9. Preference learning

This capability is NOT currently fully implemented. Build it honestly. Do not infer a permanent
preference from one edit. Track only reliable supported signals (repeated use of Shorten on LinkedIn
output, repeated explicit tone adjustment, repeated accepted language/format choice). Use a conservative
threshold. When enough evidence exists: "BrandSpace noticed a preference" — "You usually shorten
LinkedIn drafts after generation." Actions: Make this my default, Not now, Don't suggest this again
where useful. ONLY after explicit acceptance may it influence future defaults. Record source,
evidence/count, accepted by, accepted at. Do not silently mutate canonical Brand Brain facts.

## 10. Repeated workflow detection

Do not build arbitrary process mining. Detect only known supported workflow shapes from real
audit/domain events (e.g. Thursday → create Arabic educational Instagram draft → prepare for Sunday →
request approval / schedule). After a conservative repeated threshold: "You've repeated this workflow 4
times." Give to Copilot. Copilot may prepare a rule only from the EXISTING CLOSED automation registry.

Triggers: CONTENT_APPROVED, CONTENT_SCHEDULED, POST_PUBLISHED, ANALYTICS_REFRESHED, ANOMALY_DETECTED,
METRIC_THRESHOLD_CROSSED, SCHEDULED_TIME. Actions: NOTIFY, SUBMIT_FOR_APPROVAL, PLACE_ON_CALENDAR,
PROPOSE_PUBLISH. Do NOT add arbitrary webhook/script/SQL actions. Copilot-created automation stays
DISABLED until a human enables it. External proposed publishing still requires confirmation.

## 11. Brand Profile + Brand Kit

Use the existing Brand Profile and canonical asset references properly. Brand identity includes name,
description, website, industry, locales, palette, typography, voice profile where appropriate,
canonical logo assets. Do not create a second logo/media store. Brand Profile references the ONE Asset
Library. Expose Brand Profile contextually from the Brand selector, the Brand Brain identity area and
Settings > Brand. Composer and Creative Studio should automatically receive correct logo references,
palette, brand context and approved Brand Brain knowledge where existing services safely support it.

## 12. Living Brand Brain

Brand Brain must visibly feel alive. Top area: brand name; "BrandSpace currently understands this Brand
from real sources/learnings." Do not invent a fake readiness percentage.

Organize the mental model into four clear layers: 1. Brand Knowledge, 2. Strategy, 3. Content Memory, 4. Learnings.

BRAND KNOWLEDGE areas should expose, where real data exists: Identity, Audience, Products / services /
offers, Tone of voice, Do / Don't / brand rules, Proof points, FAQs, Competitors/context, Glossary /
terminology, visual identity link to Brand Profile. Each meaningful value can show value,
source/provenance, last updated, who edited it where applicable.

KNOWLEDGE SOURCES: show uploaded/processed documents clearly. Allow Add knowledge.

KNOWLEDGE GAPS: if Content generation has insufficientKnowledge, do not merely show a generation error.
Offer "BrandSpace needs more information about this topic." Actions: Add knowledge, View missing area.

LEARNINGS: "BrandSpace is learning" — potential learning with evidence (e.g. 8 posts, Instagram, 6-week
period); confidence only if calculated truthfully from the existing evidence model. Actions: Accept,
Edit, Dismiss. Accept must explain: "This may influence future strategy and content suggestions." Notes
NEVER modify Brand Brain automatically.

BRAND Q&A: there is already grounded Brand Brain Q&A with citations. Do not create two separate
assistant mental models. "Ask about this Brand" should use/open the global Copilot experience scoped to
Brand Brain, backed by existing brand.context/grounded behavior. Preserve citations and
insufficient-knowledge honesty.

## 13. Strategy / Plan

Strategy should no longer feel like an isolated AI generator. Page sections: Current objective,
Audience, Content pillars, Channel mix, Key messages, Monthly plan, Evidence / source, Suggested
changes. Accepted human strategy is clearly different from AI proposal. AI-generated strategy remains a
PROPOSAL until accepted. Use Brand Brain grounding. Use the first onboarding goal as the starting
context rather than asking the same question again unnecessarily.

MONTHLY PLAN: turn monthly plan output into practical opportunities (campaign opportunities, content
opportunities, channel emphasis, cadence). Actions: Create campaign, Send opportunity to Content, Give
to Copilot. Do not silently create/publish content.

## 14. Campaigns — Project Room

Campaign detail becomes a complete working room. HEADER: Campaign name, Goal, Dates, Channels, Status,
Owner, KPIs/budget only where current domain has meaningful values. Tabs: Overview, Content, Calendar,
Assets, Performance. No standalone "Notes" tab; notes remain contextual.

- OVERVIEW: Goal, Audience, Key message, Channels, progress, approvals waiting, next publish,
  performance snapshot, recent notes, recent activity.
- CONTENT TAB: real content items; filters All / Draft / Needs changes / Needs review / Approved /
  Scheduled / Published as applicable to the actual status model. Each item: thumbnail, title, format,
  platforms, language, status, owner where available, notes count, open action.
- CALENDAR TAB: the same calendar component, automatically scoped to this Campaign.
- ASSETS TAB: assets genuinely related to the Campaign — at minimum assets used by Campaign content. If
  the product needs "prepared for Campaign but not used yet" assets, create a proper Campaign↔Asset
  association. Do NOT hide a campaign id inside a free-text tag.
- PERFORMANCE TAB: start with What changed? What contributed? What can we try? Then charts/details.
  Contextual Give to Copilot.
- ACTIVITY: human-readable timeline — who created, who commented, who requested changes, who approved,
  what was scheduled/published.

## 15. Content library

Replace the old generic gradient-card feeling. Content is media-first. Header: Content, + Create post.
Tabs/status filters represent real lifecycle states, including scheduled and published where
applicable. Support Grid / List. Filters as useful: Brand, Campaign, Platform, Format, Status,
Language, Owner where data exists.

Cards/rows: REAL thumbnail/media if present; Title; Format (Post / Carousel / Reel / Story / Video /
Article / Thread); Platforms; Campaign; Status; updated time; notes count; owner/provenance where
useful. No fake gradient art when real media exists. For text-only content, use an intentional neutral
text treatment.

Quick actions: Edit, Preview, Duplicate where safely implemented, Schedule when eligible, Request
approval when applicable, More.

IDEAS WORTH MAKING: a small grounded suggestion area may appear above/beside the library (turn a strong
Reel topic into a carousel; fill a current strategy content gap; create content for an underfilled
Campaign). Suggestions must be grounded. No generic random "AI inspiration" presented as intelligence.

## 16. Global + Create

- Create is one of the most important product controls. Global menu: Create Post, Create Campaign,
  Create Creative, Upload Asset. Only show actions the member can actually complete. Preserve the real
  P6-16 permission gating.

## 17. Create Post — entry experience

This screen must be substantially easier than the old mechanical composer. Initial entry should not
show a wall of fields. Ask: "What would you like to create?" Paths: 1. Generate with AI, 2. Write
myself, 3. Start from an idea, 4. Repurpose existing content.

REPURPOSE: implement as a grounded workflow, not generic model memory. User selects a real previous
ContentItem. Its text/context becomes explicit bounded source material. Generate a NEW draft. Preserve
provenance/source relationship where appropriate. Do not silently overwrite the old post.

## 18. Create Post — format selection

Formats supported by the data model include Post, Carousel, Story, Reel, Video, Article, Thread. Do not
show a format that the selected target platform(s) cannot support. Use the real social-provider
capability registry. Core social-first UI: Post, Carousel, Reel, Story, Video. Article/Thread may be
under More formats and only appear where target capabilities make sense. AI VIDEO GENERATION IS OUT OF
SCOPE. Uploaded/selected video is allowed where current publishing capabilities allow.

## 19. Create Post — guided basics

Before the main editor ask only what is useful: Brand (preselected from global Brand context where
exact); Campaign (optional; preserve campaign context if launched from a Campaign); Format; Platforms;
Content language (English, Arabic, Both); Goal (Educate, Engage, Promote, Awareness, Leads, Launch etc.
mapped to existing supported vocabulary). When there is a grounded recommendation, show it as a
recommendation, not as a forced choice ("Recommended: Educate — based on your current Awareness
strategy."). Advanced fields remain hidden until needed.

## 20. Create Post — main composer

Desktop composition: LEFT / CONTEXT compact content details; CENTER editor; RIGHT live social preview /
context. Do not preserve the old mechanical layout just because the demo had it.

CENTER EDITOR: Caption, Hashtags, First comment where supported, Platform variants. AI inline actions:
Shorten, Rewrite, Make friendlier, More professional, Translate, Generate hashtags, try other relevant
existing tools. Do not force user to open Copilot for small text transformations.

Brand Brain is automatic. Show subtle "Using {Brand} Brand Brain"; expand to Tone, Audience, Campaign,
Pillar, relevant sources.

CITATIONS: the backend already stores citations from retrieval. When useful: "Based on Brand Brain" —
View sources. Do not expose model names/prompts/provider internals.

INSUFFICIENT KNOWLEDGE: use the existing flag. Show "BrandSpace needs more information before it can
make a grounded draft about this topic." Actions: Add knowledge, Open Brand Brain. The refusal remains
free if the backend currently guarantees that.

CREDIT QUOTE: the backend supports quoting AI generation before spend. Surface a small understandable
estimate before AI actions: "Estimated: X credits". Do not expose tokens/provider costs.

## 21. Platform variants

One ContentItem may have platform-specific variants. Show tabs/segmented controls (Instagram, Facebook,
LinkedIn, TikTok, X) only for selected/supported targets. Allow Optimize for each platform. Never assume
the same caption is ideal everywhere. Validation comes from real platform config. Friendly errors:
instead of "maxBodyChars exceeded" say "Instagram caption is 128 characters over the limit." with
action Shorten with AI; instead of "unsupported media" say "This Reel needs vertical media." with
action Choose 9:16 media.

## 22. Live social preview

The repository already contains SocialPostPreview support for feed, story, reel, vertical video,
carousel indicators and platform-specific composition. Make this a PRIMARY part of Create Post. Preview
changes immediately when platform, format, caption, media or platform variant changes. FEED:
Instagram/Facebook/LinkedIn/X compositions reflect their supported preview treatment. REEL: 9:16
vertical preview, identity overlay, caption, action rail, video state, Reel label, optional safe-zone
overlay. STORY: 9:16 vertical, story progress treatment, supported content overlay. VIDEO:
vertical/feed treatment according to platform/format. MULTI-PLATFORM: allow "Compare previews" for
selected platforms where practical.

## 23. Carousel experience

Carousel is not "several uploaded files in a field". Use ordered media as slides: Slide 01, Slide 02,
Slide 03, +; drag/reorder; duplicate media reference where appropriate; remove; replace; Choose Asset;
Upload; Generate visual. Preview: real carousel frame, current slide, left/right navigation, dots,
"Slide 2 of 5". The backend's ordered assetIds should preserve carousel order. Do NOT build a
Canva-style freeform slide editor in this correction.

AI CAROUSEL: for a topic, AI may propose a slide OUTLINE first (Hook, points, CTA). Preview the
outline. Then the user may generate/select visuals. Do not create fake editable text layers if the
durable model does not support per-slide text.

## 24. Reel experience

Reel is not a Feed Post with a video attached. Provide 9:16 preview, video asset, duration/details when
known, caption, hashtags, platform validation, publishing readiness, optional cover where
provider/product support is implemented. If cover selection needs durable state and none exists, design
and implement the smallest correct durable field/model. Do not fake a cover selection that disappears on
reload. No AI video generation. AI image generation may create a static cover where supported.

## 25. Media inside composer

"Add media" opens an in-context drawer/sheet: Upload, Asset Library, Generate with AI. Do not navigate
away merely to select media. UPLOAD uses the one Asset upload pipeline. ASSET LIBRARY: brand + shared
scope, real selectable/clean/ready assets only. GENERATE WITH AI invokes Creative image generation
contextually; after generation the result becomes an ordinary Asset marked AI_GENERATED, enters the
scan/processing lifecycle, and when usable is attached to the post. The user should not have to
manually go Creative → Assets → Content → find the item again.

## 26. Creative Studio

Keep the standalone Creative Studio for more deliberate work (brand-grounded image generation; square,
portrait, story, landscape; quote before spend; regenerate; adapt; save into Assets; use in Content).
Improve the standalone UX, but ensure the SAME generation capability is available contextually inside
Content. Use Brand palette, identity, approved knowledge and canonical assets where the current
generator supports them. Do not claim a full graphic-design editor. Do not add AI video generation.

## 27. Post status / lifecycle

Without approval: Draft → Scheduled → Publishing → Published. With approval: Draft → In review →
Approved → Scheduled → Publishing → Published. Changes requested clearly returns the content to
editable work. If approved content is edited, the current backend revokes approval; the UI MUST
warn/explain this before/after edit: "This post was approved. Editing its content or media will return
it to Draft and require review again." Do not let the user discover this only after clicking Save.
Autosave where appropriate. Show "Saved just now". Do not lose drafts on navigation.

## 28. Notes / conversations

Notes stay contextual. Do NOT build Notion/Jira inside BrandSpace. Supported contextual subjects must
include Content, Campaign, Brand, Asset. Asset notes are required; the existing Notes model lacks an
Asset subject — add it properly with migration/service/RLS/isolation coverage.

Conversation UI: Avatar, Name, relative timestamp, note body, Reply, Resolve. Resolved threads can
reopen. @MENTION: real typeahead (@Sa → Sara), not a clumsy multi-select. ASSIGNMENT: the backend
already supports assignedToUserId — expose it. DUE: add optional dueAt to a Note thread. IMPORTANT: a
simple importance flag (Normal vs Important). Do NOT add custom task statuses, subtasks, Kanban,
estimates, dependencies or project-management complexity. Deep links must open the EXACT context
(post/campaign/brand/asset + target note highlighted). Home and Notifications should link to that exact
context.

## 29. Approvals + Notes

Approvals remain the source of truth. Do not create a second approval workflow. Solo/no-policy: Draft →
Schedule. Team/approval-required: Draft → Request approval. Reviewer sees post preview, context,
conversation, Approve, Request changes, Reject where current domain supports it. REQUEST CHANGES: the
existing backend already creates a Note with the decision reason and mentions the author — preserve and
expose that. After author edits: Resolve note, Resubmit — make this feel like one flow. The standalone
Approvals route may remain for power users/queue access but is not a primary sidebar module. Do NOT add
multi-step approval chains. Do NOT add external/guest approval.

## 30. Asset library

The Asset backend is much stronger than the current visible UX. Use it. TOP: Assets, Search, Upload,
Create folder. VISUAL LIBRARY with real thumbnails; internal navigation/filtering: All, Images, Videos,
Documents, Recent, AI generated, Uploaded, Shared, Unused where usage can be derived honestly; Folders;
Tags; Brand scope. Do not pretend "Smart Collection" is a persisted object if it is just a filter — use
"Views" or "Smart views" for derived collections.

ASSET CARD: real preview, name, type, dimensions when relevant, campaign/use context where available;
small badges only where meaningful (AI generated, Shared, Processing, Rights expiring).

DETAIL DRAWER: large preview; Name; Type; Dimensions; File size; Brand/shared; Folder; Tags; Source
(Uploaded / AI generated / Imported); Created by; Created at; License; Rights expiry where real values
exist; Versions; Used in. Actions: Use in post, Download where allowed, Replace/version, Move, Edit
tags/metadata, Archive, Restore when applicable.

USED IN: derive Content usage from real ContentVariant assetIds (post title, campaign, status/date). Do
not invent relationships. FOLDERS / TAGS / VERSIONS: use the existing domain. Bulk actions: Move, Tag,
Add to Campaign if a proper relationship exists, Archive. DUPLICATES: use current checksum protection;
explain duplicate upload humanly. PROCESSING / SCANNING: do not show broken previews as if files are
ready — show Processing, Scanning, Unavailable, Failed/quarantined with safe messages.

RIGHTS: the backend already stores license and rightsExpiryAt but current publishability does not
appear to use rights expiry. Audit and complete this product contract. If an asset's rights are expired
and the intended semantics are "may not publish", enforce it in the ONE publishability predicate shared
by Composer and Publishing, not merely as a UI warning. Add tests. If rights expiry is informational
under current owner policy, state that clearly rather than pretending it blocks.

## 31. Brand Kit + assets

Brand Kit is a VIEW over canonical Brand Profile data and the one Asset Library. Do not duplicate files.
Expose Approved Logos, Palette, Typography references, Patterns/icons where real Assets exist. Brand
Profile remains canonical for identity meaning. Asset Library remains canonical for file bytes.

## 32. Calendar

Desktop: Month, Week, Agenda. Filters: Brand, Platform, Campaign, Status. Mobile: Agenda-first.

UNSCHEDULED TRAY: show eligible unscheduled drafts ("Unscheduled · N"). Drag an eligible draft onto the
Calendar on desktop; after drop, choose/confirm time if needed. Use the real scheduling action. No
external publish occurs merely because the user moved a draft unless current scheduler semantics
intentionally make that schedule executable and readiness is satisfied.

POST DRAWER: replace the heavy modal/dialog feeling with a side drawer where appropriate. Show Preview,
Date/time, Platforms, Campaign, Status, Approval, Notes, Publishing readiness. Actions based on
permissions/state: Edit, Reschedule, Request approval, Cancel schedule, Open full post.

DRAG/DROP: an accessible keyboard alternative must exist. Do not make drag the only scheduling path.
BEST TIME: only show a best-time recommendation if supported by actual measured data; no AI guessing; if
evidence is insufficient, do not display a recommendation. **Amended by D-329 (prototype v94 Phase
2B-1, owner, 2026-09-26):** the posting times an operator configures for a country may be offered, but
only labelled "Suggested time" / «وقت مقترح» — never "best time" — and a MEASURED best time, when one
exists, always takes precedence over them. CALENDAR INTELLIGENCE: contextual, quiet
suggestion ("Tuesday has been empty for 5 weeks.") if real; Ask/Give to Copilot; no popups.

## 33. Publishing

Customer-facing area name: Publishing. Tabs: Queue, Published, Failed, Accounts. Do not force the user
to understand an "Integrations" technical page for ordinary publishing work.

QUEUE: scheduled time, content, platform/account, readiness, approval status. PUBLISHED: successful
publication history, external link where safe/available, published time. FAILED: clear reason, retry
eligibility, account/reconnection requirement (e.g. "Instagram post — Failed. Account authentication
expired." Reconnect). Copilot may explain/prepare the retry context. OAuth authorization MUST remain a
human interaction. After reconnect: "Account reconnected." Offer Retry. Do not silently retry an
external action without the required authorization contract. ACCOUNTS: connection health, display name,
provider, brand, status, last sync, expiry/reauth status, publish capability. Detailed connection
administration can also live under Settings > Connections. Avoid four customer concepts (Integrations /
Social Hub / Social Accounts / Connections) for the same thing.

## 34. Analytics

Change page order. TOP: What changed? (only from real data). Then: Why might this matter? (evidence /
strategy context; do not claim causation where data shows only correlation). Then: What can we try?
(actionable recommendation; Give to Copilot; View evidence). THEN detailed metrics (Reach, Views,
Engagement, Saves etc.), charts, comparisons, top posts, trends, breakdown by platform/campaign where
available. Surface data freshness/gaps honestly. CSV export: already supported; make it reachable but
secondary.

## 35. Intelligence

Analytics: WHAT HAPPENED. Intelligence: WHAT IT MAY MEAN / OPPORTUNITIES / GAPS. Examples grounded in
real data: Content gap, Opportunity, Risk. Every insight: basis, evidence, period, scope, confidence
only where real, action. Home shows only the top relevant insights. Intelligence remains the full
investigation area. No live competitor feed. No live trend claims without a provider.

## 36. Learn → Brand Brain loop

A performance insight is NOT automatically Brand truth. Flow: analytics/intelligence detects candidate
→ evidence stored → potential learning → human reviews → Accept / Edit / Dismiss → accepted learning
enters Brand Brain → future strategy/content may use it. Show this loop visibly.

## 37. Global Copilot

Copilot becomes a persistent side drawer / global Top Bar experience, not merely a destination page.
Context should automatically carry Workspace, Brand, current surface, Campaign when applicable,
ContentItem when applicable, Analytics/Intelligence context when applicable ("I'm looking at October
Awareness.", "I'm looking at Signs your cat may be unwell.", "I'm looking at Instagram performance for
the last 6 weeks."). Reuse the existing typed Copilot tool registry — READ: analytics.summary,
brand.context, content.search, calendar.lookup, campaign.list; REVERSIBLE INTERNAL:
automation.create_rule, campaign.create, campaign.update, content.draft, calendar.place; EXTERNAL:
publishing.publish_now. Do not invent unrestricted Copilot powers.

## 38. Copilot action UX

Copilot is not just Q&A. Example: "Create two Arabic educational posts next week." → preview (2 Arabic
educational Instagram drafts; Brand; Campaign; dates; grounded in pillar; "Nothing will be published.";
Preview; Create drafts). READ: execute normally. INTERNAL REVERSIBLE: preview meaningful mutation,
confirm where current policy requires, execute, show result, offer Undo while safe. EXTERNAL /
DESTRUCTIVE: explicit plan-bound confirmation every time. No silent publish. AFTER ACTION: say exactly
what changed ("✓ 2 drafts created", "✓ attached to October Awareness", "No content was published").
UNDO: surface Undo for eligible actions; if Undo becomes invalid because the resource changed, say why.

## 39. Automations

The advanced Automations page remains, but ordinary users usually discover automation through Give to
Copilot or a repeated-workflow suggestion. Automation UI: Trigger, Condition, Action — only supported
closed-registry values. Explain external effects. Copilot-created rule always starts disabled; human
enables. PROPOSE_PUBLISH still requires confirmation at run time.

## 40. Notifications

Bell dropdown should feel social and useful. Tabs: All, Mentions, Approvals (optionally Publishing if
volume proves it useful). Examples: "Maha mentioned you — «راجع السعر قبل النشر.» — October Awareness ·
Post 12"; "Sara requested approval — Dental Awareness Reel"; "Instagram needs reconnection — Publishing
paused"; "Copilot prepared 3 drafts — Review". Deep link to exact object. Notifications are IN-APP in
this correction. Do not build customer email/SMS/WhatsApp/push preferences until those delivery
transports genuinely exist for notifications.

## 41. Social / friendly feel

Use avatars, real names, relative timestamps, content thumbnails, campaign names, human-readable
activity, conversation (presence only if genuine later). "Maha requested changes · 18 min ago", not
"customer.approval.decision.REQUEST_CHANGES". Do not use technical model/table vocabulary in customer
copy.

## 42. Microcopy

Prefer "Generate with AI" (not "AI Generation Request"), "Connect Instagram" (not "Social
Integration"), "Post" (not "Content Item"), "BrandSpace noticed" (not "Marketing Intelligence
Insight"), "Recurring workflow" (not "Automation Rule" except on the advanced Automations screen).
Tone: calm, smart, professional, friendly, helpful. Do not turn every success into confetti/emoji.

## 43. Empty states

Every empty state answers: what is this? why would I use it? what can I do now? (e.g. "No campaigns yet
— Campaigns keep strategy, content, review, calendar and performance together. — Create your first
campaign"; Brand Brain: "BrandSpace doesn't know much about this Brand yet." — Upload brand documents,
Add knowledge; Calendar: "Nothing scheduled yet." — Create post, Schedule a draft; Assets: "No assets
yet." — Upload, Generate visual). No dead empty surfaces.

## 44. Settings

Settings becomes organized and absorbs workspace administration: Workspace; Brand / Brand Profile;
Connections; Team; Roles & permissions; Notifications only for genuinely supported channel settings;
Security; Data Controls; AI/content retention; Activity; Billing & Usage. Do not overload the main
sidebar.

## 45. Team

Preserve existing RBAC and Brand Access. Friendly surface: Member, Role, Brand access, Status. Invite.
Change role/access only through existing permission rules. No custom-role builder in this correction
unless already supported.

## 46. Billing / usage

Show real Plan, AI credit balance, usage, limits, invoices/payment data that the current commerce
backend actually owns. Contextual AI generation surfaces use the existing quote service so the customer
sees understandable credits BEFORE spend. Do not expose model/provider/token pricing.

## 47. Activity

Global Activity remains available under Settings. Add contextual mini-timelines to Post, Campaign,
possibly Brand Brain where relevant. Use the existing AuditEvent source of truth. Human-readable copy.
No second activity store.

## 48. Mobile

Do not shrink desktop layouts. Mobile priorities: Home, Notifications, Notes, Approval, Post
review/edit, Copilot, Calendar Agenda, Publishing failures. Use drawers/sheets appropriately. Carousel
editor should remain usable. Preview may move below editor or into a Preview tab/sheet. Calendar month
grid does not need to be forced into a phone; Agenda-first is correct.

## 49. RTL / Arabic

Arabic remains fully supported. RTL: logical spacing; mirrored navigation where appropriate; drawer
direction appropriate to locale; direction-aware arrows; Arabic content direction independent of UI
locale; Latin platform names remain natural. Test both English/LTR and Arabic/RTL. Default CUSTOMER UI
remains English.

## 50. Accessibility

WCAG 2.2 AA remains mandatory. Keyboard: all critical workflows complete without pointer. Drag-and-drop
always has an alternate schedule/move control. Visible focus. Semantic dialogs/drawers. Proper live
regions for async generation/save where useful. Social preview decorative controls must not pretend to
be interactive. Color is never the only status signal.

## 51. Loading / error / permission states

Every redesigned screen needs: loading, empty, error, permission-denied/not-found semantics,
partial/degraded data, processing state, AI unavailable, insufficient credits, insufficient knowledge,
social account unavailable, asset processing/quarantine. No blank panels. No indefinite spinners. No
leaked technical errors/provider payloads.

## 52. Explicitly out of scope

AI video generation; voice generation; full graphic design editor / Canva clone; social listening;
sentiment monitoring; unified social inbox/comments; ads buying; CRM; real-time co-editing;
external/guest approval; multi-step approval chains; client portal; agency white-label portal; semantic
Asset search; arbitrary automation code/webhooks; global product search. These can be separate future
projects.

## 53. Current features to preserve and reuse

RLS / tenant isolation; BrandScope; permissions; Brand selector; Notes service; mentions; assignment;
resolve/reopen; approval service; request-changes → note integration; Brand Brain four-memory
architecture; provenance; citations; learning review; strategy engine; campaign domain; content
generation; manual content path; platform variants; content validation; content provenance; AI credit
quote; Asset Library domain; folders; tags; versions; dedupe; scan/quarantine; R2/storage; Creative
image generation; calendar scheduling; publishing pipeline; publish readiness; social connection
health; analytics measurements; anomaly detection; evidence; Intelligence; Copilot typed tools; Copilot
confirmation policy; Copilot undo; Automation engine; Notifications; Activity/Audit; Team/Brand access;
Billing/Credits; Data controls/retention; Arabic/RTL accessibility work. The purpose of this correction
is to make these capabilities feel like ONE product.

## 54. Required new/extended data work

Do not add schema unless required. Known likely additions: A. Notes — Asset subject support, optional
dueAt, simple importance state. B. Campaign Assets — if explicit campaign association for
not-yet-used assets is required, use a proper tenant-owned association; never encode campaign identity
into free-text tags. C. Reel cover — only if product/provider support requires durable cover selection
and no existing field can represent it. D. Preference/workflow observation — the smallest auditable
durable model necessary; do not infer from ephemeral UI state. E. Initial goal — use the existing
Strategy/Brand domain rather than a duplicate onboarding-only progress table. Every new tenant
model/column: migration, RLS where relevant, indexes, workspace composite ownership, tests, audit where
mutation matters.

## 55–60. Acceptance

The new-customer journey (§55), format-specific acceptance (§56), asset acceptance (§57), Home
acceptance with seeded real rows (§58), Copilot acceptance (§59) and the visual acceptance screenshot
set — Desktop EN, Desktop AR, Mobile EN, Mobile AR of Home, Brand Brain, Campaign Project Room, Content
Library, Create Feed Post, Create Carousel, Create Reel, Asset Library, Asset Detail, Calendar, Calendar
Post Drawer, Publishing, Analytics, Intelligence, Global Copilot, Notifications, Setup Wizard (§60) —
are tracked item by item in `docs/PHASE-6-FINAL-EXECUTION.md`. "Backend is correct" is not
visual/product acceptance.

## 61. Testing

Keep all existing regression suites. Add focused coverage for every corrected journey. Run: format,
lint, typecheck, unit, real PostgreSQL isolation/RLS, migrations from empty, schema drift, build,
Playwright EN/LTR and AR/RTL, desktop and mobile, accessibility, secret scan. No test may pass because
another test seeded its prerequisite. Every suite owns its setup.

## 62. Documentation

A FINAL execution document containing: owner-approved UX authority, screen inventory, route map,
backend reuse map, new schema changes, decision log, known deliberate exclusions, test map, Staging
acceptance matrix. For every major requirement mark DONE / PARTIAL / MISSING / BLOCKED. DONE means the
customer experience in this specification is actually delivered — not that code exists.

## 63. Execution order

1 UX authority / contract updates; 2 English default locale; 3 shell/navigation cleanup preserving
P6-16; 4 Setup Wizard; 5 Home; 6 Global Copilot drawer/context; 7 Notes UX + Asset subject +
due/important + deep links; 8 Content Library; 9 Create Post core; 10 Feed/Carousel/Reel/Story
previews; 11 Media drawer + Creative integration; 12 Asset Library redesign; 13 Approval integration
polish; 14 Campaign Project Room; 15 Calendar unscheduled + drag/drop + drawer; 16 Publishing IA; 17
Strategy/Plan; 18 Analytics/Intelligence action flow; 19 Living Brand Brain UX; 20 Preference learning;
21 Repeated-workflow suggestions; 22 Automations discovery through Copilot; 23 Settings/Team/Billing/
Activity cleanup; 24 mobile/RTL/a11y polish; 25 full journey regression; 26 screenshot review; 27
Staging deploy/smoke. Do not merge.

## 64. Stop conditions

Do not silently downgrade a requirement because an old document called a route "existing". Do not
declare the correction complete until the full customer journey is demonstrably usable. If a
requirement conflicts with a real safety/domain invariant: STOP that individual item, state the exact
conflict, preserve the invariant, and propose the smallest compliant implementation. Do not broaden the
product beyond this contract.

At completion report: exact branch; exact HEAD SHA; commits/workstreams; migrations; routes/screens
changed; backend capabilities reused; new models/fields; test totals; CI exact SHA; Staging deploy
status; screenshot inventory; remaining blockers/gaps; explicit confirmation that PR #37 remains NOT
MERGED; explicit confirmation that Production was untouched.
