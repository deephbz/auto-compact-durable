# Releasing

A release is a version tag on `main`. Pushing the tag runs
[`publish.yml`](../../.github/workflows/publish.yml): it requires the CI gate
for the tagged tree (instant when `main` already passed it), verifies the
package, publishes it to npm with provenance, and creates the GitHub Release.
GitHub Releases are the release history; don't add a root changelog.

1. Merge the change to `main` with green CI. In the same change, bump `version`
   in `package.json` and `package-lock.json`, and add
   `docs/release/v<version>-release-notes.md`. The workflow uses that file as
   the GitHub Release body.
2. Run the privacy gate on the release commit. The pre-push hook runs the same
   scan:
   `git-privacy-scan --ref HEAD --base "$(git config privacy.baseline)" range`.
   Any finding blocks the release. Never print a detected value.
3. Tag and push: `git tag -a v<version> -m v<version>` then
   `git push origin v<version>`.

A version with a prerelease suffix goes to npm `next`; any other version goes
to `latest`. If the workflow fails before `npm publish`, fix the problem,
delete the tag, and tag the fixed commit. If it fails after `npm publish`, the
version is spent: release the next version.

Publication adds no commit. Don't add checklist or receipt files.

If a published version is bad, deprecate it and publish a corrected higher
version. Never retarget a pushed tag of a published version or replace package
bytes.

## The one exception: 0.1.0

npm trusted publishing needs the package to exist first. Version 0.1.0 was
therefore published by hand from a clean checkout of the `v0.1.0` tag, and it
has no npm provenance attestation. Trusted publishing was configured
afterwards. The tag-push workflow run for `v0.1.0` fails at `npm publish`, because
the version was published by hand before trusted publishing existed. Its GitHub
Release was created by hand from the release notes. Every later version publishes from CI with provenance.
