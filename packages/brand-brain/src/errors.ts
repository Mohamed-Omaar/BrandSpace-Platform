import { AppError } from '@brandspace/shared';

/**
 * Brand Brain failures, mapped to the stable codes the rest of the platform
 * already uses (CLAUDE.md §5).
 *
 * THE NOT-FOUND SHAPE IS LOAD-BEARING. CLAUDE.md §2.1: unauthorized
 * cross-tenant access returns 404 shaped identically to a genuine miss. So a
 * brand in another workspace, a brand that never existed, and a brand the
 * caller may not read all produce the SAME error with the SAME message. A
 * distinguishable "forbidden" would confirm the row exists.
 */

export function brandNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Brand not found.');
}

export function knowledgeNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Knowledge item not found.');
}

export function candidateNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Knowledge candidate not found.');
}

export function documentNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Source document not found.');
}

export function conversationNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Conversation not found.');
}

/** A human rule would be overwritten by an inference. D-65, refused. */
export function humanPrecedenceViolation(): AppError {
  return new AppError(
    'CONFLICT',
    'This knowledge was entered or approved by a person and cannot be replaced automatically.',
  );
}

export function alreadyReviewed(): AppError {
  return new AppError('CONFLICT', 'This candidate has already been reviewed.');
}

export function versionNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Version not found.');
}

export function duplicateUpload(): AppError {
  return new AppError('CONFLICT', 'This file has already been uploaded to this brand.');
}

export function unsupportedFileType(): AppError {
  return new AppError('VALIDATION_FAILED', 'This file type is not supported.');
}

/**
 * The file's content is not what the caller said it was.
 *
 * A distinct error from "unsupported type", and worth keeping distinct: this
 * one usually means a renamed file or a mistaken extension, which is a thing
 * the customer can fix, and occasionally means someone trying to reach a parser
 * they were not offered. Neither is served by the vaguer message.
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

export function storageLimitReached(): AppError {
  return new AppError('QUOTA_EXCEEDED', 'This workspace has reached its storage limit.');
}
