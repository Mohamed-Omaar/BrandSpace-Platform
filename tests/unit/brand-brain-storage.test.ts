import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FilesystemObjectStore,
  InMemoryObjectStore,
  buildStorageKey,
  checksumOf,
  createObjectStore,
  defaultObjectStoreDirectory,
} from '@brandspace/brand-brain';

/**
 * The object store, tested for the property that actually broke.
 *
 * Ingestion stopped being one process: the dashboard accepts the upload and the
 * worker parses it. The memory store passed every test in this repository and
 * still failed the end-to-end run, because nothing here had ever asked whether a
 * SECOND reader can see what the first one wrote. That is the question below.
 */

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'bs-store-test-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const KEY = buildStorageKey({ workspaceId: 'ws-1', brandId: 'brand-1', documentId: 'doc-1' });

describe('the development store is visible to a second reader', () => {
  it('returns bytes written by a different store instance on the same root', async () => {
    const writer = new FilesystemObjectStore(root);
    const reader = new FilesystemObjectStore(root);
    const bytes = new TextEncoder().encode('brand guidelines');

    const stored = await writer.put(KEY, bytes, 'text/plain');
    expect(stored.byteSize).toBe(bytes.byteLength);
    expect(stored.checksum).toBe(await checksumOf(bytes));

    // The worker is this second instance: a different object, a different
    // process in production, reaching the bytes only through the storage key.
    const readBack = await reader.get(KEY);
    expect(readBack).not.toBeNull();
    expect(new TextDecoder().decode(readBack as Uint8Array)).toBe('brand guidelines');
  });

  it('leaves no staging file behind for a reader to mistake for the object', async () => {
    const store = new FilesystemObjectStore(root);
    await store.put(KEY, new Uint8Array([1, 2, 3]), 'application/octet-stream');
    const entries = await readdir(path.join(root, 'ws', 'ws-1', 'brand', 'brand-1', 'source'));
    expect(entries).toEqual(['doc-1']);
  });

  it('reports a missing object as null rather than throwing', async () => {
    const store = new FilesystemObjectStore(root);
    const key = buildStorageKey({ workspaceId: 'ws-1', brandId: 'brand-1', documentId: 'gone' });
    expect(await store.get(key)).toBeNull();
  });

  it('deletes idempotently', async () => {
    const store = new FilesystemObjectStore(root);
    const key = buildStorageKey({ workspaceId: 'ws-2', brandId: 'brand-9', documentId: 'temp' });
    await store.put(key, new Uint8Array([9]), 'application/octet-stream');
    await store.delete(key);
    await expect(store.delete(key)).resolves.toBeUndefined();
    expect(await store.get(key)).toBeNull();
  });
});

describe('a storage key can never escape the root', () => {
  /*
   * A key becomes a PATH here, and a path is where `..` stops being a string and
   * starts being another tenant's directory. Every one of these is refused
   * before it reaches the filesystem.
   */
  const hostile = [
    'ws/../../etc/passwd',
    'ws/ws-1/brand/../../../secrets',
    '/absolute/key',
    'ws//double',
    'ws/ws-1/brand/b/source/doc with spaces',
    `ws/ws-1/brand/b/source/doc${String.fromCharCode(0)}.txt`,
  ];

  it.each(hostile)('refuses %j', async (key) => {
    const store = new FilesystemObjectStore(root);
    const unsafe = /unsafe storage key segment/i;
    await expect(store.put(key, new Uint8Array([1]), 'text/plain')).rejects.toThrow(unsafe);
    await expect(store.get(key)).rejects.toThrow(unsafe);
    await expect(store.delete(key)).rejects.toThrow(unsafe);
  });

  it('does not read a file placed outside the root', async () => {
    const outside = path.join(root, `bs-outside-${process.pid}.txt`);
    await writeFile(outside, 'secret');
    try {
      const store = new FilesystemObjectStore(path.join(root, 'nested'));
      await expect(store.get(`../${path.basename(outside)}`)).rejects.toThrow(
        /unsafe storage key segment/i,
      );
    } finally {
      await rm(outside, { force: true });
    }
  });
});

describe('the factory picks a store that both processes can read', () => {
  it('does not hand back a process-local store outside production', () => {
    const store = createObjectStore({ appEnv: 'development', directory: root });
    expect(store).toBeInstanceOf(FilesystemObjectStore);
    expect(store).not.toBeInstanceOf(InMemoryObjectStore);
  });

  it('still refuses production, where local disk would lose every upload', () => {
    expect(() => createObjectStore({ appEnv: 'production', directory: root })).toThrow(
      /No object store is configured/,
    );
  });

  it('prefers an explicitly configured directory over the temporary default', () => {
    expect(defaultObjectStoreDirectory({ BRANDSPACE_OBJECT_STORE_DIR: '/srv/objects' })).toBe(
      '/srv/objects',
    );
    expect(defaultObjectStoreDirectory({})).toBe(path.join(os.tmpdir(), 'brandspace-objects'));
  });

  it('honours an injected store ahead of both', () => {
    const injected = new InMemoryObjectStore();
    expect(createObjectStore({ appEnv: 'production', store: injected })).toBe(injected);
  });
});
