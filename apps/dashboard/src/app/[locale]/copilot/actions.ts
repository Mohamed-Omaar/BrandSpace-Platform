'use server';

import { createLogger, internalErrorFields } from '@brandspace/shared';
import { uploadReasonOf } from '../../../server/upload-rules';
import { requireWorkspaceAction } from '../../../server/customer-context';
import { uploadIntoLibrary } from '../../../server/asset-upload';

const log = createLogger({ context: { component: 'dashboard.copilot.chat-image' } });

/** PR A (smart Copilot, D-605) — what the chat sends a model: images only, at most 8 MB. */
const CHAT_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_CHAT_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * AN IMAGE FOR THE COPILOT TO READ. It goes into the person's own Asset
 * Library through the same upload path as Media — the same permission
 * (`assets.upload`), signature check, duplicate rule and malware scan — on the
 * conversation's brand, and its id travels with the next message. The API
 * sends it to the model only once the library marks it READY.
 */
export async function uploadChatImageAction(
  formData: FormData,
): Promise<{ ok: boolean; assetId: string | null; reason: string | null }> {
  const locale = String(formData.get('locale') ?? 'en');
  try {
    const session = await requireWorkspaceAction(locale, 'assets.upload');
    const file = formData.get('file');
    if (!(file instanceof File) || file.size === 0) throw new Error('no file');
    if (!CHAT_IMAGE_TYPES.has(file.type) || file.size > MAX_CHAT_IMAGE_BYTES) {
      return { ok: false, assetId: null, reason: 'chat_image_unsupported' };
    }
    const brandId = formData.get('brandId');
    const uploaded = await uploadIntoLibrary({
      workspaceId: session.workspace.workspaceId,
      actor: {
        userId: session.customer.userId,
        permissionKeys: session.workspace.permissionKeys,
        brandScope: session.workspace.brandScope,
      },
      file,
      bytes: new Uint8Array(await file.arrayBuffer()),
      brandId: typeof brandId === 'string' && brandId !== '' ? brandId : null,
      folderId: null,
    });
    return { ok: true, assetId: uploaded.assetId, reason: null };
  } catch (error: unknown) {
    log.warn('chat image upload failed', internalErrorFields(error));
    return { ok: false, assetId: null, reason: uploadReasonOf(error) };
  }
}
