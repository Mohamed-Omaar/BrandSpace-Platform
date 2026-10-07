'use client';

import { useEffect, useRef } from 'react';

/**
 * BATCH 7 (A3) — A LOGO THAT WAS STILL BEING CHECKED HAS PASSED: make it the
 * brand's logo now, from the brand step itself. Submitted once, as soon as the
 * step sees the file READY and CLEAN; the action re-checks that on the server.
 */
export function LogoAttach({
  action,
  locale,
  brandId,
  assetId,
}: {
  readonly action: (formData: FormData) => Promise<void>;
  readonly locale: string;
  readonly brandId: string;
  readonly assetId: string;
}) {
  const form = useRef<HTMLFormElement | null>(null);
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    form.current?.requestSubmit();
  }, []);
  return (
    <form ref={form} action={action} hidden data-testid="setup-logo-attach">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="brandId" value={brandId} />
      <input type="hidden" name="assetId" value={assetId} />
    </form>
  );
}
