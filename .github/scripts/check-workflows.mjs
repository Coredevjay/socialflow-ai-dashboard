#!/usr/bin/env node
/**
 * Workflow policy checks — run locally or in CI.
 *
 * Checks:
 *  1. Branch trigger consistency: every workflow that reacts to push/PR must
 *     include the canonical default branch (whichever appears most often).
 *  2. Secret safety: any step that references a secret must either be guarded
 *     by an if: condition on the job or step, or be in the optional allowlist.
 */

import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Inline minimal YAML scalar/mapping parser sufficient for workflow files.
// We use js-yaml if available, otherwise fall back to a require-based load.
let parseYaml;
try {
  const { load } = await import('js-yaml');
  parseYaml = load;
} catch {
  // js-yaml not available — use a best-effort JSON-via-python fallback
  const { execSync } = await import('child_process');
  parseYaml = (src) =>
    JSON.parse(execSync('python3 -c "import sys,yaml,json; print(json.dumps(yaml.safe_load(sys.stdin.read())))"',
      { input: src, encoding: 'utf8' }));
}

const WORKFLOWS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../workflows');

// Secrets that are intentionally optional (callers may fail gracefully without them)
const OPTIONAL_SECRETS = new Set(['SNYK_TOKEN', 'SLACK_WEBHOOK_URL', 'K6_AUTH_TOKEN']);

const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

const workflows = files.map((f) => {
  const src = readFileSync(join(WORKFLOWS_DIR, f), 'utf8');
  return { file: f, doc: parseYaml(src) };
});

let failures = 0;
const fail = (msg) => { console.error(`  ✗ ${msg}`); failures++; };
const ok   = (msg) => console.log(`  ✓ ${msg}`);

// ── 1. Branch trigger consistency ────────────────────────────────────────────
console.log('\n[1] Branch trigger consistency');

const branchSets = workflows.flatMap(({ file, doc }) => {
  // YAML parsers may surface bare `on:` as the boolean key `true`
  const on = doc?.on ?? doc?.[true];
  if (!on || typeof on !== 'object') return [];
  const branches = [
    ...(on?.push?.branches  ?? []),
    ...(on?.pull_request?.branches ?? []),
  ];
  return branches.length ? [{ file, branches: [...new Set(branches)] }] : [];
});

// Tally branch names to find the canonical default branch
const tally = {};
for (const { branches } of branchSets)
  for (const b of branches) tally[b] = (tally[b] ?? 0) + 1;

const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
console.log(`  Branch frequency: ${ranked.map(([b, n]) => `${b}(${n})`).join(', ')}`);

const topBranch = ranked[0]?.[0];
if (!topBranch) {
  ok('No branch-scoped triggers found — nothing to check.');
} else {
  for (const { file, branches } of branchSets) {
    if (branches.includes(topBranch)) {
      ok(`${file}: includes canonical branch "${topBranch}"`);
    } else {
      fail(`${file}: missing canonical branch "${topBranch}" (has: ${branches.join(', ')})`);
    }
  }
}

// ── 2. Secret safety ─────────────────────────────────────────────────────────
console.log('\n[2] Secret safety — unguarded required secrets');

for (const { file, doc } of workflows) {
  for (const [jobId, job] of Object.entries(doc?.jobs ?? {})) {
    const jobGuarded = Boolean(job?.if);
    for (const step of job?.steps ?? []) {
      const guarded = jobGuarded || Boolean(step?.if);
      const refs = [...JSON.stringify(step).matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]);
      for (const secret of refs) {
        const label = `${file} / ${jobId} / "${step.name ?? step.uses ?? 'step'}"`;
        if (OPTIONAL_SECRETS.has(secret)) {
          ok(`${label}: ${secret} is in optional allowlist`);
        } else if (guarded) {
          ok(`${label}: ${secret} is guarded by if:`);
        } else {
          fail(`${label}: ${secret} used without if: guard — add to OPTIONAL_SECRETS or guard the step`);
        }
      }
    }
  }
}

// ── Result ────────────────────────────────────────────────────────────────────
console.log('');
if (failures > 0) {
  console.error(`${failures} policy check(s) failed.`);
  process.exit(1);
} else {
  console.log('All workflow policy checks passed.');
}
