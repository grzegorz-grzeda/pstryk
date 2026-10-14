import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { checkChangelog, compareSemver, parseSemver, prepareRelease, releaseNotes, suggestVersion } from '../scripts/changelog.js';

describe('semver', () => {
  test('accepts valid and rejects invalid versions', () => {
    for (const v of ['0.1.0', '1.0.0', '10.20.30', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-0.3.7', '1.0.0-x.7.z.92', '1.0.0+20130313144700', '1.0.0-beta+exp.sha.5114f85']) {
      assert.ok(parseSemver(v), v);
    }
    for (const v of ['1', '1.0', 'v1.0.0', '01.0.0', '1.0.0-', '1.0.0-01', '1.0.0+', '1.0.0-alpha..1', ' 1.0.0']) {
      assert.equal(parseSemver(v), null, v);
    }
  });

  test('precedence follows the spec example (§11.4)', () => {
    const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
    for (let i = 1; i < ordered.length; i++) assert.ok(compareSemver(ordered[i - 1], ordered[i]) < 0, `${ordered[i - 1]} < ${ordered[i]}`);
    assert.ok(compareSemver('1.0.0', '2.0.0') < 0);
    assert.ok(compareSemver('2.0.0', '2.1.0') < 0);
    assert.ok(compareSemver('2.1.0', '2.1.1') < 0);
    assert.equal(compareSemver('1.0.0+build.1', '1.0.0+build.2'), 0, 'build metadata is ignored');
  });
});

const VALID = `# Changelog

## [Unreleased]

### Added

- Something new.

## [0.2.0] - 2026-11-01

### Changed

- A change.

## [0.1.0] - 2026-10-14

### Added

- First.

[Unreleased]: https://example.com/compare/v0.2.0...HEAD
[0.2.0]: https://example.com/compare/v0.1.0...v0.2.0
[0.1.0]: https://example.com/releases/tag/v0.1.0
`;

describe('changelog check', () => {
  test('a valid changelog passes', () => {
    assert.deepEqual(checkChangelog(VALID, '0.2.0'), []);
  });

  test('package.json must match the newest release', () => {
    assert.match(checkChangelog(VALID, '0.1.0').join(), /must match the newest release/);
    assert.match(checkChangelog(VALID, '0.3').join(), /not valid SemVer/);
  });

  test('catches common mistakes', () => {
    const cases = [
      [VALID.replace('## [Unreleased]', '## Unreleased'), /first section/],
      [VALID.replace('[0.2.0] - 2026-11-01', '[0.2] - 2026-11-01'), /not a valid SemVer/],
      [VALID.replace('[0.2.0] - 2026-11-01', '[0.2.0]'), /needs a date/],
      [VALID.replace('2026-11-01', '2026-13-01'), /needs a date/],
      [VALID.replace('[0.2.0] - 2026-11-01', '[0.0.9] - 2026-11-01'), /newest first/],
      [VALID.replace('### Changed', '### Improvements'), /not one of/],
      [VALID.replace('[0.1.0]: https://example.com/releases/tag/v0.1.0\n', ''), /Missing link reference "\[0.1.0\]/],
    ];
    for (const [text, expected] of cases) assert.match(checkChangelog(text).join('\n'), expected);
  });

  test('extracts release notes', () => {
    assert.equal(releaseNotes(VALID, '0.2.0'), '### Changed\n\n- A change.');
    assert.equal(releaseNotes(VALID, '9.9.9'), null);
  });

  test("the project's own changelog is valid", () => {
    const text = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.deepEqual(checkChangelog(text, version), []);
  });
});

const withUnreleased = (latest, entries) => `# Changelog

## [Unreleased]

${entries}

## [${latest}] - 2026-10-14

### Added

- First.

[Unreleased]: https://github.com/o/r/compare/v${latest}...HEAD
[${latest}]: https://github.com/o/r/releases/tag/v${latest}
`;

describe('suggest next version', () => {
  test('0.y.z: breaking bumps MINOR, everything else PATCH', () => {
    assert.equal(suggestVersion(withUnreleased('0.1.0', '### Added\n\n- New thing.')).version, '0.1.1');
    assert.equal(suggestVersion(withUnreleased('0.1.3', '### Fixed\n\n- Bug.')).version, '0.1.4');
    assert.equal(suggestVersion(withUnreleased('0.1.3', '### Changed\n\n- **Breaking:** renamed X.')).version, '0.2.0');
    assert.equal(suggestVersion(withUnreleased('0.1.3', '### Removed\n\n- Old flag.')).version, '0.2.0');
  });

  test('1.0.0 and later: MAJOR / MINOR / PATCH', () => {
    assert.equal(suggestVersion(withUnreleased('1.4.2', '### Fixed\n\n- Bug.\n\n### Security\n\n- CVE.')).version, '1.4.3');
    assert.equal(suggestVersion(withUnreleased('1.4.2', '### Added\n\n- Feature.\n\n### Fixed\n\n- Bug.')).version, '1.5.0');
    assert.equal(suggestVersion(withUnreleased('1.4.2', '### Changed\n\n- **Breaking:** new env name.')).version, '2.0.0');
  });

  test('after a pre-release, suggests its final version; nothing to release when empty', () => {
    assert.equal(suggestVersion(withUnreleased('2.0.0-rc.1', '### Fixed\n\n- Bug.')).version, '2.0.0');
    assert.equal(suggestVersion(withUnreleased('0.1.0', '')).version, null);
  });
});

describe('prepare release', () => {
  const before = withUnreleased('0.1.0', '### Added\n\n- Editable actions.');

  test('moves [Unreleased] into a dated section and updates links', () => {
    const after = prepareRelease(before, '0.1.1', '2026-10-20');
    assert.match(after, /## \[Unreleased\]\n\n## \[0\.1\.1\] - 2026-10-20\n\n### Added\n\n- Editable actions\.\n\n## \[0\.1\.0\]/);
    assert.match(after, /^\[Unreleased\]: https:\/\/github\.com\/o\/r\/compare\/v0\.1\.1\.\.\.HEAD$/m);
    assert.match(after, /^\[0\.1\.1\]: https:\/\/github\.com\/o\/r\/compare\/v0\.1\.0\.\.\.v0\.1\.1$/m);
    assert.deepEqual(checkChangelog(after, '0.1.1'), []);
    assert.equal(releaseNotes(after, '0.1.1'), '### Added\n\n- Editable actions.');
    assert.equal(suggestVersion(after).version, null, 'new [Unreleased] is empty');
  });

  test('refuses bad input', () => {
    assert.throws(() => prepareRelease(before, '0.1', '2026-10-20'), /not a valid SemVer/);
    assert.throws(() => prepareRelease(before, '0.1.0', '2026-10-20'), /already in the changelog/);
    assert.throws(() => prepareRelease(before, '0.0.9', '2026-10-20'), /must be greater/);
    assert.throws(() => prepareRelease(before, '0.1.1', '20-10-2026'), /not a valid YYYY-MM-DD/);
    assert.throws(() => prepareRelease(withUnreleased('0.1.0', ''), '0.1.1', '2026-10-20'), /nothing to release/);
  });

  test('works on the real changelog format', () => {
    const real = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
      .replace('## [Unreleased]\n', '## [Unreleased]\n\n### Fixed\n\n- Something.\n');
    const after = prepareRelease(real, '0.1.1', '2026-10-20');
    assert.deepEqual(checkChangelog(after, '0.1.1'), []);
  });
});
