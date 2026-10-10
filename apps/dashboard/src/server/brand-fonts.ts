import 'server-only';
import { assetUploadRules } from './upload-rules';
import type { UploadRules } from '../components/upload-rules';
import { BrandFontService, type AssetActor, type BrandFontStatus } from '@brandspace/assets';
import type { TenantScopedClient } from '@brandspace/database';
import {
  allSlots,
  bundledFont,
  catalogueCssFamily,
  catalogueFor,
  fontFaceCss,
  slotsOf,
  uploadedCssFamily,
  type BrandFontLanguage,
  type BrandFontRole,
  type ResolvedSlot,
  readStoredTypography,
  resolveTypography,
  type BrandFontCatalogue,
  type ReadableUploadedFont,
  type ResolvedTypography,
} from '@brandspace/shared';
import { assetPolicy, inAssetLibrary, type AssetServices } from './assets-context';
import type { WorkspaceSession } from './customer-context';
import { paletteFrom } from './brand-profile';
import { optionalMessage, translator } from '../i18n/messages';

/**
 * PHASE 2C-2 — BRAND FONTS IN THE DASHBOARD.
 *
 * The service lives in `@brandspace/assets`; this module wires it to the
 * dashboard's session, transaction and URLs, and answers the two questions the
 * screens ask:
 *
 *   - `brandTypographyFor` — the four slots AS THIS READER SEES THEM, with the
 *     @font-face CSS for exactly the fonts in use. Uploaded fonts reach the page
 *     only as short-lived URLs of the authenticated font route, and only when
 *     the reader holds `assets.read` and `brand.read` and the brand is in their
 *     scope; otherwise the slot falls back to the catalogue default.
 *   - `typographySummaryFor` — the four slots' NAMES for a management or
 *     summary line, whoever reads them; nothing is served.
 */

export function assetActorOf(session: WorkspaceSession): AssetActor {
  return {
    userId: session.customer.userId,
    permissionKeys: session.workspace.permissionKeys,
    brandScope: session.workspace.brandScope,
  };
}

export function fontUrl(locale: string, token: string): string {
  return `/${locale}/assets/font/${token}`;
}

export async function brandFontServiceFrom(
  services: Pick<AssetServices, 'db' | 'policy' | 'library' | 'download'>,
  workspaceId: string,
): Promise<BrandFontService> {
  return new BrandFontService({
    db: services.db,
    workspaceId,
    policy: await services.policy(),
    library: await services.library(),
    download: await services.download(),
  });
}

export function catalogueOf(policy: {
  readonly brandFonts: BrandFontCatalogue;
}): BrandFontCatalogue {
  return { catalogue: policy.brandFonts.catalogue, defaults: policy.brandFonts.defaults };
}

export interface BrandTypographyView {
  readonly resolved: ResolvedTypography;
  /** @font-face rules for exactly the fonts the slots use. Same-origin URLs only. */
  readonly css: string;
}

export async function brandTypographyFor(input: {
  readonly session: WorkspaceSession;
  readonly locale: string;
  readonly brandId: string;
}): Promise<BrandTypographyView> {
  return inAssetLibrary(input.session.workspace.workspaceId, async (services) => {
    const brand = await services.db.brand.findFirst({
      where: { id: input.brandId, deletedAt: null },
      select: { typography: true },
    });
    const policy = await services.policy();
    const fonts = await brandFontServiceFrom(services, input.session.workspace.workspaceId);
    const readable = await fonts.readable({
      brandId: input.brandId,
      actor: assetActorOf(input.session),
      urlFor: (token) => fontUrl(input.locale, token),
    });
    const resolved = resolveTypography({
      stored: brand?.typography ?? null,
      catalogue: catalogueOf(policy),
      readable,
    });
    return { resolved, css: fontFaceCss({ used: allSlots(resolved), readable }) };
  });
}

/**
 * The slots' NAMES — for Settings → Brand, the Asset Library's brand kit and
 * the image prompt. Uploaded fonts are named when their file is ready; nothing
 * is granted or served.
 */
export async function typographySummaryFor(
  db: TenantScopedClient,
  brandId: string,
  stored: unknown,
): Promise<ResolvedTypography> {
  const policy = await assetPolicy(db);
  const rows = await db.brandFont.findMany({
    where: {
      brandId,
      archivedAt: null,
      asset: {
        kind: 'FONT',
        status: 'READY',
        scanStatus: 'CLEAN',
        deletedAt: null,
      },
    },
    select: { id: true, language: true, displayName: true },
  });
  const named: ReadableUploadedFont[] = rows.map((row) => ({
    brandFontId: row.id,
    language: row.language === 'AR' ? 'ar' : 'en',
    displayName: row.displayName,
    url: '',
    format: 'truetype',
  }));
  return resolveTypography({ stored, catalogue: catalogueOf(policy), readable: named });
}

/**
 * The Asset Library's brand-kit line. A brand still on the v1 shape shows its
 * stored names as before; a v2 brand shows its four slots' names.
 */
export async function brandKitFontNames(
  db: TenantScopedClient,
  brandId: string,
  stored: unknown,
): Promise<readonly string[]> {
  const read = readStoredTypography(stored);
  if (read.version === 1) {
    return [read.legacy.heading, read.legacy.body].filter((name): name is string => !!name);
  }
  if (read.version === 0) return [];
  const resolved = await typographySummaryFor(db, brandId, stored);
  return [...new Set(allSlots(resolved).map((slot) => slot.name))];
}

/* ------------------------------------------------------------ Look & voice */

export interface LookSlotView {
  /** The select's value: the STORED choice (or the default when nothing is stored). */
  readonly value: string;
  /** The font the slot renders in for this reader, and whether that is a fallback. */
  readonly name: string;
  readonly cssFamily: string;
  readonly fellBack: boolean;
}

export interface LookOption {
  readonly value: string;
  readonly label: string;
  readonly cssFamily: string;
  readonly uploaded: boolean;
}

/**
 * Batch 7 PR C (2c) — A LOGO JUST UPLOADED THAT IS NOT THE LOGO YET, and why:
 * still being checked, passed and about to be attached, or refused. Never a
 * silent success over an empty slot (A3).
 */
export interface LookLogoPending {
  readonly state: 'checking' | 'attach' | 'refused';
  readonly assetId: string | null;
  /** What the slot says, in the reader's language. */
  readonly message: string;
}

export interface LookData {
  readonly palette: readonly string[];
  readonly logo: { readonly assetId: string; readonly url: string | null } | null;
  readonly logoPending: LookLogoPending | null;
  /** The images that may be the logo: READY, CLEAN, this brand's or shared (D-193). */
  readonly logoOptions: readonly { readonly id: string; readonly name: string }[];
  readonly slots: Readonly<
    Record<BrandFontLanguage, Readonly<Record<BrandFontRole, LookSlotView>>>
  >;
  readonly options: Readonly<Record<BrandFontLanguage, readonly LookOption[]>>;
  readonly fonts: readonly {
    readonly id: string;
    readonly language: BrandFontLanguage;
    readonly displayName: string;
    readonly status: BrandFontStatus;
  }[];
  readonly maxPerLanguage: number;
  readonly fontRules: UploadRules;
  readonly imageRules: UploadRules;
  /**
   * @font-face for the LOOK & VOICE TAB ONLY: every offered catalogue family
   * and the brand's readable uploaded fonts, so a picker can preview the choice
   * a person is making. A declared face is fetched only when text renders in it.
   */
  readonly css: string;
}

export async function lookDataFor(input: {
  readonly session: WorkspaceSession;
  readonly locale: string;
  readonly brandId: string;
  /** `?logo=`: the file the last upload left being checked. */
  readonly pendingLogoId?: string | null;
  /** `?logoReason=`: why the last upload was refused. */
  readonly refusedLogoReason?: string | null;
}): Promise<LookData> {
  const actor = assetActorOf(input.session);
  return inAssetLibrary(input.session.workspace.workspaceId, async (services) => {
    const brand = await services.db.brand.findFirst({
      where: { id: input.brandId, deletedAt: null },
      select: { colorPalette: true, typography: true, primaryLogoAssetId: true },
    });
    const policy = await services.policy();
    const catalogue = catalogueOf(policy);
    const fontsService = await brandFontServiceFrom(services, input.session.workspace.workspaceId);
    const readable = await fontsService.readable({
      brandId: input.brandId,
      actor,
      urlFor: (token) => fontUrl(input.locale, token),
    });
    const fonts = await fontsService.list(input.brandId, actor).catch(() => []);
    const resolved = resolveTypography({
      stored: brand?.typography ?? null,
      catalogue,
      readable,
    });
    const stored = slotsOf(readStoredTypography(brand?.typography ?? null));

    const logoId = brand?.primaryLogoAssetId ?? null;
    let logoUrl: string | null = null;
    if (logoId) {
      logoUrl = await services
        .download()
        .then((download) => download.grantFor({ assetId: logoId, actor, disposition: 'inline' }))
        .then((issued) => `/${input.locale}/assets/file/${issued.grant.token}`)
        .catch(() => null);
    }

    /*
     * Batch 7 PR C (2c) — THE LAST UPLOAD, UNTIL IT IS THE LOGO. The upload
     * waits a few seconds for the scan; a file that has not passed by then is
     * named here, the page re-reads itself while it is checked, and a file that
     * has passed is attached by the card (`attachBrandLogoAction`).
     */
    const messages = input.session.messageLocale;
    const t = translator(messages);
    const reasonText = (reason: string) =>
      optionalMessage(messages, `assets.reason.${reason}`) ?? t('upload.connection');
    let logoPending: LookLogoPending | null = null;
    if (input.refusedLogoReason) {
      logoPending = {
        state: 'refused',
        assetId: null,
        message: t('bb.look.logoRefused').replace('{reason}', reasonText(input.refusedLogoReason)),
      };
    } else if (input.pendingLogoId && input.pendingLogoId !== logoId) {
      const file = await services.db.asset.findFirst({
        where: {
          id: input.pendingLogoId,
          deletedAt: null,
          OR: [{ brandId: input.brandId }, { brandId: null }],
        },
        select: { name: true, kind: true, status: true, scanStatus: true, failureReason: true },
      });
      if (file && file.status === 'READY' && file.scanStatus === 'CLEAN' && file.kind === 'IMAGE') {
        logoPending = {
          state: 'attach',
          assetId: input.pendingLogoId,
          message: t('bb.look.logoChecking').replace('{name}', file.name),
        };
      } else if (
        !file ||
        file.kind !== 'IMAGE' ||
        file.status === 'PROCESSING_FAILED' ||
        file.status === 'QUARANTINED' ||
        file.scanStatus === 'INFECTED'
      ) {
        const reason = !file
          ? 'object_missing'
          : file.kind !== 'IMAGE'
            ? 'unsupported_type'
            : (file.failureReason ?? (file.scanStatus === 'INFECTED' ? 'infected' : 'scan_failed'));
        logoPending = {
          state: 'refused',
          assetId: input.pendingLogoId,
          message: t('bb.look.logoRefused').replace('{reason}', reasonText(reason)),
        };
      } else {
        logoPending = {
          state: 'checking',
          assetId: input.pendingLogoId,
          message: t('bb.look.logoChecking').replace('{name}', file.name),
        };
      }
    }

    const slotView = (language: BrandFontLanguage, role: BrandFontRole): LookSlotView => {
      const slot = resolved[language][role];
      const ref = stored[language][role];
      const value = ref
        ? ref.kind === 'catalogue'
          ? `catalogue:${ref.key}`
          : `uploaded:${ref.brandFontId}`
        : `catalogue:${slot.source === 'catalogue' ? slot.key : catalogue.defaults[language]}`;
      return {
        value,
        name: slot.name,
        cssFamily: slot.cssFamily,
        fellBack: slot.fallback !== null && slot.fallback !== 'unset',
      };
    };

    const options = (language: BrandFontLanguage): readonly LookOption[] => [
      ...catalogueFor(catalogue, language).map((font) => ({
        value: `catalogue:${font.key}`,
        label: font.family,
        cssFamily: catalogueCssFamily(font.key),
        uploaded: false,
      })),
      ...fonts
        .filter((font) => font.language === language)
        .map((font) => ({
          value: `uploaded:${font.id}`,
          label: font.displayName,
          cssFamily: uploadedCssFamily(font.id),
          uploaded: true,
        })),
    ];

    const previewSlots: ResolvedSlot[] = [
      ...catalogue.catalogue.flatMap((key) => {
        const font = bundledFont(key);
        return font
          ? [
              {
                source: 'catalogue' as const,
                key: font.key,
                name: font.family,
                cssFamily: catalogueCssFamily(font.key),
                fallback: null,
              },
            ]
          : [];
      }),
      ...readable.map((font) => ({
        source: 'uploaded' as const,
        brandFontId: font.brandFontId,
        name: font.displayName,
        cssFamily: uploadedCssFamily(font.brandFontId),
        fallback: null,
      })),
    ];

    return {
      palette: paletteFrom(brand?.colorPalette),
      logo: logoId ? { assetId: logoId, url: logoUrl } : null,
      logoPending,
      logoOptions: await services.db.asset.findMany({
        where: {
          deletedAt: null,
          archivedAt: null,
          status: 'READY',
          scanStatus: 'CLEAN',
          kind: 'IMAGE',
          OR: [{ brandId: input.brandId }, { brandId: null }],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: 200,
        select: { id: true, name: true },
      }),
      slots: {
        en: { heading: slotView('en', 'heading'), body: slotView('en', 'body') },
        ar: { heading: slotView('ar', 'heading'), body: slotView('ar', 'body') },
      },
      options: { en: options('en'), ar: options('ar') },
      fonts: fonts.map((font) => ({
        id: font.id,
        language: font.language,
        displayName: font.displayName,
        status: font.status,
      })),
      maxPerLanguage: policy.brandFonts.maxUploadedPerLanguage,
      // Batch 7 (A3): the rules each upload writes beside itself and checks on choosing.
      fontRules: assetUploadRules(policy, ['font']),
      imageRules: assetUploadRules(policy, ['image']),
      css: fontFaceCss({ used: previewSlots, readable }),
    };
  });
}
