'use client';

import { useState } from 'react';

/**
 * ROUND 4 (5.4) — THE PROTOTYPE'S UPLOAD TILE (`Auth.dc.html` line 150): one
 * chip, "Upload files" over its kinds, and no native file control on screen.
 * The tile is the file input's label; choosing a file posts the SAME form to
 * the SAME Brand Brain upload action. The input stays in the form, so it is
 * keyboard-reachable and named, and works for assistive technology.
 */
export function SetupUploadTile({
  title,
  kinds,
  chooseLabel,
  sendingLabel,
}: {
  readonly title: string;
  readonly kinds: string;
  readonly chooseLabel: string;
  readonly sendingLabel: string;
}) {
  const [sending, setSending] = useState(false);
  return (
    <label className="bsp-wz-up" data-testid="setup-upload-tile" aria-busy={sending || undefined}>
      <input
        type="file"
        name="file"
        required
        className="bsp-wz-up-input"
        aria-label={chooseLabel}
        data-testid="setup-upload-input"
        onChange={(event) => {
          const form = event.currentTarget.form;
          if (!form || event.currentTarget.files?.length === 0) return;
          setSending(true);
          form.requestSubmit();
        }}
      />
      <span className="bsp-wz-up-t">{sending ? sendingLabel : title}</span>
      <span className="bsp-wz-up-s">{kinds}</span>
    </label>
  );
}
