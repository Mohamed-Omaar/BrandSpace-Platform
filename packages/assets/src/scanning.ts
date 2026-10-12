import type { ScanningPolicy } from './policy';

/**
 * Malware scanning — docs/SECURITY.md §11.3.
 *
 * THE ABSTRACTION IS THE DELIVERABLE; THE IMPLEMENTATION IS NOT. No production
 * scanner has been approved, so naming one here would be inventing a vendor
 * decision that belongs to the owner (CLAUDE.md §2.2). What ships is the
 * interface, a deterministic mock, and a factory that REFUSES the mock in
 * production — so a deployment without a real scanner fails closed rather than
 * quietly marking every upload clean.
 *
 * QUARANTINE IS THE DEFAULT, NOT THE EXCEPTION. An asset starts at
 * `scanStatus = PENDING`, which means quarantined: `isSelectable` requires
 * CLEAN, and so does every download path. Nothing has to remember to quarantine
 * a file, because nothing has to do anything for a file to be unusable. The
 * only transition that makes an asset usable is a scanner returning `clean`.
 *
 * WHY THE SCANNER SEES BYTES AND NOT A KEY. A scanner that fetches its own copy
 * is a second reader of the object store with its own credentials and its own
 * view of which tenant it is acting for. Handing it the bytes the pipeline
 * already holds keeps the number of things that can read a customer file at
 * one.
 */

export type ScanVerdict = 'clean' | 'infected' | 'failed';

export interface ScanResult {
  readonly verdict: ScanVerdict;
  /**
   * A stable reason key when the verdict is not `clean`. NEVER a scanner
   * message, a signature name or a vendor string: those reach a customer, and a
   * signature name tells an attacker which engine to test against.
   */
  readonly reason?: string;
  /**
   * PR F (g), Q13 — set only by the `none` scanner: the file was let through
   * WITHOUT being looked at, and the asset records that (`not_scanned`) rather
   * than claiming it was checked.
   */
  readonly notScanned?: true;
}

export interface VirusScanner {
  readonly key: string;
  scan(input: {
    readonly bytes: Uint8Array;
    readonly declaredMimeType: string;
    readonly timeoutMs: number;
  }): Promise<ScanResult>;
}

/**
 * The EICAR test string — the industry's standard harmless probe.
 *
 * IT IS NOT MALWARE AND CANNOT BE. It is a 68-byte printable ASCII string that
 * every antivirus product agrees to report as a detection, published by EICAR
 * for exactly this purpose: proving the scanning PATH works without anybody
 * handling a real sample. Using it means the quarantine tests exercise the same
 * code a real infection would, rather than a branch wired to a boolean.
 *
 * Split across a concatenation so this source file is not itself flagged by a
 * scanner running over the repository, which would be a tedious way to break
 * CI.
 */
export const EICAR_TEST_STRING =
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE' + '!$H+H*';

/**
 * The development and test scanner.
 *
 * DETERMINISTIC, and that is the requirement rather than a convenience. A test
 * that asserts "an infected file never becomes selectable" is worth nothing if
 * the verdict depends on a network call, a signature database version or the
 * time of day. Every input here maps to exactly one verdict, every run.
 *
 *   - Bytes containing the EICAR string      -> infected
 *   - Bytes containing the failure probe     -> failed (the scanner errored)
 *   - Everything else                        -> clean
 *
 * The failure probe exists because "the scanner could not reach a verdict" is a
 * genuinely different outcome from "the file is infected", and the product must
 * behave differently: an infected file is terminal, a failed scan is retryable
 * and leaves the asset quarantined meanwhile. Without a way to provoke it, that
 * branch would be untested.
 */
export const SCAN_FAILURE_PROBE = 'BRANDSPACE-SCANNER-FAILURE-PROBE';

export class MockVirusScanner implements VirusScanner {
  readonly key = 'mock';

  async scan(input: {
    bytes: Uint8Array;
    declaredMimeType: string;
    // Accepted and unused: this scanner is synchronous and cannot exceed a
    // deadline. Declared so the class matches `VirusScanner` exactly, and so a
    // caller cannot tell the mock from a real engine by its signature.
    timeoutMs?: number;
  }): Promise<ScanResult> {
    /*
     * A BOUNDED WINDOW, not the whole file. A scanner that reads 500 MB into a
     * string to look for a 68-byte marker is a memory problem of its own, and
     * both probes are written at the start of the fixtures that use them. A
     * real engine streams; this one reads the first 64 KB, which is the same
     * shape of bound.
     */
    const window = input.bytes.subarray(0, Math.min(input.bytes.length, 64 * 1024));
    const text = new TextDecoder('utf-8', { fatal: false }).decode(window);

    if (text.includes(SCAN_FAILURE_PROBE)) {
      return { verdict: 'failed', reason: 'scan_failed' };
    }
    if (text.includes(EICAR_TEST_STRING)) {
      return { verdict: 'infected', reason: 'infected' };
    }
    return { verdict: 'clean' };
  }
}

/**
 * PR F (g), Q13 — NO SCANNER, by the owner's decision for the beta.
 *
 * The beta runs with file scanning OFF and accepts the risk: users may upload
 * the file types the product already allows, and each upload becomes usable
 * without a scan. Selected only by configuration (`assets.scanning.provider:
 * none` with `required: false`), so it is a recorded choice rather than a
 * missing scanner, and every asset it passes is marked `not_scanned`. What
 * stays: every file is served as a download, never rendered as a page, and the
 * size and type limits are unchanged.
 */
export class NoVirusScanner implements VirusScanner {
  readonly key = 'none';

  async scan(): Promise<ScanResult> {
    return { verdict: 'clean', notScanned: true };
  }
}

/**
 * PR F (g), Q13 — THE HOSTED SCANII API, built and switched off.
 *
 * One synchronous request per file: `POST <endpoint>` with the file as
 * multipart field `file` and HTTP Basic credentials (the API key and secret).
 * The answer's `findings` list is empty for a clean file; any finding is a
 * detection. The URL is configuration (`assets.scanning.scanii.endpoint`),
 * copied from Scanii's documentation for the chosen region, never assumed.
 *
 * WHAT IT NEVER DOES: put a credential, a finding name or a Scanii message
 * where a customer or a log can read it. A refusal, a timeout or an
 * unreadable answer throws a plain error, which the pipeline treats as "the
 * scanner could not answer" — retryable, and the file stays quarantined.
 */
export class ScaniiVirusScanner implements VirusScanner {
  readonly key = 'scanii';
  readonly #endpoint: string;
  readonly #authorization: string;
  readonly #fetch: typeof fetch;

  constructor(options: {
    readonly endpoint: string;
    readonly apiKey: string;
    readonly apiSecret: string;
    readonly fetch?: typeof fetch;
  }) {
    this.#endpoint = options.endpoint;
    this.#authorization = `Basic ${Buffer.from(`${options.apiKey}:${options.apiSecret}`).toString('base64')}`;
    this.#fetch = options.fetch ?? fetch;
  }

  async scan(input: {
    readonly bytes: Uint8Array;
    readonly declaredMimeType: string;
    readonly timeoutMs: number;
  }): Promise<ScanResult> {
    const form = new FormData();
    form.append(
      'file',
      new Blob([input.bytes as Uint8Array<ArrayBuffer>], { type: input.declaredMimeType }),
      'upload',
    );
    const response = await this.#fetch(this.#endpoint, {
      method: 'POST',
      headers: { authorization: this.#authorization },
      body: form,
      signal: AbortSignal.timeout(input.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`The scanner answered ${response.status}.`);
    }
    const body = (await response.json().catch(() => null)) as { findings?: unknown } | null;
    if (!body || !Array.isArray(body.findings)) {
      return { verdict: 'failed', reason: 'scan_failed' };
    }
    return body.findings.length > 0
      ? { verdict: 'infected', reason: 'infected' }
      : { verdict: 'clean' };
  }
}

/**
 * Resolve the scanner for an environment.
 *
 * THE GATE IS THE DEPLOYMENT ENVIRONMENT, NOT THE BUILD MODE — `APP_ENV`, never
 * `NODE_ENV`, for the reason D-97 records: `NODE_ENV` is `production` in ANY
 * production build, including the one the end-to-end suite serves.
 *
 * In production, `mock` is REFUSED. The alternative is a deployment that marks
 * every customer upload clean without looking at it, which is worse than one
 * that will not start: the first is a silent promise the product does not keep,
 * and docs/SECURITY.md §11.3 makes that promise explicitly.
 */
export function createVirusScanner(options: {
  readonly appEnv: string;
  readonly policy: Pick<ScanningPolicy, 'provider'> &
    Partial<Pick<ScanningPolicy, 'scaniiEndpoint'>>;
  readonly scanner?: VirusScanner;
  /** Scanii's API key and secret — the worker's own variables, never configuration. */
  readonly scaniiCredentials?: { readonly apiKey: string; readonly apiSecret: string } | null;
  readonly fetch?: typeof fetch;
}): VirusScanner {
  if (options.scanner) return options.scanner;
  if (options.policy.provider === 'none') return new NoVirusScanner();
  if (options.policy.provider === 'scanii') {
    const endpoint = options.policy.scaniiEndpoint ?? null;
    const credentials = options.scaniiCredentials ?? null;
    if (!endpoint || !credentials?.apiKey || !credentials.apiSecret) {
      throw new Error(
        'Scanii is selected but not configured: it needs assets.scanning.scanii.endpoint and the ' +
          'SCANII_API_KEY and SCANII_API_SECRET variables.',
      );
    }
    return new ScaniiVirusScanner({
      endpoint,
      apiKey: credentials.apiKey,
      apiSecret: credentials.apiSecret,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }
  if (options.policy.provider === 'mock' && options.appEnv === 'production') {
    throw new Error(
      'No malware scanner is configured. Configure a real scanner before enabling uploads.',
    );
  }
  return new MockVirusScanner();
}
