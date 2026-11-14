'use client';

import { useRef, useState, type ChangeEvent } from 'react';
import { SubmitButton } from './pending-submit';

/**
 * PR D (D-607) — CHOOSE A PICTURE, CROPPED SQUARE IN THE BROWSER.
 *
 * The chosen file is drawn onto a canvas, centred and cut to its largest
 * square (at most 512 px a side), and put back in the same file field, so the
 * form posts the cropped picture — which also drops the camera's metadata
 * (location included) that the original carried. JPEG stays JPEG; PNG and WebP
 * become PNG, so a logo keeps its transparency. Without JavaScript, or if the
 * browser cannot draw the file, the original is posted and the server's rules
 * are the same either way; the page shows any picture cropped (`object-fit`).
 *
 * The circle (a person) or the rounded square (a logo) is the stylesheet's.
 */
const SIDE = 512;
const ACCEPT = 'image/png,image/jpeg,image/webp';

async function croppedSquare(file: File): Promise<File | null> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    await image.decode();
    const edge = Math.min(image.naturalWidth, image.naturalHeight);
    if (edge === 0) return null;
    const side = Math.min(edge, SIDE);
    const canvas = document.createElement('canvas');
    canvas.width = side;
    canvas.height = side;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(
      image,
      (image.naturalWidth - edge) / 2,
      (image.naturalHeight - edge) / 2,
      edge,
      edge,
      0,
      0,
      side,
      side,
    );
    const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.9));
    if (!blob) return null;
    const extension = type === 'image/jpeg' ? 'jpg' : 'png';
    return new File([blob], `picture.${extension}`, { type });
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function PictureUpload({
  action,
  removeAction,
  hiddenFields,
  currentSrc,
  fallback,
  shape,
  labels,
  testId,
}: {
  readonly action: (formData: FormData) => void | Promise<void>;
  readonly removeAction: (formData: FormData) => void | Promise<void>;
  readonly hiddenFields: Readonly<Record<string, string>>;
  readonly currentSrc: string | null;
  /** The initials or letter shown when there is no picture. */
  readonly fallback: string;
  readonly shape: 'circle' | 'square';
  readonly labels: {
    readonly choose: string;
    readonly save: string;
    readonly remove: string;
    readonly hint: string;
    readonly preview: string;
  };
  readonly testId: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const onChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const cropped = await croppedSquare(file);
    if (cropped && input.current && typeof DataTransfer !== 'undefined') {
      const transfer = new DataTransfer();
      transfer.items.add(cropped);
      input.current.files = transfer.files;
    }
    setPreview((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(cropped ?? file);
    });
  };

  const shown = preview ?? currentSrc;
  const hidden = Object.entries(hiddenFields).map(([key, value]) => (
    <input key={key} type="hidden" name={key} value={value} />
  ));

  return (
    <div className="bsp-picup" data-testid={testId}>
      <span
        className={
          shape === 'circle' ? 'bsp-tm-av bsp-picup-mark' : 'bsp-bcard-mark bsp-picup-mark'
        }
        data-c="0"
        data-pic={shown ? 'true' : undefined}
        role={shown ? 'img' : undefined}
        aria-label={shown ? labels.preview : undefined}
        aria-hidden={shown ? undefined : true}
      >
        {shown ? <img className="bsp-pic" src={shown} alt="" /> : fallback}
      </span>
      <form action={action} className="bsp-picup-form" encType="multipart/form-data">
        {hidden}
        <input
          ref={input}
          type="file"
          name="picture"
          accept={ACCEPT}
          required
          onChange={onChange}
          className="bs-control"
          aria-label={labels.choose}
          data-testid={`${testId}-file`}
        />
        <span className="bsp-nts-bar">
          <SubmitButton className="bsp-btn bsp-sm bsp-pur" data-testid={`${testId}-save`}>
            {labels.save}
          </SubmitButton>
          <span className="bsp-nts-hint">{labels.hint}</span>
        </span>
      </form>
      {currentSrc ? (
        <form action={removeAction}>
          {hidden}
          <SubmitButton className="bsp-btn bsp-sm bsp-ghost" data-testid={`${testId}-remove`}>
            {labels.remove}
          </SubmitButton>
        </form>
      ) : null}
    </div>
  );
}
