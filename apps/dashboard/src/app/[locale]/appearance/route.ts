import { NextResponse } from 'next/server';
import { colourSchemeSchema } from '@brandspace/shared';
import { isSupportedLocale } from '@brandspace/ui';
import { COLOUR_SCHEME_COOKIE } from '../../../server/colour-scheme';

/**
 * EACH PERSON'S LIGHT / DARK / DEVICE CHOICE (LF). The account menu's
 * "Appearance" item links here with the next choice; this records it in a
 * cookie (per device, owner decision) and goes back to the page. Only a path
 * inside this app's own locale is accepted as the way back.
 */
const YEAR = 60 * 60 * 24 * 365;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ locale: string }> },
): Promise<Response> {
  const { locale } = await params;
  const home = isSupportedLocale(locale) ? `/${locale}/overview` : '/en/overview';
  const url = new URL(request.url);
  const back = url.searchParams.get('back') ?? '';
  const safeBack =
    back.startsWith(`/${locale}/`) && !back.startsWith('//') && !back.includes('\\') ? back : home;
  const response = NextResponse.redirect(new URL(safeBack, url.origin), 303);
  const choice = colourSchemeSchema.safeParse(url.searchParams.get('to'));
  if (choice.success) {
    response.cookies.set(COLOUR_SCHEME_COOKIE, choice.data, {
      path: '/',
      maxAge: YEAR,
      sameSite: 'lax',
      secure: url.protocol === 'https:',
      httpOnly: true,
    });
  }
  return response;
}
