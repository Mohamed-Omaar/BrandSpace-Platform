import { AppError } from '@brandspace/shared';

/**
 * Asset Library failures, mapped to the stable codes the rest of the platform
 * already uses (CLAUDE.md §5).
 *
 * THE NOT-FOUND SHAPE IS LOAD-BEARING. CLAUDE.md §2.1: unauthorized
 * cross-tenant access returns 404 shaped identically to a genuine miss. An
 * asset in another workspace, an asset that never existed, an asset in a brand
 * the member may not act on, and an asset that was deleted all produce the SAME
 * error with the SAME message. A distinguishable "forbidden" would confirm the
 * row exists, which is the inference the rule closes.
 *
 * EVERY CUSTOMER-FACING FAILURE IS A STABLE REASON KEY, never prose. A key is
 * what lets the dashboard render the failure in both languages, and it is what
 * stops an extractor, a scanner or a driver error from being printed verbatim
 * to a customer — which is how an internal path or a vendor name escapes.
 */

/** The reason keys a customer can be shown. Both translations live in the apps. */
export const ASSET_FAILURE_REASONS = [
  'unsupported_type',
  'content_type_mismatch',
  'file_too_large',
  'file_empty',
  'size_mismatch',
  'checksum_mismatch',
  'infected',
  'scan_failed',
  'scan_unavailable',
  'derivative_failed',
  'object_missing',
  'stuck_timeout',
  'unsafe_filename',
] as const;

export type AssetFailureReason = (typeof ASSET_FAILURE_REASONS)[number];

export function assetNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Asset not found.');
}

export function folderNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Folder not found.');
}

export function uploadSessionNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Upload session not found.');
}

export function versionNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Version not found.');
}

export function duplicateAsset(): AppError {
  return new AppError('CONFLICT', 'This file is already in the library.');
}

export function unsupportedFileType(): AppError {
  return new AppError('VALIDATION_FAILED', 'This file type is not supported.');
}

/**
 * The file's content is not what the caller said it was.
 *
 * A distinct error from "unsupported type", and worth keeping distinct: this
 * one usually means a renamed file or a mistaken extension, which the customer
 * can fix, and occasionally means someone trying to reach a handler they were
 * not offered. Neither is served by the vaguer message.
 */
export function contentTypeMismatch(): AppError {
  return new AppError(
    'VALIDATION_FAILED',
    "This file's contents do not match its type. It may have been renamed.",
  );
}

export function fileTooLarge(): AppError {
  return new AppError('VALIDATION_FAILED', 'This file is larger than the allowed size.');
}

export function emptyFile(): AppError {
  return new AppError('VALIDATION_FAILED', 'This file is empty.');
}

/**
 * The bytes that arrived are not the bytes that were announced.
 *
 * The session recorded a declared size at initiate, and the quota was spent
 * against it. A completion carrying more than that has spent quota it was not
 * granted, so it is refused rather than reconciled — reconciling would mean a
 * caller could always under-declare and then send whatever it liked.
 */
export function declaredSizeMismatch(): AppError {
  return new AppError('VALIDATION_FAILED', 'The uploaded file does not match what was announced.');
}

export function unsafeFileName(): AppError {
  return new AppError('VALIDATION_FAILED', 'That file name cannot be used.');
}

export function storageQuotaReached(): AppError {
  return new AppError('QUOTA_EXCEEDED', 'This workspace has reached its storage limit.');
}

export function assetLimitReached(): AppError {
  return new AppError('QUOTA_EXCEEDED', 'This brand has reached its asset limit.');
}

export function versionLimitReached(): AppError {
  return new AppError('QUOTA_EXCEEDED', 'This asset has reached its version limit.');
}

/**
 * Why a version upload lost a race — the machine-readable reason carried in
 * `publicDetails`, so a screen can say something more useful than a generic
 * conflict without parsing a message.
 */
export const ASSET_CHANGED_REASON = 'asset_changed_during_version_upload';

/**
 * B-1 — ANOTHER VERSION (OR A RESTORE) LANDED WHILE THIS ONE WAS UPLOADING.
 *
 * The request was built on a version of the asset that is no longer current,
 * so it is refused rather than silently stacked on top of somebody else's
 * change. RETRYABLE: nothing of this attempt was kept — its object is deleted
 * and its storage given back — so trying again is exactly the right response.
 * Never a raw unique-constraint error and never a 500.
 */
export function assetChangedDuringVersionUpload(): AppError {
  return new AppError(
    'CONFLICT',
    'This asset changed while your version was being uploaded. Please try again.',
    { reason: ASSET_CHANGED_REASON, retryable: true },
  );
}

export function uploadSessionExpired(): AppError {
  return new AppError('CONFLICT', 'This upload took too long and was cancelled. Please try again.');
}

/**
 * The asset exists and is not usable YET, or is not usable at all.
 *
 * Distinct from `NOT_FOUND` on purpose, and safe to distinguish here: the
 * caller has already been shown the asset, so its existence is not a secret.
 * What is hidden is WHY — "infected" and "still scanning" produce the same
 * message, because telling a customer their colleague uploaded malware is a
 * conversation the product should not have through an error string.
 */
export function assetNotUsable(): AppError {
  return new AppError('CONFLICT', 'This file is not available for use.');
}

export function folderNotEmpty(): AppError {
  return new AppError('CONFLICT', 'This folder still has items in it.');
}

export function folderTooDeep(): AppError {
  return new AppError('VALIDATION_FAILED', 'Folders cannot be nested that deeply.');
}

/**
 * A folder cannot be its own ancestor.
 *
 * A cycle is not merely untidy: every walk of the tree — the depth check, the
 * breadcrumb, the delete guard — becomes an infinite loop, and the first one to
 * run takes the process with it.
 */
export function folderCycle(): AppError {
  return new AppError('VALIDATION_FAILED', 'A folder cannot be moved inside itself.');
}

export function tooManyTags(): AppError {
  return new AppError('VALIDATION_FAILED', 'That is more tags than an asset can carry.');
}
