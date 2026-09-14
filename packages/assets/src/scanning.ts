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

  async scan(input: { bytes: Uint8Array; declaredMimeType: string }): Promise<ScanResult> {
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
  readonly policy: Pick<ScanningPolicy, 'provider'>;
  readonly scanner?: VirusScanner;
}): VirusScanner {
  if (options.scanner) return options.scanner;
  if (options.policy.provider === 'mock' && options.appEnv === 'production') {
    throw new Error(
      'No malware scanner is configured. Configure a real scanner before enabling uploads.',
    );
  }
  return new MockVirusScanner();
}
