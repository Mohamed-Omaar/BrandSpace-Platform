/**
 * The platform Secret Service.
 *
 * The envelope-encryption primitives moved to `@brandspace/vault` in Phase 6
 * (D-136) so the publish worker could encrypt customer OAuth tokens without
 * being granted the platform decrypt path. They are RE-EXPORTED here unchanged,
 * so every existing importer of this package is unaffected and the F-07 import
 * restriction on this package still means exactly what it meant.
 */
export * from '@brandspace/vault';
export * from './categories';
export * from './service';
