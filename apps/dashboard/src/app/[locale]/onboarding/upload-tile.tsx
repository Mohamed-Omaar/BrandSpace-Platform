'use client';

import {
  UploadFileInput,
  UploadRulesLine,
  UploadStatus,
  useUploadState,
} from '../../../components/upload-field';

/**
 * ROUND 4 (5.4) — THE PROTOTYPE'S UPLOAD TILE (`Auth.dc.html` line 150): one
 * chip, "Upload files" over its kinds, and no native file control on screen.
 * The tile is the file input's label; choosing a file posts the SAME form to
 * the SAME Brand Brain upload action. The input stays in the form, so it is
 * keyboard-reachable and named, and works for assistive technology.
 *
 * BATCH 7 (A3/A4): the kinds line is the configured rules (formats and size),
 * the picker offers only those, and a file outside them — an HTML page, say —
 * is refused on the tile the moment it is chosen, with the list it may be.
 */
export function SetupUploadTile({
  title,
  chooseLabel,
}: {
  readonly title: string;
  readonly chooseLabel: string;
}) {
  const { pending, status, texts } = useUploadState();
  return (
    <>
      <label className="bsp-wz-up" data-testid="setup-upload-tile" aria-busy={pending || undefined}>
        <UploadFileInput
          name="file"
          required
          className="bsp-wz-up-input"
          aria-label={chooseLabel}
          data-testid="setup-upload-input"
          submitOnChoose
        />
        <span className="bsp-wz-up-t" data-testid="setup-upload-title">
          {pending && status.kind === 'uploading'
            ? texts.uploading.replace('{name}', status.name)
            : title}
        </span>
        <UploadRulesLine className="bsp-wz-up-s" />
      </label>
      <UploadStatus testId="setup-upload-status" className="bsp-wz-hint bsp-up-status" />
    </>
  );
}
