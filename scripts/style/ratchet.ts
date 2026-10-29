/**
 * `pnpm style:ratchet` prints the hard-coded style counts against the baseline.
 * `pnpm style:ratchet --write` lowers the baseline to the current counts. It
 * refuses to RAISE any count: a baseline only ever goes down (see measure.ts).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { measure, regressions, totals, type Counts } from './measure';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASELINE = path.join(ROOT, 'scripts/style/baseline.json');

interface Baseline {
  readonly css: Counts;
  readonly ts: Counts;
}

function readBaseline(): Baseline | undefined {
  try {
    return JSON.parse(readFileSync(BASELINE, 'utf8')) as Baseline;
  } catch {
    return undefined;
  }
}

function sorted(counts: Counts): Counts {
  return Object.fromEntries(
    Object.keys(counts)
      .sort()
      .map((file) => [
        file,
        Object.fromEntries(Object.entries(counts[file]!).sort(([a], [b]) => a.localeCompare(b))),
      ]),
  );
}

async function main(): Promise<void> {
  const current = await measure(ROOT);
  const baseline = readBaseline();
  const write = process.argv.includes('--write');
  const init = process.argv.includes('--init');

  console.log('CSS totals', totals(current.css));
  console.log('TS totals ', totals(current.ts));

  if (baseline) {
    const up = [...regressions(current.css, baseline.css), ...regressions(current.ts, baseline.ts)];
    if (up.length > 0) {
      console.error(`Counts went UP:\n  ${up.join('\n  ')}`);
      process.exitCode = 1;
      return;
    }
    console.log('Baseline CSS', totals(baseline.css));
    console.log('Baseline TS ', totals(baseline.ts));
  }

  if (write || init) {
    if (!baseline && !init) {
      console.error('No baseline yet: run with --init once.');
      process.exitCode = 1;
      return;
    }
    writeFileSync(
      BASELINE,
      `${JSON.stringify({ css: sorted(current.css), ts: sorted(current.ts) }, null, 2)}\n`,
    );
    console.log(`Wrote ${path.relative(ROOT, BASELINE)}`);
  }
}

void main();
