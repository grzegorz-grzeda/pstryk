#!/usr/bin/env node
// Changelog tooling (Keep a Changelog 1.1.0 + Semantic Versioning 2.0.0).
//
//   node scripts/changelog.js check              validate CHANGELOG.md against package.json (run in CI)
//   node scripts/changelog.js notes <version>    print the release notes for one version
//   node scripts/changelog.js suggest            propose the next version from the [Unreleased] entries
//   node scripts/changelog.js release <version> [--date YYYY-MM-DD]
//                                                turn [Unreleased] into a dated release section (edits the file)

import { readFileSync, writeFileSync } from 'node:fs';
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

/**
 * Proposes the next version from the [Unreleased] entries (policy: docs/releasing.md).
 * Breaking = a "### Removed" group or an entry marked **Breaking:**.
 *   0.y.z:  breaking → 0.(y+1).0, anything else → 0.y.(z+1)
 *   ≥1.0.0: breaking → major, Added/Changed/Deprecated → minor, Fixed/Security only → patch
 */
export function suggestVersion(text) {
  const { releases } = parseChangelog(text);
  const unreleased = releases.find((r) => r.name === 'Unreleased');
  if (!unreleased?.body) return { version: null, reason: '[Unreleased] has no entries, so there is nothing to release' };
  const latest = releases.find((r) => r.name !== 'Unreleased' && parseSemver(r.name));
  const groups = new Set([...unreleased.body.matchAll(/^### (.+)$/gm)].map((m) => m[1].trim()));
  const breaking = groups.has('Removed') || /\*\*Breaking:?\*\*/i.test(unreleased.body);
  const features = ['Added', 'Changed', 'Deprecated'].some((g) => groups.has(g));
  if (!latest) return { version: '0.1.0', reason: 'first release' };
  const v = parseSemver(latest.name);
  if (v.prerelease.length) {
    return { version: `${v.major}.${v.minor}.${v.patch}`, reason: `${latest.name} is a pre-release; the natural next step is its final version (or another pre-release)` };
  }
  if (v.major === 0) {
    return breaking
      ? { version: `0.${v.minor + 1}.0`, reason: 'breaking change during 0.y.z: bump MINOR' }
      : { version: `0.${v.minor}.${v.patch + 1}`, reason: 'no breaking change during 0.y.z: bump PATCH' };
  }
  if (breaking) return { version: `${v.major + 1}.0.0`, reason: 'breaking change: bump MAJOR' };
  if (features) return { version: `${v.major}.${v.minor + 1}.0`, reason: 'new or changed behaviour: bump MINOR' };
  return { version: `${v.major}.${v.minor}.${v.patch + 1}`, reason: 'fixes only: bump PATCH' };
}

/**
 * Returns the changelog text with [Unreleased] released as `version` on `date`, a new empty
 * [Unreleased] section above it, and the link references updated. Throws on invalid input.
 */
export function prepareRelease(text, version, date) {
  if (!parseSemver(version)) throw new Error(`"${version}" is not a valid SemVer 2.0.0 version`);
  if (!isValidDate(date)) throw new Error(`"${date}" is not a valid YYYY-MM-DD date`);
  const { releases } = parseChangelog(text);
  const unreleased = releases.find((r) => r.name === 'Unreleased');
  if (!unreleased) throw new Error('No ## [Unreleased] section');
  if (!unreleased.body) throw new Error('[Unreleased] has no entries, so there is nothing to release');
  if (releases.some((r) => r.name === version)) throw new Error(`Version ${version} is already in the changelog`);
  const latest = releases.find((r) => r.name !== 'Unreleased');
  if (latest && compareSemver(version, latest.name) <= 0) throw new Error(`${version} must be greater than the latest release ${latest.name}`);

  const lines = text.split('\n');
  const headingIndex = lines.findIndex((l) => /^## \[Unreleased\]\s*$/.test(l));
  lines.splice(headingIndex + 1, 0, '', `## [${version}] - ${date}`);

  const linkIndex = lines.findIndex((l) => /^\[Unreleased\]: /.test(l));
  if (linkIndex === -1) throw new Error('No "[Unreleased]: …" link reference at the bottom');
  const link = /^\[Unreleased\]: (\S+?)\/compare\/v(\S+)\.\.\.HEAD$/.exec(lines[linkIndex]);
  if (!link) throw new Error('The [Unreleased] link must look like "[Unreleased]: <repo>/compare/v<latest>...HEAD"');
  const [, repo, previous] = link;
  lines.splice(
    linkIndex,
    1,
    `[Unreleased]: ${repo}/compare/v${version}...HEAD`,
    `[${version}]: ${repo}/compare/v${previous}...v${version}`,
  );
  return lines.join('\n');
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
  } else if (command === 'suggest') {
    const { version: next, reason } = suggestVersion(changelog);
    if (!next) {
      console.error(reason);
      process.exit(1);
    }
    console.log(`${next}\t(${reason})`);
  } else if (command === 'release' && arg) {
    const dateFlag = process.argv.indexOf('--date');
    const date = dateFlag > -1 ? process.argv[dateFlag + 1] : new Date().toISOString().slice(0, 10);
    try {
      writeFileSync(new URL('CHANGELOG.md', root), prepareRelease(changelog, arg.replace(/^v/, ''), date));
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    console.log(`CHANGELOG.md: released ${arg.replace(/^v/, '')} dated ${date}. Now set package.json: npm version ${arg.replace(/^v/, '')} --no-git-tag-version`);
  } else {
    console.error('Usage: node scripts/changelog.js check | notes <version> | suggest | release <version> [--date YYYY-MM-DD]');
    process.exit(2);
  }
}
