---
name: release
description: Cut a Semantic Versioning release of Pstryk - choose the version from CHANGELOG.md, prepare the release PR (changelog + package.json), and after it is merged tag main and verify the CI release (GitHub Release + ghcr.io image). Use when the user asks to release, ship, publish, tag or "cut" a version (e.g. "release 0.2.0", "do a release", "make a patch release", "publish v1.0.0-rc.1").
---

# Releasing Pstryk

Policy lives in `docs/releasing.md` (read it if anything below is unclear); this skill is the procedure.
Releases follow SemVer 2.0.0 and Keep a Changelog. A release is: **release PR → merge → tag `vX.Y.Z` on
main → CI publishes**. CI (on the tag) checks tag == package.json, runs the tests, pushes the image
`ghcr.io/grzegorz-grzeda/pstryk:X.Y.Z` and `:X.Y`, and creates the GitHub Release from the changelog section.

Constants: repo `grzegorz-grzeda/pstryk`, default branch `main`, tags `vX.Y.Z`.

## Guardrails

- **Never reuse, move or delete a pushed version tag**, and never edit a published release's version.
  If something is wrong after the tag is out, fix forward with the next PATCH (or a new pre-release).
- Two points need the user's explicit OK: **the version number** (step 2; skip if the user already
  named it) and **pushing the tag** (step 6; it publishes). Everything else, just do.
- Release PRs contain only the changelog cut and the version bump. No code changes.
- GitHub GraphQL is unavailable in cloud sessions: `gh pr create` / `gh repo view` fail. Use REST via
  `gh api repos/grzegorz-grzeda/pstryk/...`.
- The clone may be shallow and track only some branches. Fetch what you need explicitly.

## 1. Preflight

```sh
git fetch origin main --tags
git status --porcelain                      # must be empty; stop and ask if not
git ls-remote --tags origin 'v*'            # existing version tags
node -p "require('./package.json').version"
npm run changelog:check
gh api "repos/grzegorz-grzeda/pstryk/actions/runs?branch=main&event=push&per_page=1" \
  --jq '.workflow_runs[0] | {status, conclusion, sha: .head_sha[0:7]}'
```

- CI on `main` must be `completed` / `success` for the commit you will release. If it isn't, report
  it and stop.
- **Already prepared?** If `package.json`'s version has **no** `v<version>` tag yet and it is the newest
  release in `CHANGELOG.md` (e.g. the first release, 0.1.0), the release PR is effectively done:
  confirm with the user and jump to step 5.

## 2. Choose the version

```sh
node scripts/changelog.js suggest            # prints "<version>\t(<reason>)", or fails if [Unreleased] is empty
```

- An empty `[Unreleased]` means there is nothing to release. Say so and stop. Don't invent entries.
- Show the user the `[Unreleased]` entries and the suggestion with its reason, and ask them to confirm
  or pick another version. Pre-releases use `X.Y.Z-rc.N` (or `-beta.N`).
- Sanity-check the entries against `git log v<previous>..origin/main --oneline`. If merged
  behaviour changes are missing from the changelog, point them out and offer to add entries first
  (in the release PR is fine).
- During `0.y.z`, breaking changes bump MINOR and everything else bumps PATCH. Suggest **1.0.0** only
  if the user says Pstryk is in production and the API should now be stable.

## 3. Prepare the release branch

```sh
git checkout -b release/X.Y.Z origin/main
node scripts/changelog.js release X.Y.Z      # cuts [Unreleased] → [X.Y.Z] - <today UTC>, updates links
npm version X.Y.Z --no-git-tag-version       # package.json + package-lock.json
npm run changelog:check && npm run lint && npm test
git diff --stat                              # expect exactly: CHANGELOG.md, package.json, package-lock.json
```

Read the new `## [X.Y.Z]` section once more as release notes: user-facing wording, breaking changes
marked **Breaking:** with what to do. Polish wording if needed, but don't change the meaning.

Commit with the message `Release X.Y.Z` (plus the attribution lines from the session's instructions)
and push with `git push -u origin release/X.Y.Z`.

## 4. Open the release PR

```sh
node scripts/changelog.js notes X.Y.Z > /tmp/notes.md   # or the scratchpad
gh api repos/grzegorz-grzeda/pstryk/pulls -f title="Release X.Y.Z" -f head=release/X.Y.Z -f base=main \
  -f body="$(printf 'Release X.Y.Z.\n\nAfter merging, tag the merge commit `vX.Y.Z` to publish.\n\n## Release notes\n\n'; cat /tmp/notes.md)" \
  --jq .html_url
```

Wait for the PR's CI to pass, then ask the user to merge it. Merge it yourself only if they ask:
`gh api -X PUT repos/grzegorz-grzeda/pstryk/pulls/<n>/merge -f merge_method=merge`.

## 5. Tag main

After the merge:

```sh
git fetch origin main --tags
git checkout main && git merge --ff-only origin/main
node -p "require('./package.json').version"   # must be X.Y.Z
npm run changelog:check
```

Wait until CI for this `main` commit is green (same API query as in preflight). On `main`, CI also
deploys, if deploys are configured.

## 6. Publish (needs the user's OK)

Tell the user exactly what will happen ("Tag `vX.Y.Z` on <sha>; CI will publish the image and the
GitHub Release"), get a yes, then:

```sh
git tag -a vX.Y.Z -m "Release X.Y.Z"
git push origin vX.Y.Z
```

## 7. Verify

Poll the tag's workflow run (it takes a few minutes; poll in the background rather than with a foreground sleep):

```sh
gh api "repos/grzegorz-grzeda/pstryk/actions/runs?branch=vX.Y.Z&per_page=1" --jq '.workflow_runs[0] | {id, status, conclusion}'
gh api repos/grzegorz-grzeda/pstryk/actions/runs/<id>/jobs --jq '.jobs[] | [.name, .conclusion] | @tsv'
gh api repos/grzegorz-grzeda/pstryk/releases/tags/vX.Y.Z --jq '{html_url, prerelease, name}'
```

Expected: *Lint & test*, *Build image* and *GitHub Release* succeed. *Deploy to VPS* is skipped,
because tags don't deploy.

- If the tag check fails (tag ≠ package.json), steps were skipped. Tell the user, and fix forward
  with the next version. Don't move the tag.
- If image or release creation fails for infrastructure reasons, the user can re-run the workflow
  from GitHub. A re-run is safe because the tag stays the same.

## 8. Report

Report the version, the release URL, the image tags (`ghcr.io/grzegorz-grzeda/pstryk:X.Y.Z`, `:X.Y`),
and whether `main` was deployed. Mention anything noticed along the way, e.g. changelog entries
that were missing.
