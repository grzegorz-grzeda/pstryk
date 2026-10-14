# Versioning and releases

Pstryk follows [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html) and keeps a
[changelog](../CHANGELOG.md) in the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## What the version number means

`MAJOR.MINOR.PATCH`, optionally with a pre-release suffix such as `1.2.0-rc.1`.

The **public API** that the version promises to keep stable is:

- the webhook endpoint `/h/<name>`: authentication, request formats, status codes and response bodies
- template syntax and behaviour in topics and payloads
- configuration (environment variables) and the stored data in MongoDB (upgrades must not lose data)
- the recovery CLI's commands

The admin UI's look and URLs are not part of it.

| Change | Bump | Examples |
|---|---|---|
| Breaks something callers or operators rely on | **MAJOR** | rename an env variable, change a status code, change template semantics, data migration that can't be rolled back |
| New, backwards-compatible capability | **MINOR** | new action type, new placeholder, new optional setting, new admin page |
| Backwards-compatible fix | **PATCH** | bug fix, security fix with no behaviour change for valid use, docs, dependency updates |

**While the version is `0.y.z`** (initial development), anything may change. Breaking changes bump
**MINOR** (0.1.0 → 0.2.0), everything else bumps **PATCH**. Release **1.0.0** once Pstryk runs in
production and the API above is considered stable.

## Day to day: keep the changelog current

Every pull request that changes behaviour adds a line under `## [Unreleased]` in `CHANGELOG.md`, in one of
these groups: **Added**, **Changed**, **Deprecated**, **Removed**, **Fixed**, **Security**.

- Write for the people running Pstryk or calling its webhooks, not about code internals.
- Mark breaking changes with **Breaking:** at the start of the entry, and say what to do.
- Refactors, test-only changes and CI tweaks don't need an entry.

`npm run changelog:check` (also run in CI) validates the file: valid SemVer versions, newest first,
dates, allowed group names, link references, and `package.json` matching the newest release.

## Cutting a release

1. Decide the version from the `[Unreleased]` entries, using the table above.
2. On a branch, edit `CHANGELOG.md`:
   - Rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD` (today, UTC) and add a fresh empty
     `## [Unreleased]` above it.
   - Update the links at the bottom:

     ```
     [Unreleased]: https://github.com/grzegorz-grzeda/pstryk/compare/vX.Y.Z...HEAD
     [X.Y.Z]: https://github.com/grzegorz-grzeda/pstryk/compare/vPREVIOUS...vX.Y.Z
     ```
3. Set the version in `package.json` and `package-lock.json` with `npm version X.Y.Z --no-git-tag-version`.
4. Run `npm run changelog:check && npm test`, open a pull request titled "Release X.Y.Z", and merge it.
5. Tag the merge commit on `main` and push the tag:

   ```sh
   git checkout main && git pull
   git tag -a vX.Y.Z -m "Release X.Y.Z"
   git push origin vX.Y.Z
   ```

The tag triggers CI, which:

- checks the tag matches `package.json`
- runs the tests
- publishes the Docker image as `ghcr.io/grzegorz-grzeda/pstryk:X.Y.Z` and `:X.Y`
- creates a GitHub Release whose notes are that version's changelog section; versions with a
  pre-release suffix are marked as pre-releases

Deployment to the VPS is driven by `main`, not by tags, so the release is already running by the time
you tag it.

The running version appears in the admin footer and at startup in the log, and
`node src/cli.js --version` prints it.

## Hotfixes

Fix on a branch from `main`, add a **Fixed** or **Security** entry, and release as a PATCH (`X.Y.Z+1`)
following the same steps. There are no long-lived release branches.
