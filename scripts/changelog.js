#!/usr/bin/env node
// Changelog tooling (Keep a Changelog 1.1.0 + Semantic Versioning 2.0.0).
//
//   node scripts/changelog.js check            validate CHANGELOG.md against package.json (run in CI)
//   node scripts/changelog.js notes <version>  print the release notes for one version

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The official SemVer 2.0.0 regular expression (https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string).
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const HEADING = /^## \[([^\]]+)\](?: - (\S+))?\s*$/;
const LINK = /^\[([^\]]+)\]: (\S+)$/;
const SECTION_TYPES = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];

export function parseSemver(version) {
  const m = SEMVER.exec(version);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] ? m[4].split('.') : [], build: m[5] ?? null };
}

/** SemVer 2.0.0 precedence (§11): negative if a < b, 0 if equal, positive if a > b. Build metadata is ignored. */
export function compareSemver(a, b) {
  const x = typeof a === 'string' ? parseSemver(a) : a;
  const y = typeof b === 'string' ? parseSemver(b) : b;
  for (const key of ['major', 'minor', 'patch']) {
    if (x[key] !== y[key]) return x[key] - y[key];
  }
  // A version without pre-release identifiers has higher precedence than one with them.
  if (!x.prerelease.length || !y.prerelease.length) return y.prerelease.length - x.prerelease.length;
  for (let i = 0; i < Math.max(x.prerelease.length, y.prerelease.length); i++) {
    const p = x.prerelease[i];
    const q = y.prerelease[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pNum = /^\d+$/.test(p);
    const qNum = /^\d+$/.test(q);
    if (pNum && qNum) return Number(p) - Number(q);
    if (pNum !== qNum) return pNum ? -1 : 1; // numeric identifiers sort before alphanumeric ones
    return p < q ? -1 : 1; // ASCII order
  }
  return 0;
}

function isValidDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text);
}

export function parseChangelog(text) {
  const lines = text.split('\n');
  const releases = [];
  const links = new Map();
  let current = null;
  lines.forEach((line, index) => {
    const heading = HEADING.exec(line);
    const link = LINK.exec(line);
    if (heading) {
      current = { name: heading[1], date: heading[2] ?? null, line: index + 1, body: [] };
      releases.push(current);
    } else if (link) {
      links.set(link[1], link[2]);
      current = null;
    } else if (current) {
      current.body.push(line);
    }
  });
  for (const release of releases) release.body = release.body.join('\n').trim();
  return { releases, links };
}

/** Returns a list of problems; empty means the changelog is valid. */
export function checkChangelog(text, packageVersion) {
  const problems = [];
  const { releases, links } = parseChangelog(text);

  if (releases[0]?.name !== 'Unreleased') problems.push('The first section must be "## [Unreleased]"');
  const versions = releases.filter((r) => r.name !== 'Unreleased');
  if (releases.filter((r) => r.name === 'Unreleased').length > 1) problems.push('Only one [Unreleased] section is allowed');

  const seen = new Set();
  versions.forEach((release, i) => {
    const where = `line ${release.line}`;
    if (!parseSemver(release.name)) problems.push(`${where}: "${release.name}" is not a valid SemVer 2.0.0 version`);
    if (!release.date || !isValidDate(release.date)) problems.push(`${where}: release ${release.name} needs a date as " - YYYY-MM-DD"`);
    if (seen.has(release.name)) problems.push(`${where}: version ${release.name} appears twice`);
    seen.add(release.name);
    const previous = versions[i - 1];
    if (previous && parseSemver(previous.name) && parseSemver(release.name) && compareSemver(previous.name, release.name) <= 0) {
      problems.push(`${where}: versions must be listed newest first (${previous.name} is above ${release.name})`);
    }
    if (previous?.date && release.date && previous.date < release.date) {
      problems.push(`${where}: ${release.name} is dated after the newer ${previous.name}`);
    }
    for (const match of release.body.matchAll(/^### (.+)$/gm)) {
      if (!SECTION_TYPES.includes(match[1].trim())) {
        problems.push(`${where}: "### ${match[1]}" is not one of ${SECTION_TYPES.join(', ')}`);
      }
    }
    if (!release.body) problems.push(`${where}: release ${release.name} has no entries`);
  });

  for (const release of releases) {
    if (!links.has(release.name)) problems.push(`Missing link reference "[${release.name}]: …" at the bottom`);
  }

  if (packageVersion !== undefined) {
    if (!parseSemver(packageVersion)) problems.push(`package.json version "${packageVersion}" is not valid SemVer 2.0.0`);
    else if (versions[0]?.name !== packageVersion) {
      problems.push(`package.json version ${packageVersion} must match the newest release in the changelog (${versions[0]?.name ?? 'none'})`);
    }
  }
  return problems;
}

export function releaseNotes(text, version) {
  const release = parseChangelog(text).releases.find((r) => r.name === version);
  return release ? release.body : null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = new URL('../', import.meta.url);
  const changelog = readFileSync(new URL('CHANGELOG.md', root), 'utf8');
  const { version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  const [command, arg] = process.argv.slice(2);

  if (command === 'check') {
    const problems = checkChangelog(changelog, version);
    if (problems.length) {
      console.error(`CHANGELOG.md has ${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`);
      process.exit(1);
    }
    console.log(`CHANGELOG.md OK (current version ${version})`);
  } else if (command === 'notes' && arg) {
    const notes = releaseNotes(changelog, arg.replace(/^v/, ''));
    if (notes === null) {
      console.error(`No section for version ${arg} in CHANGELOG.md`);
      process.exit(1);
    }
    console.log(notes);
  } else {
    console.error('Usage: node scripts/changelog.js check | notes <version>');
    process.exit(2);
  }
}
