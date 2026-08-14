#!/usr/bin/env node
/**
 * Reads the commit message from COMMIT_MSG and bumps package.json (+ lockfile).
 *
 * Convention: `type(scope): subject` where scope is the bump level:
 *   feat(major): ...  -> major bump (0.0.1 -> 1.0.0)
 *   feat(minor): ...  -> minor bump (0.0.1 -> 0.1.0)
 *   feat: ...         -> patch bump (0.0.1 -> 0.0.2)  [no scope]
 *   feat(release): ... -> release current version, no bump (v0.0.1 -> v0.0.1)
 *   feat(none): ...   -> no bump, no release
 * Only code-change types (feat, fix) trigger a release. Non-code types
 * (docs, chore, test, refactor, ...) never do, unless scope is `release`
 * (explicit release of the current version).
 * Unknown scope or non-conventional commit -> no bump, no release.
 *
 * Prints GitHub Actions outputs (key=value):
 *   bumped=true|false
 *   version=<new version>   (only when bumped)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pkgPath = resolve(repoRoot, 'package.json');
const lockPath = resolve(repoRoot, 'package-lock.json');

// Only these commit types trigger a release (code changes).
const RELEASE_TYPES = new Set(['feat', 'fix']);

const subject = (process.env.COMMIT_MSG || '').split('\n')[0].trim();
const match = /^([a-zA-Z]+)(?:\(([^)]*)\))?:\s/.exec(subject);

let bump = null; // null -> skip release
if (match) {
  const type = match[1].toLowerCase();
  const scope = (match[2] ?? '').toLowerCase();
  const isReleaseType = RELEASE_TYPES.has(type);
  if (scope === 'none') {
    bump = null;
  } else if (scope === 'major' || scope === 'minor') {
    // scope alone never releases: docs(major) is still a docs commit
    bump = isReleaseType ? scope : null;
  } else if (scope === 'release') {
    // explicit request: release current version, regardless of type
    bump = 'release';
  } else if (isReleaseType) {
    // feat:/fix: without scope -> patch
    bump = 'patch';
  }
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

if (!bump) {
  console.log('bumped=false');
  process.exit(0);
}

if (bump === 'release') {
  console.log('bumped=true');
  console.log(`version=${pkg.version}`);
  process.exit(0);
}

const [major, minor, patch] = pkg.version.split('.').map(Number);
if ([major, minor, patch].some((n) => Number.isNaN(n))) {
  throw new Error(`Cannot parse version: ${pkg.version}`);
}
const next =
  bump === 'major' ? `${major + 1}.0.0`
  : bump === 'minor' ? `${major}.${minor + 1}.0`
  : `${major}.${minor}.${patch + 1}`;

pkg.version = next;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

if (existsSync(lockPath)) {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  if (lock.version) lock.version = next;
  if (lock.packages?.['']?.version) lock.packages[''].version = next;
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
}

console.log('bumped=true');
console.log(`version=${next}`);
