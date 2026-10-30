import 'server-only';
import { randomUUID } from 'node:crypto';
import { AppError, detectFormat } from '@brandspace/shared';
import { createObjectStore, type ObjectStore } from '@brandspace/storage';
import { currentEnvironment, getConfigService } from './platform-context';

/**
 * THE LOOK & FEEL IMAGES (LF): the logos for light and dark surfaces, the
 * small mark and the favicon. The existing image rules apply — the types the
 * `assets` configuration allows for images and its size ceiling — and the
 * bytes must BE a PNG, JPEG or WebP by their signature, whatever the file
 * says it is. SVG is never accepted here: it is a script-bearing document
 * (the same reason the asset rules give).
 */
export const LOGO_SLOTS = ['light', 'dark', 'mark', 'favicon'] as const;
export type LogoSlot = (typeof LOGO_SLOTS)[number];

const SERVABLE = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' } as const;

let store: ObjectStore | null = null;
export function logoStore(): ObjectStore {
  store ??= createObjectStore({ appEnv: process.env['APP_ENV'] ?? 'development' });
  return store;
}

/** Check an uploaded image against the rules and store it; returns its key. */
export async function storeLogo(slot: LogoSlot, file: File): Promise<string> {
  const assets = await getConfigService().get('assets', currentEnvironment());
  const allowed = new Set(assets.upload.allowedMimeTypes.image);
  const ceiling = assets.upload.maxFileBytes.image;
  if (file.size <= 0 || file.size > ceiling) throw new AppError('VALIDATION_FAILED', 'LOGO');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const format = detectFormat(bytes);
  const type = format in SERVABLE ? SERVABLE[format as keyof typeof SERVABLE] : null;
  if (!type || !allowed.has(type)) throw new AppError('VALIDATION_FAILED', 'LOGO');
  const key = `platform/theme/${slot}-${randomUUID()}.${format}`;
  await logoStore().put(key, bytes, type);
  return key;
}

/** The bytes and type of a stored theme image, re-checked; null when unusable. */
export async function readLogo(key: string): Promise<{ bytes: Uint8Array; type: string } | null> {
  const bytes = await logoStore()
    .get(key)
    .catch(() => null);
  if (!bytes) return null;
  const format = detectFormat(bytes);
  return format in SERVABLE ? { bytes, type: SERVABLE[format as keyof typeof SERVABLE] } : null;
}
