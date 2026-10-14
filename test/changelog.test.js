import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { checkChangelog, compareSemver, parseSemver, releaseNotes } from '../scripts/changelog.js';

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
