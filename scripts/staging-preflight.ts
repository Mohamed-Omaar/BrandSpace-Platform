/**
 * STAGING PREFLIGHT — Phase 5.
 *
 * WHAT IT IS FOR. Bringing up a new Railway environment means pasting several
 * dozen variables across five services, and the failure mode is not a crash: it
 * is a service that starts and is subtly wrong. Phase 5's own audit found two
 * such cases before a single variable was typed — staging demanding a production
 * KMS key, and staging forbidden the loopback billing secret its sandbox billing
 * needs — so this exists to answer, BEFORE a deploy is called ready, the one
 * question an operator cannot answer by reading a dashboard: does each service
 * hold exactly what it should, and nothing it should not?
 *
 * IT IS THE SAME CONTRACT THE PROCESSES THEMSELVES ENFORCE. Every check below
 * runs `validateStartupConfiguration`, the function each service calls on the way
 * up. This is deliberately not a second list that could drift from the first: a
 * preflight that agreed with a document rather than with the code would be a
 * report about a contract nothing enforces.
 *
 * IT NEEDS NO PRODUCTION SECRET, and holds none. It reads a candidate staging
 * environment from a file or from the current process and reports STATUS BY
 * NAME. No value is ever printed, compared against a production value, or
 * written anywhere — there is nothing here for a screenshot of the output to
 * leak.
 *
 * Usage:
 *
 *     pnpm staging:preflight                      # read the current environment
 *     pnpm staging:preflight --env-file staging.env
 *     pnpm staging:preflight --service dashboard  # one service only
 *
 * The exit code is 0 when every service is ready and 1 when any is not, so it
 * can gate a bootstrap script as well as a person.
 */
import { readFileSync } from 'node:fs';
import {
  currentEnvironment,
  validateStartupConfiguration,
  type StartupServiceProfile,
} from '@brandspace/shared';

/** The five services a Railway environment runs, and the profile each uses. */
const SERVICES: readonly StartupServiceProfile[] = ['web', 'dashboard', 'admin', 'api', 'worker'];

/**
 * Variables each service reads that `validateStartupConfiguration` does not
 * require, and which an operator still wants to see the state of.
 *
 * REPORTED, NOT ENFORCED, and the distinction is the point. Object storage is
 * optional in the schema and required by `createObjectStore` at the moment a
 * customer's file is stored (packages/storage/src/factory.ts), so a staging
 * deploy without it is not invalid — it is a deploy where uploads will fail.
 * Saying so plainly is more useful than either ignoring it or refusing to start.
 */
const ADVISORY: Partial<Record<StartupServiceProfile, readonly AdvisoryCheck[]>> = {
  dashboard: [
    { label: 'object storage', names: STORAGE_NAMES(), consequence: 'uploads will fail' },
    { label: 'redis', names: ['REDIS_URL'], consequence: 'queued work runs inline' },
    {
      label: 'internal service token',
      names: ['INTERNAL_SERVICE_TOKEN'],
      consequence: 'email cannot be delegated to the API',
    },
  ],
  api: [
    { label: 'object storage', names: STORAGE_NAMES(), consequence: 'uploads will fail' },
    { label: 'redis', names: ['REDIS_URL'], consequence: 'queued work runs inline' },
    {
      label: 'sandbox billing',
      names: ['BILLING_DEV_WEBHOOK_SECRET'],
      consequence: 'the development payment adapter cannot verify its own events',
    },
  ],
  worker: [
    { label: 'object storage', names: STORAGE_NAMES(), consequence: 'media processing will fail' },
    { label: 'redis', names: ['REDIS_URL'], consequence: 'the worker consumes nothing' },
  ],
  admin: [{ label: 'redis', names: ['REDIS_URL'], consequence: 'queued work runs inline' }],
};

interface AdvisoryCheck {
  readonly label: string;
  readonly names: readonly string[];
  readonly consequence: string;
}

function STORAGE_NAMES(): readonly string[] {
  return [
    'STORAGE_ENDPOINT',
    'STORAGE_BUCKET',
    'STORAGE_ACCESS_KEY_ID',
    'STORAGE_SECRET_ACCESS_KEY',
  ];
}

/**
 * Values that are obviously not real.
 *
 * The schema already refuses a placeholder in anything whose NAME looks like a
 * secret. This widens the net to the variables that carry no such word — a
 * bucket called `REPLACE_WITH_BUCKET` passes every existing rule and fails at
 * the first upload.
 */
const PLACEHOLDER_MARKERS = [
  'replace_with',
  'change-me',
  'changeme',
  'placeholder',
  'example.com',
  'your-',
  'todo',
  'xxx',
];

function looksLikePlaceholder(value: string): boolean {
  const lowered = value.toLowerCase();
  return PLACEHOLDER_MARKERS.some((marker) => lowered.includes(marker));
}

/** Parse a `KEY=value` file. Values are never echoed, only their keys are used. */
function readEnvFile(path: string): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env as NodeJS.ProcessEnv;
}

interface Line {
  readonly label: string;
  readonly status: 'ok' | 'not permitted' | 'missing' | 'unavailable' | 'warning';
  readonly detail?: string;
}

interface ServiceReport {
  readonly service: StartupServiceProfile;
  readonly ready: boolean;
  readonly lines: readonly Line[];
}

function reportFor(service: StartupServiceProfile, env: NodeJS.ProcessEnv): ServiceReport {
  const lines: Line[] = [];
  let ready = true;

  /*
   * THE INVARIANT THAT DEFINES A STAGING DEPLOYMENT (D-97). A Railway staging
   * build sets `NODE_ENV=production` — every built Next.js app does — so
   * `APP_ENV` is the only thing distinguishing the two. If this is wrong, every
   * production guard fires against staging, or worse, none of them does.
   */
  const deployment = currentEnvironment(env as Record<string, string | undefined>);
  if (deployment === 'STAGING') {
    lines.push({ label: 'APP_ENV', status: 'ok', detail: 'staging' });
  } else {
    ready = false;
    lines.push({
      label: 'APP_ENV',
      status: 'warning',
      detail: `resolves to ${deployment} — staging must set APP_ENV=staging`,
    });
  }

  if (env['NODE_ENV'] === 'production') {
    lines.push({ label: 'NODE_ENV', status: 'ok', detail: 'production (a staging BUILD)' });
  } else {
    lines.push({
      label: 'NODE_ENV',
      status: 'warning',
      detail: 'Railway builds set production; anything else is not what will deploy',
    });
  }

  /*
   * The real contract, asked of the same function the service itself calls.
   *
   * IT THROWS RATHER THAN REPORTING WHEN IT BELIEVES IT IS PRODUCTION — that is
   * `validateStartupConfiguration`'s contract, and correct for a booting
   * process, which must not come up half-configured. A PREFLIGHT is not a
   * booting process: its whole job is to describe what is wrong. Unhandled, the
   * throw printed a Node stack trace over the report, which is both useless to
   * an operator and a needless disclosure of paths. So the throw becomes a line.
   */
  let problems: readonly string[];
  try {
    const result = validateStartupConfiguration(env, service);
    problems = result.problems;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'invalid configuration';
    problems = message.split('\n').filter((line) => line.trim() !== '');
  }

  if (problems.length === 0) {
    lines.push({ label: 'startup contract', status: 'ok' });
  } else {
    ready = false;
    for (const problem of problems) {
      // A variable this service must NOT hold reads differently from one it is
      // missing, and an operator fixes them in opposite directions.
      const text = problem.trim();
      const status = /must not be present/.test(text) ? 'not permitted' : 'missing';
      lines.push({ label: 'startup contract', status, detail: text });
    }
  }

  for (const check of ADVISORY[service] ?? []) {
    const absent = check.names.filter((name) => (env[name] ?? '').trim() === '');
    const placeholders = check.names.filter((name) => {
      const value = (env[name] ?? '').trim();
      return value !== '' && looksLikePlaceholder(value);
    });

    if (placeholders.length > 0) {
      ready = false;
      lines.push({
        label: check.label,
        status: 'warning',
        detail: `${placeholders.join(', ')} still holds a template value`,
      });
    } else if (absent.length === 0) {
      lines.push({ label: check.label, status: 'ok' });
    } else if (absent.length === check.names.length) {
      lines.push({
        label: check.label,
        status: 'unavailable',
        detail: `not configured — ${check.consequence}`,
      });
    } else {
      /*
       * PARTIAL IS WORSE THAN ABSENT, so it is a failure rather than a note. Half
       * a storage contract is a service that believes it can store and cannot.
       */
      ready = false;
      lines.push({
        label: check.label,
        status: 'warning',
        detail: `partially configured — missing ${absent.join(', ')}`,
      });
    }
  }

  return { service, ready, lines };
}

function main(): void {
  const argv = process.argv.slice(2);
  const fileIndex = argv.indexOf('--env-file');
  const serviceIndex = argv.indexOf('--service');

  const dirIndex = argv.indexOf('--env-dir');
  const only = serviceIndex >= 0 ? (argv[serviceIndex + 1] as StartupServiceProfile) : undefined;

  if (only && !SERVICES.includes(only)) {
    console.error(`Unknown service "${only}". One of: ${SERVICES.join(', ')}`);
    process.exit(2);
  }

  /*
   * RAILWAY KEEPS VARIABLES PER SERVICE, so "one file" means one service. A
   * single combined file checked against all five would report every service as
   * holding variables it must not — which is the contract working, and a
   * useless thing to print. So a file needs a service, and `--env-dir` is the
   * shape a real bootstrap has: `<dir>/dashboard.env`, `<dir>/api.env`, …
   */
  if (fileIndex >= 0 && only === undefined) {
    console.error(
      "A single --env-file holds ONE service's variables, because Railway keeps them per\n" +
        'service. Pass --service <name> with it, or use --env-dir <dir> containing\n' +
        `${SERVICES.map((s) => `<dir>/${s}.env`).join(', ')}.`,
    );
    process.exit(2);
  }

  const services = only ? [only] : SERVICES;
  const envFor = (service: StartupServiceProfile): NodeJS.ProcessEnv => {
    if (dirIndex >= 0) return readEnvFile(`${argv[dirIndex + 1]!}/${service}.env`);
    if (fileIndex >= 0) return readEnvFile(argv[fileIndex + 1]!);
    return process.env;
  };

  console.log('BrandSpace staging preflight');
  console.log('No value is ever printed — only variable names and their status.\n');

  const reports = services.map((service) => reportFor(service, envFor(service)));

  for (const report of reports) {
    console.log(report.service);
    for (const line of report.lines) {
      const detail = line.detail ? ` — ${line.detail}` : '';
      console.log(`  ${line.label}: ${line.status}${detail}`);
    }
    console.log('');
  }

  const notReady = reports.filter((report) => !report.ready);
  if (notReady.length === 0) {
    console.log('✔ every service is ready for a staging deploy.');
    process.exit(0);
  }

  console.log(`✖ not ready: ${notReady.map((report) => report.service).join(', ')}`);
  console.log('  Fix the lines above, then run this again. Nothing was deployed or changed.');
  process.exit(1);
}

main();
