import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRepoEnv } from '@brandspace/database';

const here = path.dirname(fileURLToPath(import.meta.url));

// NODE_ENV=test selects .env.test — see packages/database/src/env-file.ts.
process.env['NODE_ENV'] = 'test';
loadRepoEnv(path.resolve(here, '../..'));
