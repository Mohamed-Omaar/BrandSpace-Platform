'use client';

import {
  createContext,
  useCallback,
  useContext,
  useState,
  useTransition,
  type ButtonHTMLAttributes,
  type ComponentProps,
  type FormEvent,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
} from 'react';
import { useRouter } from 'next/navigation';
import { Button, ProgressBar, Spinner } from '@brandspace/ui';
import type { MessageKey } from '../i18n/messages';
import type { UploadRelayKind } from '../app/api/upload/[kind]/route';
import {
  acceptOf,
  bytesText,
  formatListOf,
  maxBytesFor,
  refusalOf,
  rulesText,
  type UploadRules,
} from './upload-rules';

/**
 * BATCH 7 (A3) — AN UPLOAD IS NEVER SILENT, anywhere in the product.
 *
 *   - BEFORE: the accepted formats and the size limit are written beside the
 *     control, and the picker offers only those formats.
 *   - DURING: the control says the file is on its way ("Uploading …"); what
 *     happens to it next (being checked, being read) is shown by the page on
 *     the file's own row or tile.
 *   - FAILURE: the actual reason, in the same place — a type that is not
 *     admitted or a file that is too large is refused the moment it is chosen;
 *     a request that never reached the server says so.
 *
 * The form still posts to the SAME server action it always did: no new path.
 * It is submitted from here so a failure to reach the server can be told
 * apart from the server's own answer, and without script it still submits as
 * a plain form.
 */

export interface UploadTexts {
  /** `{formats} · up to {size}` */
  readonly rules: string;
  /** `This file type isn’t supported. Use {formats}.` */
  readonly refusedType: string;
  /** `This file is {size}. The limit is {max}.` */
  readonly refusedSize: string;
  /** `This file is empty.` */
  readonly refusedEmpty: string;
  /** `Uploading {name}…` */
  readonly uploading: string;
  /** P1: `Uploaded.` — the upload arrived. */
  readonly uploaded: string;
  /** `The upload didn’t reach us. Check your connection and try again.` */
  readonly connection: string;
  /** PR F (g): `Files aren’t scanned for malware during the beta. Upload and open them at your own risk.` */
  readonly notScanned: string;
  /** PR F (g): the link to the Terms clause, `See the terms`. */
  readonly notScannedLink: string;
}

/** The upload words from a translator, for client components that translate themselves. */
export function uploadTexts(t: (key: MessageKey) => string): UploadTexts {
  return {
    rules: t('upload.rules'),
    refusedType: t('upload.refusedType'),
    refusedSize: t('upload.refusedSize'),
    refusedEmpty: t('upload.refusedEmpty'),
    uploading: t('upload.uploading'),
    uploaded: t('upload.uploaded'),
    connection: t('upload.connection'),
    notScanned: t('upload.notScanned'),
    notScannedLink: t('upload.notScannedLink'),
  };
}

type Status =
  | { readonly kind: 'idle' }
  | { readonly kind: 'uploading'; readonly name: string; readonly percent?: number }
  | { readonly kind: 'uploaded' }
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'connection' };

interface UploadState {
  readonly rules: UploadRules;
  readonly locale: string;
  readonly texts: UploadTexts;
  readonly status: Status;
  readonly pending: boolean;
  /** Judge a chosen file: true when it may be sent; otherwise the reason is shown. */
  readonly check: (file: File | null | undefined) => boolean;
  readonly clear: () => void;
}

const UploadContext = createContext<UploadState | null>(null);

/** The enclosing upload form's state: whether a file is on its way, and as what. */
export function useUploadState(): Pick<UploadState, 'pending' | 'status' | 'texts'> {
  const { pending, status, texts } = useUpload();
  return { pending, status, texts };
}

function useUpload(): UploadState {
  const state = useContext(UploadContext);
  if (!state) throw new Error('An upload control must sit inside an <UploadForm>.');
  return state;
}

/** A redirect or a not-found thrown by a server action is navigation, not a failure. */
/**
 * P1 — send a form to the upload relay with `XMLHttpRequest`, the one browser
 * API that reports how much of a body has gone up. Resolves with the relay's
 * JSON (`{ location }` or `{ ok, reason }`); rejects when the request never
 * completed, which the form shows as the connection message.
 */
function sendWithProgress(
  kind: UploadRelayKind,
  data: FormData,
  onProgress: (percent: number) => void,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', `/api/upload/${kind}`);
    request.setRequestHeader('x-bs-upload', '1');
    request.responseType = 'json';
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress((event.loaded / event.total) * 100);
    };
    request.onload = () => {
      const body = request.response as Record<string, unknown> | null;
      if (request.status >= 200 && request.status < 300 && body) resolve(body);
      else reject(new Error(`upload relay answered ${request.status}`));
    };
    request.onerror = () => reject(new Error('upload relay unreachable'));
    request.onabort = () => reject(new Error('upload relay aborted'));
    request.send(data);
  });
}

function isNavigation(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null)?.digest;
  return (
    typeof digest === 'string' && /^NEXT_(REDIRECT|NOT_FOUND|HTTP_ERROR_FALLBACK)/.test(digest)
  );
}

export function UploadForm({
  action,
  rules,
  locale,
  texts,
  children,
  formRef,
  each,
  relay,
  onUploaded,
  ...form
}: {
  readonly formRef?: Ref<HTMLFormElement>;
  readonly action: (formData: FormData) => Promise<void>;
  /**
   * PR D (Media 1) — SEVERAL FILES IN ONE UPLOAD. With two or more files
   * chosen, each goes on its own through `each` (a non-redirecting variant of
   * the same upload path: one request per file, the same checks on each), the
   * status counting them; `done` gets what arrived and what was refused. One
   * file keeps the ordinary `action`.
   */
  readonly each?: {
    readonly upload: (formData: FormData) => Promise<{ ok: boolean; reason: string | null }>;
    readonly done: (outcome: {
      readonly uploaded: number;
      readonly refused: readonly { readonly name: string; readonly reason: string | null }[];
    }) => void;
  };
  /**
   * P1 — the upload relay kinds for this form's `action` (and its `each`
   * variant): with them the form shows a progress bar with a percentage. The
   * relay calls the same server actions, so nothing else changes.
   */
  readonly relay?: { readonly kind: UploadRelayKind; readonly each?: UploadRelayKind };
  /**
   * P1 — called once a relayed upload has arrived, before its redirect is
   * followed: what the server action's own navigation used to do to the
   * screen around the form (the Media dialog closed with it).
   */
  readonly onUploaded?: () => void;
  readonly rules: UploadRules;
  readonly locale: string;
  readonly texts: UploadTexts;
  readonly children: ReactNode;
  readonly id?: string;
  readonly className?: string;
  readonly 'data-testid'?: string;
}) {
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [pending, start] = useTransition();
  const router = useRouter();

  const check = useCallback(
    (file: File | null | undefined): boolean => {
      if (!file) {
        setStatus({ kind: 'idle' });
        return false;
      }
      const refusal = refusalOf(file, rules);
      if (refusal === null) {
        setStatus({ kind: 'idle' });
        return true;
      }
      const message =
        refusal === 'type'
          ? texts.refusedType.replace('{formats}', formatListOf(rules, locale))
          : refusal === 'size'
            ? texts.refusedSize
                .replace('{size}', bytesText(file.size, locale))
                .replace('{max}', bytesText(maxBytesFor(rules, file.type), locale))
            : texts.refusedEmpty;
      setStatus({ kind: 'refused', message });
      return false;
    },
    [rules, locale, texts],
  );

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const element = event.currentTarget;
    const data = new FormData(element);
    const files = [...data.values()].filter(
      (value): value is File => value instanceof File && value.size > 0,
    );
    if (each && files.length > 1) {
      if (!files.every((one) => check(one))) return;
      start(async () => {
        const refused: { name: string; reason: string | null }[] = [];
        let uploaded = 0;
        for (const [index, one] of files.entries()) {
          const name = `${index + 1}/${files.length} · ${one.name}`;
          setStatus({ kind: 'uploading', name, ...(relay?.each ? { percent: 0 } : {}) });
          const single = new FormData();
          for (const [key, value] of data.entries()) {
            if (!(value instanceof File)) single.append(key, value);
          }
          single.set('file', one);
          try {
            const outcome = relay?.each
              ? ((await sendWithProgress(relay.each, single, (percent) =>
                  setStatus({ kind: 'uploading', name, percent }),
                )) as { ok: boolean; reason: string | null })
              : await each.upload(single);
            if (outcome.ok) uploaded += 1;
            else refused.push({ name: one.name, reason: outcome.reason });
          } catch (error: unknown) {
            if (isNavigation(error)) throw error;
            refused.push({ name: one.name, reason: null });
          }
        }
        setStatus(uploaded > 0 && refused.length === 0 ? { kind: 'uploaded' } : { kind: 'idle' });
        each.done({ uploaded, refused });
      });
      return;
    }
    const file = files[0];
    if (file && !check(file)) return;
    if (relay && file) {
      setStatus({ kind: 'uploading', name: file.name, percent: 0 });
      start(async () => {
        try {
          const outcome = await sendWithProgress(relay.kind, data, (percent) =>
            setStatus({ kind: 'uploading', name: file.name, percent }),
          );
          setStatus({ kind: 'uploaded' });
          onUploaded?.();
          // The action's own redirect, followed as the action would have.
          if (typeof outcome['location'] === 'string') router.push(outcome['location']);
          else router.refresh();
        } catch {
          setStatus({ kind: 'connection' });
        }
      });
      return;
    }
    setStatus(file ? { kind: 'uploading', name: file.name } : { kind: 'idle' });
    start(async () => {
      try {
        await action(data);
      } catch (error: unknown) {
        if (isNavigation(error)) throw error;
        setStatus({ kind: 'connection' });
      }
    });
  };

  const state: UploadState = {
    rules,
    locale,
    texts,
    status,
    pending,
    check,
    clear: () => setStatus({ kind: 'idle' }),
  };
  return (
    <UploadContext.Provider value={state}>
      <form
        {...form}
        ref={formRef}
        action={action}
        onSubmit={onSubmit}
        aria-busy={pending || undefined}
      >
        {children}
        {rules.notScanned ? <UploadNotScannedLine /> : null}
      </form>
    </UploadContext.Provider>
  );
}

/**
 * The file control: the picker limited to the admitted formats, and the file
 * judged as it is chosen. `submitOnChoose` sends the form at once (a tile that
 * IS the upload); otherwise the form's own button sends it.
 */
export function UploadFileInput({
  submitOnChoose = false,
  onChosen,
  onChosenFiles,
  inputRef,
  ...input
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'accept'> & {
  readonly submitOnChoose?: boolean;
  readonly onChosen?: (file: File | null) => void;
  /** Every admissible file chosen (none when refused), for a picker that lists them. */
  readonly onChosenFiles?: (files: readonly File[]) => void;
  readonly inputRef?: Ref<HTMLInputElement>;
}) {
  const { rules, check } = useUpload();
  return (
    <input
      {...input}
      ref={inputRef}
      type="file"
      accept={acceptOf(rules)}
      onChange={(event) => {
        const element = event.currentTarget;
        const file = element.files?.[0] ?? null;
        // PR D (Media 1) — with several chosen, every one is judged.
        const admissible =
          element.files && element.files.length > 1
            ? [...element.files].every((one) => check(one))
            : check(file);
        if (!admissible) {
          // A refused file is not left in the control to be sent anyway.
          element.value = '';
          onChosen?.(null);
          onChosenFiles?.([]);
          return;
        }
        onChosen?.(file);
        onChosenFiles?.(element.files ? [...element.files] : []);
        if (submitOnChoose) element.form?.requestSubmit();
      }}
    />
  );
}

/**
 * PR F (g), Q13 — ONE SHORT LINE UNDER EVERY UPLOAD CONTROL while files are not
 * scanned for malware, linking to the Terms clause that says what that means.
 * Drawn by `UploadForm` itself, so no control can be left without it.
 */
function UploadNotScannedLine() {
  const { locale, texts } = useUpload();
  return (
    <span className="bsp-up-rules bsp-up-noscan" data-testid="upload-not-scanned">
      {texts.notScanned}{' '}
      <a href={`/${locale}/terms#uploads`} target="_blank" rel="noopener">
        {texts.notScannedLink}
      </a>
    </span>
  );
}

/** "PNG, JPG, or WEBP · up to 10 MB", written beside the control. */
export function UploadRulesLine({
  id,
  className,
}: {
  readonly id?: string;
  readonly className?: string;
}) {
  const { rules, locale, texts } = useUpload();
  return (
    <span id={id} className={className ?? 'bsp-up-rules'} data-testid="upload-rules">
      {rulesText(rules, locale, texts)}
    </span>
  );
}

/**
 * What is happening to the file, in place: refused (and why), on its way, or
 * that the request never arrived. A `result` from the server — the reason a
 * file it received was refused — is shown here too, until the next choice.
 */
export function UploadStatus({
  result,
  className,
  testId = 'upload-status',
}: {
  readonly result?: { readonly tone: 'error' | 'info'; readonly message: string } | null;
  readonly className?: string;
  readonly testId?: string;
}) {
  const { status, texts, pending } = useUpload();
  let tone: 'error' | 'info' | null = null;
  let message = '';
  if (status.kind === 'refused') {
    tone = 'error';
    message = status.message;
  } else if (status.kind === 'connection') {
    tone = 'error';
    message = texts.connection;
  } else if (status.kind === 'uploading' && pending) {
    tone = 'info';
    message = texts.uploading.replace('{name}', status.name);
  } else if (status.kind === 'uploaded') {
    tone = 'info';
    message = texts.uploaded;
  } else if (status.kind === 'idle' && result) {
    tone = result.tone;
    message = result.message;
  }
  return (
    <span
      role={tone === 'error' ? 'alert' : 'status'}
      aria-live="polite"
      className={className ?? 'bsp-up-status'}
      data-tone={tone ?? undefined}
      data-testid={testId}
      data-state={status.kind}
      hidden={tone === null}
    >
      {message}
      {status.kind === 'uploading' && pending && status.percent !== undefined ? (
        <ProgressBar value={status.percent} label={message} testId={`${testId}-progress`} />
      ) : null}
    </span>
  );
}

/**
 * P1 — THE SUBMIT BUTTON OF AN UPLOAD FORM, WAITING WHILE THE FILE GOES UP.
 * The upload form sends its file itself (with progress), so React's form
 * status never sees it; this reads the form's own state instead. At rest it
 * is exactly the button it replaces.
 */
export function UploadSubmitButton({
  children,
  className,
  disabled,
  ...button
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> & { readonly children?: ReactNode }) {
  const { pending } = useUpload();
  return (
    <button
      {...button}
      className={className}
      type="submit"
      disabled={disabled === true || pending}
      aria-busy={pending || undefined}
      data-pending={pending || undefined}
    >
      {pending ? <Spinner /> : null}
      {children}
    </button>
  );
}

/** P1 — the same, for an upload form's submit built with the design system's `Button`. */
export function UploadButton(props: Omit<ComponentProps<typeof Button>, 'type' | 'loading'>) {
  const { pending } = useUpload();
  return <Button {...props} type="submit" loading={pending} />;
}
