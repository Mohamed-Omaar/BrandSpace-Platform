/**
 * Brand Brain's use of the shared object store.
 *
 * THE STORE ITSELF MOVED TO `@brandspace/storage`. It lived here while Brand
 * Brain was its only consumer; the Asset Library is the second, and two copies
 * of a storage driver is how one product ends up with two key layouts and two
 * answers to "may production run without a real adapter". Nothing about the
 * behaviour changed — the file was moved, not rewritten.
 *
 * WHAT STAYS HERE IS THE KEY LAYOUT, which is a tenancy decision belonging to
 * the feature that owns the objects rather than to the driver that writes them.
 * The re-exports below keep every existing caller — the dashboard, the worker,
 * the tests — importing exactly what they imported before.
 */

export {
  checksumOf,
  createObjectStore,
  defaultObjectStoreDirectory,
  FilesystemObjectStore,
  InMemoryObjectStore,
  type ObjectStore,
  type StoredObject,
} from '@brandspace/storage';

/**
 * Build the storage key for a source document.
 *
 * WORKSPACE FIRST, and not negotiable: a prefix that starts with the tenant is
 * what lets an object-store policy be written per tenant at all, and what makes
 * a mis-scoped read visible as a wrong prefix rather than as a plausible key.
 */
export function buildStorageKey(input: {
  workspaceId: string;
  brandId: string;
  documentId: string;
}): string {
  return `ws/${input.workspaceId}/brand/${input.brandId}/source/${input.documentId}`;
}
