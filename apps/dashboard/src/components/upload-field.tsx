'use client';

import {
  createContext,
  useCallback,
  useContext,
  useState,
  useTransition,
  type FormEvent,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
} from 'react';
import type { MessageKey } from '../i18n/messages';
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
  /** `The upload didn’t reach us. Check your connection and try again.` */
  readonly connection: string;
}

/** The upload words from a translator, for client components that translate themselves. */
export function uploadTexts(t: (key: MessageKey) => string): UploadTexts {
  return {
    rules: t('upload.rules'),
    refusedType: t('upload.refusedType'),
    refusedSize: t('upload.refusedSize'),
    refusedEmpty: t('upload.refusedEmpty'),
    uploading: t('upload.uploading'),
    connection: t('upload.connection'),
  };
}

type Status =
  | { readonly kind: 'idle' }
  | { readonly kind: 'uploading'; readonly name: string }
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
  ...form
}: {
  readonly formRef?: Ref<HTMLFormElement>;
  readonly action: (formData: FormData) => Promise<void>;
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
    const file = [...data.values()].find(
      (value): value is File => value instanceof File && value.size > 0,
    );
    if (file && !check(file)) return;
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
  inputRef,
  ...input
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'accept'> & {
  readonly submitOnChoose?: boolean;
  readonly onChosen?: (file: File | null) => void;
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
        const admissible = check(file);
        if (!admissible) {
          // A refused file is not left in the control to be sent anyway.
          element.value = '';
          onChosen?.(null);
          return;
        }
        onChosen?.(file);
        if (submitOnChoose) element.form?.requestSubmit();
      }}
    />
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
      hidden={tone === null}
    >
      {message}
    </span>
  );
}
