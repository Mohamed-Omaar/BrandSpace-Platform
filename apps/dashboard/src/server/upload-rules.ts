import 'server-only';

import { AppError } from '@brandspace/shared';
import type { UploadRules } from '../components/upload-rules';

/**
 * BATCH 7 (A3) — THE RULES A FILE CONTROL WRITES BESIDE ITSELF, from the same
 * activated policy the server enforces. Never a list typed into a component.
 */

type AssetKind = 'image' | 'video' | 'audio' | 'document' | 'font';

interface AssetUploadPolicy {
  readonly allowedMimeTypes: Readonly<Record<AssetKind, readonly string[]>>;
  readonly maxFileBytes: Readonly<Record<AssetKind, number>>;
}

/** The Asset Library's rules for the given kinds (all of them when none are named). */
export function assetUploadRules(
  policy: { readonly upload: AssetUploadPolicy },
  kinds: readonly AssetKind[] = ['image', 'video', 'audio', 'document', 'font'],
): UploadRules {
  const mimeTypes: string[] = [];
  const maxBytesByType: Record<string, number> = {};
  for (const kind of kinds) {
    for (const type of policy.upload.allowedMimeTypes[kind] ?? []) {
      mimeTypes.push(type);
      maxBytesByType[type] = policy.upload.maxFileBytes[kind];
    }
  }
  const ceilings = Object.values(maxBytesByType);
  return {
    mimeTypes,
    maxBytes: ceilings.length > 0 ? Math.max(...ceilings) : 0,
    maxBytesByType,
  };
}

/** The Brand Brain's rules for a source document. */
export function sourceUploadRules(policy: {
  readonly allowedMimeTypes: readonly string[];
  readonly maxFileBytes: number;
}): UploadRules {
  return { mimeTypes: [...policy.allowedMimeTypes], maxBytes: policy.maxFileBytes };
}

/**
 * The machine-readable reason an upload was refused, when the service named
 * one (`publicDetails.reason`), for the control to say in words. Anything else
 * is not a reason a customer can act on and stays with the generic message.
 */
export function uploadReasonOf(error: unknown): string | null {
  if (!(error instanceof AppError)) return null;
  const reason = error.publicDetails['reason'];
  return typeof reason === 'string' && /^[a-z_]{1,40}$/.test(reason) ? reason : null;
}
