'use client';

import { useEffect, useRef, useState } from 'react';
import { UploadFileInput, UploadRulesLine, UploadStatus } from '../../../components/upload-field';

export interface LogoNow {
  readonly name: string;
  /** The logo's own picture, once it is the brand's logo. */
  readonly src: string | null;
  readonly state: 'ready' | 'checking' | 'failed';
  /** What to say beside it: "x is your brand's logo", "Checking x…", or why it failed. */
  readonly message: string;
}

/**
 * BATCH 7 (A3) — THE WIZARD'S LOGO, NEVER SILENT. Choosing a file shows it in
 * the tile AT ONCE, with its name and a way to change or remove it; the rules
 * (formats, size) sit under the button; a refused file says why in the same
 * place. On the create form the file goes with Continue; once the brand
 * exists (`submitOnChoose`) it is uploaded the moment it is chosen.
 *
 * The tile's letter is the CUSTOMER's brand initial, a placeholder for their
 * logo — not Brandspace's own mark.
 */
export function LogoPicker({
  initial,
  now,
  submitOnChoose,
  texts,
}: {
  readonly initial: string;
  readonly now: LogoNow | null;
  readonly submitOnChoose: boolean;
  readonly texts: {
    readonly upload: string;
    readonly change: string;
    readonly remove: string;
    /** `{name} · uploaded when you continue` */
    readonly chosen: string;
  };
}) {
  const input = useRef<HTMLInputElement | null>(null);
  const [chosen, setChosen] = useState<{ name: string; url: string } | null>(null);
  useEffect(() => () => (chosen ? URL.revokeObjectURL(chosen.url) : undefined), [chosen]);

  const picture = chosen?.url ?? now?.src ?? null;
  const has = chosen !== null || (now !== null && now.state !== 'failed');
  return (
    <div className="bsp-wz-logo-box" data-testid="setup-logo">
      <div className="bsp-wz-logo-row">
        <span
          className="bsp-wz-logo"
          data-state={chosen ? 'chosen' : (now?.state ?? 'empty')}
          aria-hidden="true"
        >
          {picture ? <img src={picture} alt="" /> : initial}
        </span>
        {/* Beside the tile, centred on it: what the file is, then what to do with it. */}
        <div className="bsp-wz-logo-ctl">
          {chosen && !submitOnChoose ? (
            <span className="bsp-wz-logo-name" data-testid="setup-logo-name" dir="auto">
              {texts.chosen.replace('{name}', chosen.name)}
            </span>
          ) : now ? (
            <span
              className="bsp-wz-logo-name"
              data-testid="setup-logo-state"
              data-state={now.state}
              role={now.state === 'failed' ? 'alert' : 'status'}
              dir="auto"
            >
              {now.message}
            </span>
          ) : null}
          <span className="bsp-wz-logo-acts">
            <label className="bsp-wz-btn bsp-wz-sec bsp-wz-file">
              {has ? texts.change : texts.upload}
              <UploadFileInput
                id="setup-brand-logo"
                name="logo"
                inputRef={input}
                submitOnChoose={submitOnChoose}
                aria-describedby="setup-brand-logo-hint"
                data-testid="setup-logo-input"
                onChosen={(file) =>
                  setChosen(file ? { name: file.name, url: URL.createObjectURL(file) } : null)
                }
              />
            </label>
            {chosen && !submitOnChoose ? (
              <button
                type="button"
                className="bsp-wz-btn bsp-wz-ghost"
                data-testid="setup-logo-remove"
                onClick={() => {
                  if (input.current) input.current.value = '';
                  setChosen(null);
                }}
              >
                {texts.remove}
              </button>
            ) : null}
          </span>
        </div>
      </div>
      <UploadRulesLine id="setup-brand-logo-hint" className="bsp-wz-hint" />
      <UploadStatus testId="setup-logo-status" className="bsp-wz-hint bsp-up-status" />
    </div>
  );
}
